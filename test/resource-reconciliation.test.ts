import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InventorySnapshotEvidence } from "../src/resource-domain.js";
import { discoverResourceRoots } from "../src/resource-paths.js";
import { createResourceReconciler } from "../src/resource-reconciliation.js";

test("continuous inventory persists changes and failure transitions without repeating unchanged file lists", async t => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-reconcile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "content");
  mkdirSync(root);
  writeFileSync(join(root, "one.md"), "one");
  const roots = discoverResourceRoots({ cwd: directory, roots: [root], env: { HOME: directory } });
  const events: InventorySnapshotEvidence[] = [];
  const reconciler = createResourceReconciler(async event => { events.push(event); });
  const signal = new AbortController().signal;
  await reconciler.scan(roots, signal);
  assert.equal(events.filter(event => event.phase === "complete").length, 1);
  const first = events.length;
  await reconciler.scan(roots, signal);
  assert.equal(events.length, first);
  writeFileSync(join(root, "two.md"), "two");
  await reconciler.scan(roots, signal);
  assert.equal(events.filter(event => event.phase === "complete").length, 2);
  rmSync(root, { recursive: true });
  await reconciler.scan(roots, signal);
  assert.equal(events.at(-1)?.phase, "incomplete");
  const failed = events.length;
  await reconciler.scan(roots, signal);
  assert.equal(events.length, failed);
  mkdirSync(root);
  writeFileSync(join(root, "two.md"), "two");
  await reconciler.scan(roots, signal);
  assert.equal(events.at(-1)?.phase, "complete");
});

test("inventories above 8 MiB suppress unchanged evidence and publish complete changed snapshots", { timeout: 30000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hotplate-reconcile-large-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, ...Array.from({ length: 4 }, (_, index) => `home-${index}-${"h".repeat(200)}`));
  const root = join(home, ".agents", "skills");
  const skill = join(root, "inventory-fixture");
  const references = join(skill, "references");
  const skillFile = join(skill, "SKILL.md");
  mkdirSync(references, { recursive: true });
  writeFileSync(skillFile, "---\nname: inventory-fixture\ndescription: Inventory regression fixture.\n---\n");
  const pathDigest = (path: string): string => createHash("sha256").update(path).digest("hex");
  const expectedResources = new Set([pathDigest(skillFile)]);
  for (let index = 0; index < 2304; index += 1) {
    const path = join(references, `reference-${String(index).padStart(4, "0")}-${"r".repeat(140)}.md`);
    writeFileSync(path, "");
    expectedResources.add(pathDigest(path));
  }
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home } });
  assert.deepEqual(roots.map(entry => entry.canonicalPath), [root]);
  const recorded = { events: 0, bytes: 0, completeSnapshots: 0 };
  let active: { scanId: string; batchCount: number; resourceDigests: Set<string> } | null = null;
  const reconciler = createResourceReconciler(async event => {
    recorded.events += 1;
    recorded.bytes += Buffer.byteLength(JSON.stringify(event));
    assert.equal(event.rootPath, root);
    switch (event.phase) {
      case "started":
        assert.equal(active, null);
        active = { scanId: event.scanId, batchCount: 0, resourceDigests: new Set() };
        break;
      case "batch":
        assert.ok(active);
        assert.equal(event.scanId, active.scanId);
        assert.equal(event.batchIndex, active.batchCount);
        active.batchCount += 1;
        for (const resource of event.resources) {
          assert.equal(resource.rootPath, root);
          assert.equal(resource.ownerSkillPath, skillFile);
          assert.equal(resource.canonicalPath, resource.observedPath);
          const digest = pathDigest(resource.canonicalPath);
          assert.ok(expectedResources.has(digest));
          assert.equal(active.resourceDigests.has(digest), false);
          active.resourceDigests.add(digest);
        }
        break;
      case "complete":
        assert.ok(active);
        assert.equal(event.scanId, active.scanId);
        assert.equal(event.batchCount, active.batchCount);
        assert.deepEqual(active.resourceDigests, expectedResources);
        recorded.completeSnapshots += 1;
        active = null;
        break;
      case "incomplete":
        assert.fail(`Unexpected incomplete inventory: ${event.error}`);
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  });
  const signal = new AbortController().signal;
  await reconciler.scan(roots, signal);
  assert.equal(active, null);
  assert.equal(recorded.completeSnapshots, 1);
  assert.ok(recorded.bytes > 8 * 1024 * 1024, `Expected more than 8 MiB of evidence, received ${recorded.bytes} bytes.`);
  t.diagnostic(`First inventory published ${recorded.bytes} bytes for ${expectedResources.size} resources.`);
  const first = { ...recorded };
  await reconciler.scan(roots, signal);
  assert.deepEqual(recorded, first, "An unchanged large inventory must not publish any new evidence.");
  const added = join(references, "added-reference.md");
  writeFileSync(added, "");
  expectedResources.add(pathDigest(added));
  await reconciler.scan(roots, signal);
  assert.equal(active, null);
  assert.equal(recorded.completeSnapshots, 2);
  assert.ok(recorded.events > first.events);
});
