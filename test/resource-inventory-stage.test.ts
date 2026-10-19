import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { InventorySnapshotEvidence, ResourceLocation } from "../src/resource-domain.js";
import { createInventoryStage } from "../src/resource-inventory-stage.js";

test("staged digests ignore enumeration order, batch boundaries and scan IDs while replay preserves frames", t => {
  const parent = stageParent(t);
  const first = resource("/content", "first.md");
  const second = resource("/content", "second.md");
  const original = frames("/content", "first-scan", [[first, second]]);
  const reordered = frames("/content", "second-scan", [[second], [first]]);
  const a = createInventoryStage({ stagingDirectory: parent });
  const b = createInventoryStage({ stagingDirectory: parent });
  try {
    for (const frame of original) a.append(frame);
    for (const frame of reordered) b.append(frame);
    const one = [...a.snapshots()];
    const two = [...b.snapshots()];
    assert.equal(one.length, 1);
    assert.equal(two.length, 1);
    assert.deepEqual(one[0]?.digest, two[0]?.digest);
    assert.deepEqual(one.flatMap(snapshot => [...snapshot.frames()]), original);
    assert.deepEqual(two.flatMap(snapshot => [...snapshot.frames()]), reordered);
  } finally {
    a.close();
    b.close();
  }
  assert.deepEqual(readdirSync(parent), []);
});

test("the stage separates interleaved snapshots and hashes metadata and failure transitions", t => {
  const stage = createInventoryStage({ stagingDirectory: stageParent(t) });
  try {
    const a = frames("/first", "first-scan", [[resource("/first", "a.md")]]);
    const b = frames("/second", "second-scan", [[resource("/second", "b.md")]]);
    for (let index = 0; index < a.length; index += 1) {
      const first = a[index];
      const second = b[index];
      assert.ok(first);
      assert.ok(second);
      stage.append(first);
      stage.append(second);
    }
    assert.deepEqual([...stage.snapshots()].map(snapshot => [...snapshot.frames()]), [a, b]);
  } finally { stage.close(); }

  const variants: InventorySnapshotEvidence[][] = [
    frames("/content", "one", [[resource("/content", "a.md")]]),
    frames("/content", "two", [[{ ...resource("/content", "a.md"), kind: "reference" }]]),
    frames("/content", "three", [[resource("/content", "a.md")]]).map(frame => ({ ...frame, scope: "session" })),
    frames("/content", "four", [[resource("/content", "a.md")]]).map(frame => frame.phase === "complete"
      ? { ...frame, phase: "incomplete", error: "missing" } : frame),
  ];
  const digests = variants.map(variant => {
    const current = createInventoryStage({ stagingDirectory: stageParent(t) });
    try {
      for (const frame of variant) current.append(frame);
      return [...current.snapshots()][0]?.digest.sha256;
    } finally { current.close(); }
  });
  assert.equal(new Set(digests).size, variants.length);
});

test("the stage has private permissions and enforces its disk budget without extra files", t => {
  const parent = stageParent(t);
  const limit = 64 * 1024;
  const stage = createInventoryStage({ stagingDirectory: parent, maxStagedBytes: limit });
  try {
    const name = readdirSync(parent)[0];
    assert.ok(name);
    const directory = join(parent, name);
    const path = join(directory, "stage.sqlite");
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const started = frames("/content", "limited", [])[0];
    if (started?.phase !== "started") assert.fail("Expected a started frame.");
    stage.append(started);
    assert.throws(() => {
      for (let index = 0; index < 1000; index += 1) {
        stage.append({ ...started, phase: "batch", batchIndex: index, resources: [resource("/content", `${index}-${"x".repeat(500)}.md`)] });
      }
    }, /byte limit|database or disk is full/);
    assert.ok(statSync(path).size <= limit);
    assert.deepEqual(readdirSync(directory), ["stage.sqlite"]);
  } finally { stage.close(); }
  assert.deepEqual(readdirSync(parent), []);
});

test("the stage removes initialization failures and rejects oversized or unfinished frames", t => {
  const parent = stageParent(t);
  assert.throws(() => createInventoryStage({ stagingDirectory: parent, maxStagedBytes: 4096 }), /database or disk is full/);
  assert.deepEqual(readdirSync(parent), []);
  const stage = createInventoryStage({ stagingDirectory: parent });
  try {
    const started = frames("/content", "oversized", [])[0];
    if (started?.phase !== "started") assert.fail("Expected a started frame.");
    stage.append(started);
    const resources = Array.from({ length: 512 }, (_, index) => resource("/content", `${index}-${"x".repeat(1200)}.md`));
    assert.throws(() => stage.append({ ...started, phase: "batch", batchIndex: 0, resources }), /frame exceeds the byte limit/);
    assert.throws(() => [...stage.snapshots()], /unfinished snapshot/);
  } finally { stage.close(); }
  assert.deepEqual(readdirSync(parent), []);
});

function stageParent(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-inventory-stage-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function resource(rootPath: string, name: string): ResourceLocation {
  return {
    filesystemId: "test-filesystem", rootPath,
    canonicalPath: join(rootPath, name), observedPath: join(rootPath, name),
    kind: "file", ownerSkillPath: null,
  };
}

function frames(rootPath: string, scanId: string, batches: readonly (readonly ResourceLocation[])[]): InventorySnapshotEvidence[] {
  const common = {
    kind: "inventory-snapshot", scanId, filesystemId: "test-filesystem", rootPath, origin: "configured", scope: "account",
  } satisfies Pick<InventorySnapshotEvidence, "kind" | "scanId" | "filesystemId" | "rootPath" | "origin" | "scope">;
  return [
    { ...common, phase: "started", resources: [], error: null },
    ...batches.map((resources, batchIndex): InventorySnapshotEvidence => ({ ...common, phase: "batch", resources, batchIndex, error: null })),
    { ...common, phase: "complete", resources: [], batchCount: batches.length, error: null },
  ];
}
