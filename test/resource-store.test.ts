import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Observation } from "../src/domain.js";
import type { InventorySnapshotEvidence, ResourceAccessEvidence, ResourceEvidence, ResourceLocation } from "../src/resource-domain.js";
import { isResourceEvidence, parseCollectorOrigin, parseMachineId, parseSourceId } from "../src/observation.js";
import { openAggregateStore, openCaptureStore, openHotplateReadStore, openHotplateStore, openRelayStore } from "../src/store.js";

const root = "/skills";
const filesystemId = "linux:host-a:mount-1";
const at = (second: number) => `2026-10-18T00:00:${String(second).padStart(2, "0")}.000Z`;
function location(name: string, overrides: Partial<ResourceLocation> = {}): ResourceLocation {
  return { filesystemId, canonicalPath: `${root}/${name}`, observedPath: `${root}/${name}`, rootPath: root, kind: "reference", ownerSkillPath: null, ...overrides };
}
function observation(id: string, evidence: ResourceEvidence, second = 0): Observation {
  return { id, producerId: id, sequence: 0, observedAt: at(second), host: "codex",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null }, evidence };
}
function access(resource: ResourceLocation, overrides: Partial<ResourceAccessEvidence> = {}): ResourceAccessEvidence {
  const evidence = { kind: "resource-access", resource, operationId: "tool-operation", mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session", ...overrides };
  assert.ok(isResourceEvidence(evidence) && evidence.kind === "resource-access");
  return evidence;
}
function scan(scanId: string, phase: "started" | "complete" | "incomplete", second: number, batchCount = 0): Observation {
  const base = { kind: "inventory-snapshot", scanId, filesystemId, rootPath: root, origin: "configured", scope: "project" } satisfies Partial<InventorySnapshotEvidence>;
  if (phase === "started") return observation(`${scanId}-start`, { ...base, phase, resources: [], error: null }, second);
  if (phase === "incomplete") return observation(`${scanId}-incomplete`, { ...base, phase, resources: [], error: "unreadable", batchCount }, second);
  return observation(`${scanId}-complete`, { ...base, phase, resources: [], error: null, batchCount }, second);
}
function batch(scanId: string, resources: readonly ResourceLocation[], second: number, batchIndex = 0): Observation {
  return observation(`${scanId}-batch-${batchIndex}`, { kind: "inventory-snapshot", scanId, filesystemId, rootPath: root, origin: "configured", scope: "project", phase: "batch", resources, error: null, batchIndex }, second);
}
function coverage(id: string, second: number, status: "active" | "stopped" | "overflow" = "active", mechanism: "fanotify" | "host-tool" = "fanotify"): Observation {
  const base = { kind: "observer-coverage", observerId: "observer", mechanism, filesystemId, rootPaths: [root], heartbeatMs: 1000 } as const;
  return observation(id, status === "overflow" ? { ...base, status, reason: "queue-overflow" } : { ...base, status, reason: null }, second);
}

test("resource access needs no inventory, owner, Explorer metadata, or session", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const first = observation("first", access(location("reference.md")));
    const second = observation("second", access(location("principle.md")));
    second.scope.sessionId = null;
    second.host = "unknown";
    assert.deepEqual(await store.record([first, second, first]), { accepted: 2, duplicate: 1, dropped: 0 });
    const rows = (await store.queryResources({})).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.successfulReadCount === 1 && row.firstInventoriedAt === null && row.presence === "unknown"));
    assert.equal((await store.querySkillTable({})).rows.length, 0);
    assert.equal((await store.queryOverview({})).successfulReadCount, 0);
  } finally { await store.close(); }
});

test("resource identity ignores root order and aliases, while copies and filesystems remain separate", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const canonical = location("nested/reference.md");
    await store.record([
      observation("one", access(canonical)),
      observation("alias", access({ ...canonical, rootPath: "/skills/nested", observedPath: "/linked/reference.md" }), 1),
      observation("copy", access(location("copy/reference.md")), 2),
      observation("other-filesystem", access({ ...canonical, filesystemId: "other-host" }), 3),
    ]);
    const rows = (await store.queryResources({})).rows;
    assert.equal(rows.length, 3);
    const original = rows.find(row => row.resource.canonicalPath === canonical.canonicalPath && row.resource.filesystemId === filesystemId);
    assert.ok(original);
    assert.equal(original.successfulReadCount, 2);
    assert.deepEqual(original.rootPaths, ["/skills", "/skills/nested"]);
    assert.equal(original.resource.observedPath, "/linked/reference.md");
  } finally { await store.close(); }
});

test("inventory marks absence only after every batch of a completed scan arrives", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([scan("old", "started", 0), batch("old", [location("old.md")], 1), scan("old", "complete", 2, 1)]);
    await store.record([scan("partial", "started", 3), scan("partial", "incomplete", 4)]);
    assert.equal((await store.queryResources({})).rows[0]?.presence, "unknown");
    await store.record([scan("new", "complete", 7, 1), scan("new", "started", 5)]);
    assert.equal((await store.queryResources({})).rows[0]?.presence, "unknown");
    await store.record(batch("new", [location("new.md")], 6));
    const rows = (await store.queryResources({})).rows;
    assert.equal(rows.find(row => row.resource.canonicalPath.endsWith("old.md"))?.presence, "absent");
    assert.equal(rows.find(row => row.resource.canonicalPath.endsWith("new.md"))?.presence, "present");
    assert.equal((await store.queryResources({ toObservedAt: at(4) })).rows[0]?.presence, "unknown");
    assert.ok(rows.every(row => row.observation === "unknown"));
  } finally { await store.close(); }
});

test("unused reporting requires an inventoried file and a confirmed filesystem coverage interval", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([coverage("start", 0), scan("scan", "started", 0), batch("scan", [location("unused.md")], 1), scan("scan", "complete", 1, 1), coverage("heartbeat", 2), coverage("stop", 3, "stopped")]);
    const row = (await store.queryResources({ fromObservedAt: at(0), toObservedAt: at(2) })).rows[0];
    assert.ok(row);
    assert.equal(row.observation, "not-observed");
    assert.equal(row.coverageFrom, at(1));
    assert.equal(row.coverageTo, at(2));
    assert.equal((await store.queryResources({ fromObservedAt: at(0), toObservedAt: at(3) })).rows[0]?.observation, "unknown");
    assert.equal((await store.queryResources({})).rows[0]?.observation, "unknown");
    assert.equal((await store.queryResources({ fromObservedAt: at(0), toObservedAt: at(4) })).rows[0]?.observation, "unknown");
    await store.record(observation("unattributed", access(location("unused.md"), { mechanism: "fanotify", access: "open", outcome: "unknown", attribution: "unknown" }), 2));
    const uncertain = (await store.queryResources({ toObservedAt: at(2) })).rows[0];
    assert.equal(uncertain?.observation, "unknown");
    assert.equal(uncertain?.openCount, 1);
    assert.equal(uncertain?.unattributedAccessCount, 1);
  } finally { await store.close(); }
});

test("host-tool coverage, overflows, and stale heartbeats cannot establish zero access", async () => {
  for (const mechanism of ["host-tool", "fanotify"] as const) {
    const store = openHotplateStore({ databasePath: ":memory:" });
    try {
      await store.record([scan("scan", "started", 0), batch("scan", [location("unused.md")], 1), scan("scan", "complete", 1, 1), coverage("start", 0, "active", mechanism), coverage("heartbeat", 2, "active", mechanism), coverage("overflow", 3, "overflow", mechanism), coverage("resume", 4, "active", mechanism), coverage("later", 5, "active", mechanism)]);
      assert.equal((await store.queryResources({ fromObservedAt: at(1), toObservedAt: at(5) })).rows[0]?.observation, "unknown");
      assert.equal((await store.queryResourceCoverage({ toObservedAt: at(9) })).rows[0]?.status, "stale");
    } finally { await store.close(); }
  }
});

test("inventory before watcher startup yields a bounded covered period", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([scan("scan", "started", 0), batch("scan", [location("unused.md")], 1), scan("scan", "complete", 1, 1), coverage("start", 3), coverage("heartbeat", 4), coverage("stop", 5, "stopped")]);
    const row = (await store.queryResources({ toObservedAt: at(4) })).rows[0];
    assert.equal(row?.observation, "not-observed");
    assert.equal(row?.coverageFrom, at(3));
    assert.equal(row?.coverageTo, at(4));
    assert.equal((await store.queryResources({ toObservedAt: at(5) })).rows[0]?.observation, "unknown");
    assert.equal((await store.queryResources({ fromObservedAt: at(1), toObservedAt: at(5) })).rows[0]?.observation, "unknown");
  } finally { await store.close(); }
});

test("a later heartbeat confirms a historical boundary without including later access or inventory", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([scan("scan", "started", 0), batch("scan", [location("unused.md")], 1), scan("scan", "complete", 1, 1), coverage("start", 2), coverage("three", 3), coverage("four", 4), coverage("five", 5), observation("later-read", access(location("unused.md")), 5), scan("later", "started", 5), batch("later", [location("later.md")], 6)]);
    const fromObservedAt = "2026-10-18T00:00:02.500Z";
    const toObservedAt = "2026-10-18T00:00:04.500Z";
    const rows = (await store.queryResources({ fromObservedAt, toObservedAt })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.observation, "not-observed");
    assert.equal(rows[0]?.coverageFrom, fromObservedAt);
    assert.equal(rows[0]?.coverageTo, toObservedAt);
    assert.equal(rows[0]?.successfulReadCount, 0);
    assert.equal(rows[0]?.presence, "present");
    assert.equal((await store.queryResourceCoverage({ toObservedAt })).rows[0]?.lastObservedAt, at(4));
  } finally { await store.close(); }
});

test("shared-harness reads with unknown scope prevent false unused and positive scoped counts", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const read = observation("shared-harness", access(location("reference.md"), { mechanism: "fanotify", access: "open", outcome: "unknown", attribution: "harness" }), 2);
    read.scope = { ...read.scope, projectCwd: "[unknown project]", sessionId: null, runId: null };
    await store.record([scan("scan", "started", 0), batch("scan", [location("reference.md")], 1), scan("scan", "complete", 1, 1), coverage("start", 0), coverage("heartbeat", 2), coverage("stop", 3, "stopped"), read]);
    for (const filter of [{ projectCwd: "/project" }, { sessionId: "selected-session" }, { runId: "selected-run" }, { projectCwd: "/project", sessionId: "selected-session", runId: "selected-run" }]) {
      const row = (await store.queryResources({ ...filter, fromObservedAt: at(1), toObservedAt: at(2) })).rows[0];
      assert.ok(row);
      assert.equal(row.observation, "unknown");
      assert.equal(row.unattributedAccessCount, 1);
      assert.equal(row.attributedAccessCount, 0);
      assert.equal(row.openCount, 0);
    }
    assert.equal((await store.queryResources({ toObservedAt: at(3) })).rows[0]?.attributedAccessCount, 1);
  } finally { await store.close(); }
});

test("reads assigned to another concrete project remain outside the selected project", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const read = observation("other-project", access(location("reference.md"), { mechanism: "fanotify", access: "open", outcome: "unknown", attribution: "harness" }), 2);
    read.scope = { ...read.scope, projectCwd: "/other-project", sessionId: null };
    await store.record([scan("scan", "started", 0), batch("scan", [location("reference.md")], 1), scan("scan", "complete", 1, 1), coverage("start", 0), coverage("heartbeat", 2), coverage("stop", 3, "stopped"), read]);
    const row = (await store.queryResources({ projectCwd: "/project", fromObservedAt: at(1), toObservedAt: at(2) })).rows[0];
    assert.equal(row?.observation, "not-observed");
    assert.equal(row?.unattributedAccessCount, 0);
    assert.equal(row?.attributedAccessCount, 0);
    assert.equal(row?.openCount, 0);
  } finally { await store.close(); }
});

test("an inventoried symlink target outside the watched root does not inherit coverage", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const external = location("linked/reference.md", { canonicalPath: "/external/reference.md" });
    await store.record([scan("scan", "started", 0), batch("scan", [external], 1), scan("scan", "complete", 1, 1), coverage("start", 0), coverage("heartbeat", 2)]);
    const row = (await store.queryResources({ fromObservedAt: at(1), toObservedAt: at(2) })).rows[0];
    assert.equal(row?.presence, "present");
    assert.equal(row?.observation, "unknown");
    assert.equal(row?.coverageFrom, null);
    assert.equal(row?.coverageTo, null);
  } finally { await store.close(); }
});

test("resource projections, receipts, and outbox changes roll back together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-resource-"));
  const databasePath = join(directory, "capture.sqlite");
  const enrollment = { sourceId: parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), collectorOrigin: parseCollectorOrigin("http://localhost:3000") };
  const store = openCaptureStore({ databasePath, enrollment });
  try {
    const first = observation("native:first", access(location("first.md")));
    await store.record(first);
    const conflict = observation("native:first", access(location("conflict.md")));
    assert.deepEqual(await store.record([observation("native:new", access(location("new.md"))), conflict]), { accepted: 0, duplicate: 0, dropped: 2 });
    assert.equal((await store.queryResources({})).rows.length, 1);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const table of ["observations", "resource_locations", "resource_events", "delivery_outbox", "native_receipts"]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 1);
      }
    } finally { db.close(); }
    const relay = openRelayStore({ databasePath, enrollment });
    assert.equal(relay.kind, "ready");
    if (relay.kind === "ready") {
      const pending = await relay.store.selectPending({ maxCount: 100, maxPayloadBytes: 1024 * 1024, maxVersion: 5 });
      assert.equal(pending[0]?.kind, "ready");
      if (pending[0]?.kind === "ready") assert.deepEqual(pending[0].observation.evidence, first.evidence);
      await relay.store.close();
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("aggregate resource identity includes source and projects survive duplicate delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-resource-aggregate-"));
  const databasePath = join(directory, "aggregate.sqlite");
  const aggregate = openAggregateStore({ databasePath });
  try {
    const sources = [
      { machineId: parseMachineId("machine-a"), sourceId: parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") },
      { machineId: parseMachineId("machine-a"), sourceId: parseSourceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") },
    ];
    const event = observation("same-event", access(location("reference.md")));
    for (const source of sources) {
      assert.deepEqual(await aggregate.ingest({ source, observations: [event] }), { kind: "committed", accepted: 1, duplicate: 0 });
      assert.deepEqual(await aggregate.ingest({ source, observations: [event] }), { kind: "committed", accepted: 0, duplicate: 1 });
    }
    const read = openHotplateReadStore({ databasePath });
    assert.equal(read.kind, "ready");
    if (read.kind === "ready") {
      const rows = (await read.store.queryResources({})).rows;
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]?.resourceId, rows[1]?.resourceId);
      assert.ok(rows.every(row => row.successfulReadCount === 1));
      await read.store.close();
    }
  } finally { await aggregate.close(); await rm(directory, { recursive: true, force: true }); }
});

test("coverage proof bounds retain future heartbeats and do not revive retired observation", async t => {
  const store = openHotplateStore({ databasePath: ":memory:" }); t.after(() => store.close());
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T00:00:04.500Z"));
  await store.record([scan("bound", "started", 0), batch("bound", [location("bounded.md")], 1), scan("bound", "complete", 1, 1),
    coverage("coverage-bound-start", 0), coverage("coverage-bound-heartbeat", 2), coverage("coverage-bound-stop", 3, "stopped")]);
  assert.equal((await store.queryResources({})).rows[0]?.observation, "unknown");
  assert.equal((await store.queryResources({ toObservedAt: at(4) })).rows[0]?.observation, "unknown");
  const historical = (await store.queryResources({ toObservedAt: "2026-10-18T00:00:01.500Z" })).rows[0];
  assert.equal(historical?.observation, "not-observed");
  assert.equal(historical?.coverageTo, "2026-10-18T00:00:01.500Z");
  await store.record([coverage("coverage-bound-resume", 4), coverage("coverage-bound-future", 5)]);
  const current = (await store.queryResources({ fromObservedAt: at(4) })).rows[0];
  assert.equal(current?.observation, "not-observed");
  assert.equal(current?.coverageTo, "2026-10-18T00:00:04.500Z");
});
