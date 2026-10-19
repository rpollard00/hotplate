import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { InventorySnapshotEvidence } from "../src/resource-domain.js";
import { inventoryResources } from "../src/resource-inventory.js";
import { encodeFilesystemScope } from "../src/filesystem-observer.js";
import { discoverResourceRoots, pathWithin, qualifyResource } from "../src/resource-paths.js";

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

test("inventory rejects nested escaping aliases and never creates authority during traversal", async (t) => {
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
  assert.equal(new Set(files.map((file) => file.canonicalPath)).size, 1);
  assert.equal(qualifyResource({ path: join(external, "guide.md"), cwd: directory, roots: result.roots }), null);
  assert.equal(result.roots.some((entry) => entry.path === join(root, "nested", "external")), false);
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
  const root = join(directory, "skills");
  mkdirSync(root);
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  writeFileSync(join(root, "reference.md"), "body");
  const failure = new Error("storage failed");
  const evidence: InventorySnapshotEvidence[] = [];
  await assert.rejects(inventoryResources({ roots, record: (entry) => {
    evidence.push(entry);
    if (entry.phase === "batch") throw failure;
  } }), (error) => error === failure);
  assert.equal(evidence.some((entry) => entry.phase === "complete"), false);
});

test("physical overlap is traversed once while parent and child snapshots retain membership", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-overlap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "collection");
  const child = join(root, "package");
  mkdirSync(child, { recursive: true });
  for (let index = 0; index < 4; index += 1) writeFileSync(join(child, `${index}.md`), "body");
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: join(directory, "home") }, roots: [root, child] });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, maxEntries: 8, batchSize: 2, record: (entry, descriptor) => {
    assert.equal(entry.rootPath, descriptor.canonicalPath);
    evidence.push(entry);
  } });
  assert.equal(result.scans.length, 2);
  assert.ok(result.scans.every(scan => scan.status === "complete" && scan.resourceCount === 4));
  assert.equal(new Set(evidence.flatMap(entry => entry.resources).map(resource => resource.canonicalPath)).size, 4);
  const limited = await inventoryResources({ roots, maxEntries: 7, record: () => {} });
  assert.ok(limited.scans.every(scan => scan.status === "incomplete" && scan.error === "limit"));
});

test("same-target aliases use one deterministic snapshot and internal links do not change observed paths", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-projection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const target = join(directory, "target");
  mkdirSync(collection, { recursive: true });
  mkdirSync(join(target, "content"), { recursive: true });
  writeFileSync(join(target, "content/guide.md"), "body");
  symlinkSync(join(target, "content"), join(target, "alias"));
  symlinkSync(target, join(target, "content/cycle"));
  symlinkSync(target, join(collection, "z-alias"));
  symlinkSync(target, join(collection, "a-alias"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home } });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots: [...roots].reverse(), record: entry => { evidence.push(entry); } });
  assert.equal(result.roots.filter(root => root.canonicalPath === target).length, 2);
  assert.equal(result.scans.filter(scan => scan.root.canonicalPath === target).length, 1);
  const resources = evidence.filter(entry => entry.rootPath === target).flatMap(entry => entry.resources);
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.observedPath, join(collection, "a-alias/content/guide.md"));
  assert.ok(result.scans.every(scan => scan.status === "complete"));
});

test("inventory prunes infrastructure and provider retirement while preserving artifacts and ownerless files", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-exclusions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, ".claude/skills");
  for (const path of ["README.md", "principles/shared.md", ".artifacts/page.png", "package/.git/config", "package/.jj/state", "package/node_modules/dep/index.js", ".trash/removed/SKILL.md"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "body");
  }
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory } });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, record: entry => { evidence.push(entry); } });
  assert.deepEqual(evidence.flatMap(entry => entry.resources).map(resource => resource.canonicalPath).sort(),
    ["README.md", "principles/shared.md", ".artifacts/page.png"].map(path => join(root, path)).sort());
  assert.ok(result.scans.every(scan => scan.status === "complete"));
});

test("cancellation terminates every started root and retargeted authority cannot report completion", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-cancel-all-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const target = join(directory, "target");
  const replacement = join(directory, "replacement");
  for (const path of [collection, target, replacement]) mkdirSync(path, { recursive: true });
  writeFileSync(join(target, "one.md"), "body");
  writeFileSync(join(target, "two.md"), "body");
  symlinkSync(target, join(collection, "alias"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home } });
  const evidence: InventorySnapshotEvidence[] = [];
  const abort = new AbortController();
  const result = await inventoryResources({ roots, batchSize: 1, signal: abort.signal, record: entry => {
    evidence.push(entry);
    if (entry.phase === "batch") abort.abort();
  } });
  assert.equal(evidence.filter(entry => entry.phase === "started").length, evidence.filter(entry => entry.phase === "incomplete").length);
  assert.ok(result.scans.every(scan => scan.status === "incomplete" && scan.error === "cancelled"));
  rmSync(join(collection, "alias"));
  symlinkSync(replacement, join(collection, "alias"));
  const changed = await inventoryResources({ roots, record: () => {} });
  assert.ok(changed.scans.some(scan => scan.root.canonicalPath === target && scan.status === "incomplete"));
});

test("device boundaries add validated observation roots without new inventory memberships", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-mounts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const root = join(directory, "content");
  const mounted = join(root, "mounted");
  const vendor = join(mounted, "vendor");
  const fileMount = join(root, "mounted-file.md");
  const external = join(directory, "external");
  for (const path of [join(home, ".claude"), join(vendor, ".trash"), join(mounted, "node_modules/dep"), external]) mkdirSync(path, { recursive: true });
  for (const path of [join(root, "SKILL.md"), join(mounted, "guide.md"), join(vendor, "keep.md"), join(vendor, ".trash/removed.md"), join(mounted, "node_modules/dep/secret.md"), fileMount, join(external, "outside.md")]) writeFileSync(path, "fixture");
  symlinkSync(vendor, join(home, ".claude/skills"));
  symlinkSync(external, join(mounted, "escape"));
  symlinkSync(mounted, join(root, "internal-alias"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, roots: [root] });
  const originalStat = fs.promises.stat;
  const sampled = new Map<string, number>();
  t.mock.method(fs.promises, "stat", async (path: Parameters<typeof fs.promises.stat>[0]) => {
    const metadata = await originalStat(path);
    const canonical = realpathSync(path);
    sampled.set(canonical, (sampled.get(canonical) ?? 0) + 1);
    const device = metadata.dev + (canonical === fileMount ? 2 : pathWithin(canonical, mounted) ? 1 : 0);
    Object.defineProperty(metadata, "dev", { value: device });
    return metadata;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, record: entry => { evidence.push(entry); } });
  const mountRoot = result.observationRoots.find(candidate => candidate.canonicalPath === mounted);
  const fileRoot = result.observationRoots.find(candidate => candidate.canonicalPath === fileMount);
  assert.ok(mountRoot);
  assert.ok(fileRoot);
  assert.equal(fileRoot.admission.extent, "file");
  assert.deepEqual(mountRoot.admission.exclusions.segments, [".git", ".jj", "node_modules"]);
  assert.deepEqual(mountRoot.admission.exclusions.prefixes, ["vendor/.trash"]);
  assert.equal(result.scans.length, new Set(roots.map(candidate => candidate.canonicalPath)).size);
  assert.ok(result.scans.every(scan => scan.status === "complete"));
  assert.equal(evidence.some(entry => entry.rootPath === mounted || entry.rootPath === fileMount), false);
  assert.ok([...sampled.values()].every(count => count === 1));
  assert.equal(sampled.has(join(vendor, ".trash")), false);
  assert.equal(sampled.has(join(mounted, "node_modules")), false);
  assert.equal(result.observationRoots.some(candidate => candidate.canonicalPath === external), false);
  const resource = qualifyResource({ path: join(mounted, "guide.md"), cwd: directory, roots: result.observationRoots });
  assert.equal(resource?.rootPath, root);
  assert.equal(resource?.ownerSkillPath, join(root, "SKILL.md"));
  assert.equal(qualifyResource({ path: fileMount, cwd: directory, roots: [fileRoot] })?.rootPath, root);
  assert.equal(qualifyResource({ path: join(vendor, ".trash/removed.md"), cwd: directory, roots: [mountRoot] }), null);
  const policy = encodeFilesystemScope(result.observationRoots).toString("utf8");
  assert.ok(policy.includes(`root\0directory\0${mounted}\0`));
  assert.ok(policy.includes(`root\0file\0${fileMount}\0`));
  assert.ok(policy.includes("prefix\0vendor/.trash\0"));
  assert.equal(result.roots, roots);
  const repeated = await inventoryResources({ roots: result.roots, record: () => {} });
  assert.deepEqual(repeated.scans.map(scan => scan.root.canonicalPath), result.scans.map(scan => scan.root.canonicalPath));
});

test("source failure during mount derivation makes inventory incomplete and invalidates observation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-mount-retarget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const source = join(directory, "source");
  const mounted = join(source, "mounted");
  const replacement = join(directory, "replacement");
  for (const path of [collection, mounted, replacement]) mkdirSync(path, { recursive: true });
  writeFileSync(join(mounted, "guide.md"), "fixture");
  const alias = join(collection, "installed");
  symlinkSync(source, alias);
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home } });
  const originalStat = fs.promises.stat;
  let retargeted = false;
  t.mock.method(fs.promises, "stat", async (path: Parameters<typeof fs.promises.stat>[0]) => {
    const metadata = await originalStat(path);
    if (String(path) === join(alias, "mounted") && !retargeted) {
      retargeted = true;
      rmSync(alias);
      symlinkSync(replacement, alias);
      symlinkSync(mounted, join(replacement, "mounted"));
      Object.defineProperty(metadata, "dev", { value: metadata.dev + 1 });
    }
    return metadata;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const evidence: InventorySnapshotEvidence[] = [];
  const result = await inventoryResources({ roots, record: entry => { evidence.push(entry); } });
  assert.equal(retargeted, true);
  assert.ok(result.scans.some(scan => scan.root.canonicalPath === source && scan.status === "incomplete" && scan.error === "io-error"));
  assert.equal(evidence.some(entry => entry.rootPath === source && entry.phase === "complete"), false);
  assert.equal(result.observationRoots.some(candidate => candidate.canonicalPath === mounted), false);
  assert.equal(qualifyResource({ path: join(mounted, "guide.md"), cwd: directory, roots: result.observationRoots }), null);
  assert.throws(() => encodeFilesystemScope(result.observationRoots), /no longer admitted/u);
});
