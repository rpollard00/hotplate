import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
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

const failurePhases: readonly InventorySnapshotEvidence["phase"][] = ["started", "batch", "complete"];
for (const failurePhase of failurePhases) {
  test(`a failed ${failurePhase} callback forces publication after files return to the prior inventory`, async t => {
    const fixture = reconciliationFixture(t);
    const events: InventorySnapshotEvidence[] = [];
    let fail = false;
    const reconciler = createResourceReconciler(async event => {
      events.push(event);
      if (fail && event.phase === failurePhase) throw new Error("Recorder failed.");
    }, { stagingDirectory: fixture.stagingDirectory });
    const signal = new AbortController().signal;
    await reconciler.scan(fixture.roots, signal);
    const originalScan = events[0]?.scanId;
    writeFileSync(join(fixture.root, "two.md"), "two");
    fail = true;
    await assert.rejects(reconciler.scan(fixture.roots, signal), /Recorder failed/);
    assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
    rmSync(join(fixture.root, "two.md"));
    fail = false;
    events.length = 0;
    await reconciler.scan(fixture.roots, signal);
    assert.deepEqual(events.map(event => event.phase), ["started", "batch", "complete"]);
    assert.notEqual(events[0]?.scanId, originalScan);
    assert.deepEqual(events.flatMap(event => event.resources.map(resource => resource.canonicalPath)), [join(fixture.root, "one.md")]);
    await reconciler.scan(fixture.roots, signal);
    assert.equal(events.length, 3);
    assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
  });
}

test("a published root survives a later root failure, and removed roots publish when they return", async t => {
  const fixture = reconciliationFixture(t);
  const second = join(fixture.directory, "second");
  mkdirSync(second);
  writeFileSync(join(second, "one.md"), "one");
  const roots = discoverResourceRoots({ cwd: fixture.directory, roots: [fixture.root, second], env: { HOME: fixture.directory } });
  const events: InventorySnapshotEvidence[] = [];
  let fail = false;
  const reconciler = createResourceReconciler(async event => {
    events.push(event);
    if (fail && event.rootPath === second && event.phase === "batch") throw new Error("Second root failed.");
  }, { stagingDirectory: fixture.stagingDirectory });
  const signal = new AbortController().signal;
  await reconciler.scan(roots, signal);
  writeFileSync(join(fixture.root, "two.md"), "two");
  writeFileSync(join(second, "two.md"), "two");
  fail = true;
  events.length = 0;
  await assert.rejects(reconciler.scan(roots, signal), /Second root failed/);
  assert.equal(events.some(event => event.rootPath === fixture.root && event.phase === "complete"), true);
  fail = false;
  events.length = 0;
  await reconciler.scan(roots, signal);
  assert.deepEqual(new Set(events.map(event => event.rootPath)), new Set([second]));
  assert.equal(events.at(-1)?.phase, "complete");
  await reconciler.scan(fixture.roots, signal);
  events.length = 0;
  await reconciler.scan(roots, signal);
  assert.deepEqual(new Set(events.map(event => event.rootPath)), new Set([second]));
  assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
});

test("staging allocation failures and disk limits publish no frames and preserve the baseline", async t => {
  const fixture = reconciliationFixture(t);
  const events: InventorySnapshotEvidence[] = [];
  const reconciler = createResourceReconciler(async event => { events.push(event); }, {
    stagingDirectory: fixture.stagingDirectory, maxStagedBytes: 64 * 1024,
  });
  const signal = new AbortController().signal;
  await reconciler.scan(fixture.roots, signal);
  const baselineCount = events.length;
  rmSync(fixture.stagingDirectory, { recursive: true });
  await assert.rejects(reconciler.scan(fixture.roots, signal), { code: "ENOENT" });
  mkdirSync(fixture.stagingDirectory);
  await reconciler.scan(fixture.roots, signal);
  assert.equal(events.length, baselineCount);
  const extra = join(fixture.root, "extra");
  mkdirSync(extra);
  for (let index = 0; index < 300; index += 1) writeFileSync(join(extra, `reference-${index}-${"r".repeat(80)}.md`), "");
  await assert.rejects(reconciler.scan(fixture.roots, signal), /byte limit|database or disk is full/);
  assert.equal(events.length, baselineCount);
  assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
  rmSync(extra, { recursive: true });
  await reconciler.scan(fixture.roots, signal);
  assert.equal(events.length, baselineCount);
  writeFileSync(join(fixture.root, "two.md"), "two");
  await reconciler.scan(fixture.roots, signal);
  assert.equal(events.at(-1)?.phase, "complete");
  assert.ok(events.length > baselineCount);
});

test("cancellation during inventory removes the stage without publishing a complete snapshot", async t => {
  const fixture = reconciliationFixture(t);
  for (let index = 0; index < 130; index += 1) writeFileSync(join(fixture.root, `${index}.md`), "");
  const events: InventorySnapshotEvidence[] = [];
  const reconciler = createResourceReconciler(async event => { events.push(event); }, { stagingDirectory: fixture.stagingDirectory });
  const controller = new AbortController();
  let stagedDirectories = 0;
  const cancellation = new Error("Cancelled during staging.");
  setImmediate(() => {
    stagedDirectories = readdirSync(fixture.stagingDirectory).length;
    controller.abort(cancellation);
  });
  await assert.rejects(reconciler.scan(fixture.roots, controller.signal), cancellation);
  assert.equal(stagedDirectories, 1);
  assert.equal(events.length, 0);
  assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
  await reconciler.scan(fixture.roots, new AbortController().signal);
  assert.equal(events.at(-1)?.phase, "complete");
});

test("cancellation during replay closes the partial chain and retries a reverted inventory", async t => {
  const fixture = reconciliationFixture(t);
  const events: InventorySnapshotEvidence[] = [];
  const controller = new AbortController();
  let cancel = false;
  const reconciler = createResourceReconciler(async event => {
    events.push(event);
    if (cancel && event.phase === "batch") controller.abort(new Error("Cancelled during replay."));
  }, { stagingDirectory: fixture.stagingDirectory });
  await reconciler.scan(fixture.roots, new AbortController().signal);
  writeFileSync(join(fixture.root, "two.md"), "two");
  events.length = 0;
  cancel = true;
  await assert.rejects(reconciler.scan(fixture.roots, controller.signal), /Cancelled during replay/);
  assert.deepEqual(events.map(event => event.phase), ["started", "batch", "incomplete"]);
  const terminal = events.at(-1);
  assert.equal(terminal?.phase, "incomplete");
  if (terminal?.phase !== "incomplete") assert.fail("Expected a cancelled terminal.");
  assert.equal(terminal.error, "cancelled");
  assert.equal(terminal.batchCount, 1);
  assert.equal(new Set(events.map(event => event.scanId)).size, 1);
  assert.deepEqual(readdirSync(fixture.stagingDirectory), []);
  cancel = false;
  rmSync(join(fixture.root, "two.md"));
  events.length = 0;
  await reconciler.scan(fixture.roots, new AbortController().signal);
  assert.deepEqual(events.map(event => event.phase), ["started", "batch", "complete"]);
  await reconciler.scan(fixture.roots, new AbortController().signal);
  assert.equal(events.length, 3);
});

function reconciliationFixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hotplate-reconcile-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "content");
  const stagingDirectory = join(directory, "staging");
  mkdirSync(root);
  mkdirSync(stagingDirectory);
  writeFileSync(join(root, "one.md"), "one");
  const roots = discoverResourceRoots({ cwd: directory, roots: [root], env: { HOME: directory } });
  return { directory, root, roots, stagingDirectory };
}
