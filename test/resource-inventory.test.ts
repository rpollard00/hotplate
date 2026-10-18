import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { InventorySnapshotEvidence } from "../src/resource-domain.js";
import { inventoryResources } from "../src/resource-inventory.js";
import { discoverResourceRoots, qualifyResource } from "../src/resource-paths.js";

test("inventory enumerates hidden and unindexed files in bounded batches without content reads", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "generic-content");
  const paths = ["notes.md", "references/guide.md", ".private/receipt.txt", "scripts/check.sh", "image.png"];
  for (const path of paths) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "Not a skill document.");
    chmodSync(absolute, 0o000);
  }
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, batchSize: 2, record: async (entry) => { evidence.push(entry); } });
  assert.equal(result.scans[0]?.status, "complete");
  assert.equal(result.scans[0]?.resourceCount, 5);
  assert.equal(result.scans[0]?.batchCount, 3);
  assert.deepEqual(evidence.map((entry) => entry.phase), ["started", "batch", "batch", "batch", "complete"]);
  const files = evidence.flatMap((entry) => entry.resources);
  assert.deepEqual(files.map((file) => file.canonicalPath).sort(), paths.map((path) => join(root, path)).sort());
  assert.ok(files.every((file) => file.ownerSkillPath === null));
  assert.ok(evidence.every((entry) => entry.kind === "inventory-snapshot"));
  const again: InventorySnapshotEvidence[] = [];
  rmSync(join(root, "notes.md"));
  await inventoryResources({ roots, record: (entry) => { again.push(entry); } });
  assert.equal(again.flatMap((entry) => entry.resources).length, 4);
  assert.notEqual(again[0]?.scanId, evidence[0]?.scanId);
});

test("inventory resolves nested directory aliases, terminates cycles, and preserves copied resources", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "skills");
  const external = join(directory, "external");
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(external);
  writeFileSync(join(external, "guide.md"), "same bytes");
  writeFileSync(join(root, "copy.md"), "same bytes");
  symlinkSync(external, join(root, "nested", "external"), "dir");
  symlinkSync(root, join(external, "cycle"), "dir");
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  assert.equal(qualifyResource({ path: join(external, "guide.md"), cwd: directory, roots }), null);
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, record: (entry) => { evidence.push(entry); } });
  assert.equal(result.scans[0]?.status, "complete");
  const files = evidence.flatMap((entry) => entry.resources);
  assert.equal(new Set(files.map((file) => file.canonicalPath)).size, 2);
  assert.equal(qualifyResource({ path: join(external, "guide.md"), cwd: directory, roots: result.roots })?.canonicalPath, join(external, "guide.md"));
  assert.ok(result.roots.some((entry) => entry.path === join(root, "nested", "external") && entry.canonicalPath === external));
});

test("external file symlinks gain an exact physical root and matching inventory membership", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-file-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "skills");
  const target = join(directory, "principle.md");
  mkdirSync(root);
  writeFileSync(target, "body");
  symlinkSync(target, join(root, "reference.md"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, record: (entry) => { evidence.push(entry); } });
  const physical = qualifyResource({ path: target, cwd: directory, roots: result.roots });
  assert.equal(physical?.canonicalPath, target);
  assert.equal(physical?.rootPath, target);
  assert.ok(evidence.some((entry) => entry.phase === "batch" && entry.rootPath === target && entry.resources[0]?.canonicalPath === target));
  assert.ok(result.scans.every((scan) => scan.status === "complete"));
});

test("missing roots, scan limits, and cancellation produce incomplete snapshots", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-incomplete-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "root");
  mkdirSync(root);
  writeFileSync(join(root, "one.md"), "one");
  writeFileSync(join(root, "two.md"), "two");
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  const limited: InventorySnapshotEvidence[] = [];
  const limitedResult = await inventoryResources({ roots, maxEntries: 1, record: (entry) => { limited.push(entry); } });
  assert.equal(limitedResult.scans[0]?.status, "incomplete");
  assert.equal(limited.at(-1)?.error, "limit");
  assert.equal(limited.some((entry) => entry.phase === "complete"), false);
  const missing = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [join(directory, "missing")] });
  const absent: InventorySnapshotEvidence[] = [];
  await inventoryResources({ roots: missing, record: (entry) => { absent.push(entry); } });
  assert.equal(absent.at(-1)?.error, "missing");
  const cancelled: InventorySnapshotEvidence[] = [];
  await inventoryResources({ roots, signal: AbortSignal.abort(), record: (entry) => { cancelled.push(entry); } });
  assert.deepEqual(cancelled.map((entry) => entry.phase), ["started", "incomplete"]);
  assert.equal(cancelled.at(-1)?.error, "cancelled");
});

test("unreadable directories cannot produce a complete inventory", async (t) => {
  if (process.getuid?.() === 0) return t.skip("Root bypasses file permissions.");
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-permissions-"));
  const root = join(directory, "root");
  mkdirSync(root);
  writeFileSync(join(root, "hidden.md"), "body");
  chmodSync(root, 0o000);
  t.after(() => { chmodSync(root, 0o700); rmSync(directory, { recursive: true, force: true }); });
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  const evidence: InventorySnapshotEvidence[] = [];
  await inventoryResources({ roots, record: (entry) => { evidence.push(entry); } });
  assert.equal(evidence.at(-1)?.error, "unreadable");
  assert.equal(evidence.some((entry) => entry.phase === "complete"), false);
});

test("recording failures propagate without manufacturing a completed scan", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [directory] });
  writeFileSync(join(directory, "reference.md"), "body");
  const failure = new Error("storage failed");
  const evidence: InventorySnapshotEvidence[] = [];
  await assert.rejects(inventoryResources({ roots, record: (entry) => {
    evidence.push(entry);
    if (entry.phase === "batch") throw failure;
  } }), (error) => error === failure);
  assert.equal(evidence.some((entry) => entry.phase === "complete"), false);
});
