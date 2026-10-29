import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DashboardFilter, Observation } from "../src/domain.js";
import type { ContentQuery } from "../src/content-analytics.js";
import type { ResourceLocation } from "../src/resource-domain.js";
import { openHotplateStore, openAggregateStore, openCaptureStore } from "../src/store.js";
import { parseCollectorOrigin, parseMachineId, parseSourceId } from "../src/observation.js";
import { removeAnalyticsProjectionSchema } from "./fixtures/legacy-database.js";

const start = Date.parse("2026-10-20T00:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const resource: ResourceLocation = { filesystemId: "fs", canonicalPath: "/skills/mako/SKILL.md", observedPath: "/skills/mako/SKILL.md", rootPath: "/skills", kind: "skill", ownerSkillPath: "/skills/mako/SKILL.md" };
const query: ContentQuery = { content: "both", measure: "activity", split: "agent-model", selection: { kind: "all" }, filter: {} };
function observation(id: string, seconds: number, scope: Partial<Observation["scope"]> = {}): Observation {
  return { id, producerId: id, sequence: 1, observedAt: at(seconds), host: "codex",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: "run", turnId: null, leafId: null, ...scope },
    evidence: { kind: "resource-access", resource, operationId: id, mechanism: "fanotify", access: "open", outcome: "unknown", model: null, process: null, attribution: "harness" } };
}

test("filesystem summaries retain accepted local observation ids without treating them as tool ids", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    for (const id of ["legal\nidentifier", "x".repeat(9000)]) {
      const input = observation(id, 0);
      if (input.evidence.kind !== "resource-access") throw new Error("Invalid test fact");
      input.evidence.operationId = "open";
      assert.deepEqual(await store.record(input), { accepted: 1, duplicate: 0, dropped: 0 });
    }
    assert.equal((await store.queryResources({})).rows[0]?.openCount, 2);
    assert.equal((await store.queryContentAnalytics(query)).overall.count, 2);
  } finally { await store.close(); }
});

test("extreme filesystem timestamps stay undated without changing valid bucket counts", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([observation("dated", 0), { ...observation("extreme", 0), observedAt: "+275760-09-13T00:00:00.000Z" }]);
    const result = await store.queryContentAnalytics(query);
    assert.equal(result.overall.count, 2); assert.equal(result.overall.datedCount, 1); assert.equal(result.overall.undatedCount, 1);
    const timelines = await store.queryContentTimelines({ query, projection: { rowKeys: result.selection.rows.map(row => row.key), cohortKeys: [] } });
    assert.equal(timelines.rows.reduce((total, row) => total + row.datedCount, 0), 1);
    assert.equal(timelines.rows.reduce((total, row) => total + row.undatedCount, 0), 1);
  } finally { await store.close(); }
});

test("date-filtered project facets retain accepted local timestamp formats", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record(["/a", "/b"].map((projectCwd, index) => ({ ...observation(`local-${index}`, 0, { projectCwd }), observedAt: "October 20, 2026 00:00:00 UTC" })));
    const report = await store.queryContentAnalytics({ ...query, filter: { fromObservedAt: at(0), toObservedAt: at(1) } });
    assert.equal(report.overall.count, 2); assert.deepEqual(report.filterOptions.projects, ["/a", "/b"]);
    assert.equal(report.overall.firstEvidenceAt, at(0)); assert.equal(report.overall.lastEvidenceAt, at(0));
  } finally { await store.close(); }
});

for (const filter of [
  { projectCwd: "/project" }, { sessionId: "session" }, { runId: "run" }, { projectCwd: "/project", sessionId: "session", runId: "run" },
] satisfies DashboardFilter[]) test(`partial filesystem buckets retain ambiguous scope under ${JSON.stringify(filter)}`, async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([observation("first", 2, { projectCwd: "[unknown project]", sessionId: null, runId: null }), observation("last", 4, { projectCwd: "[unknown project]", sessionId: null, runId: null })]);
    for (const interval of [{ fromObservedAt: at(1), toObservedAt: at(2) }, { fromObservedAt: at(2), toObservedAt: at(3) }, { fromObservedAt: at(3), toObservedAt: at(4) }]) {
      const row = (await store.queryResources({ ...filter, ...interval })).rows[0];
      assert.ok(row); assert.equal(row.unattributedAccessCount, 1); assert.equal(row.openCount, 0); assert.equal(row.observation, "unknown");
    }
  } finally { await store.close(); }
});

test("partial bucket reads visit cross-project facts once for global and half-open selected bounds", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([observation("a1", 1, { projectCwd: "/a" }), observation("a3", 3, { projectCwd: "/a" }), observation("b4", 4, { projectCwd: "/b" })]);
    for (const [filter, expected] of [[{ fromObservedAt: at(2) }, 2], [{ toObservedAt: at(3) }, 2], [{ fromObservedAt: at(2), toObservedAt: at(4) }, 2]] as const) {
      assert.equal((await store.queryContentAnalytics({ ...query, filter })).overall.count, expected);
      assert.equal((await store.queryResources(filter)).rows[0]?.openCount, expected);
    }
    const selected = await store.queryContentAnalytics({ ...query, selection: { kind: "interval", startAt: at(2), endAt: at(4) } });
    assert.equal(selected.overall.count, 3); assert.equal(selected.selection.count, 1);
    assert.deepEqual(selected.filterOptions.projects, ["/a", "/b"]);
  } finally { await store.close(); }
});

test("compact inventory history retains first/last, old locations, incomplete scans and as-of membership", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  const scan = (id: string, seconds: number, phase: "started" | "batch" | "complete" | "incomplete", resources: readonly ResourceLocation[] = []): Observation => {
    const identity = { kind: "inventory-snapshot", scanId: id, filesystemId: "fs", rootPath: "/skills", origin: "configured", scope: "account" } as const;
    const evidence: Observation["evidence"] = phase === "batch" ? { ...identity, phase, resources, batchIndex: 0, error: null }
      : phase === "started" ? { ...identity, phase, resources: [], error: null }
      : phase === "complete" ? { ...identity, phase, resources: [], batchCount: resources.length ? 1 : 0, error: null }
      : { ...identity, phase, resources: [], batchCount: 0, error: "io-error" };
    return { ...observation(`${id}-${phase}`, seconds), evidence };
  };
  try {
    const changed = { ...resource, ownerSkillPath: "/skills/new/SKILL.md", observedPath: "/alias/SKILL.md" };
    await store.record([scan("old", 1, "started"), scan("old", 2, "batch", [resource]), scan("old", 3, "complete", [resource]),
      scan("new", 3601, "started"), scan("new", 3602, "batch", [changed]), scan("new", 3603, "incomplete"),
      scan("later", 7201, "started"), scan("later", 7203, "incomplete")]);
    const earlier = (await store.queryResources({ toObservedAt: at(3) })).rows[0];
    assert.ok(earlier); assert.equal(earlier.firstInventoriedAt, at(2)); assert.equal(earlier.lastInventoriedAt, at(2));
    assert.deepEqual(earlier.resource, resource); assert.equal(earlier.presence, "present");
    const latest = (await store.queryResources({})).rows[0];
    assert.ok(latest); assert.equal(latest.firstInventoriedAt, at(2)); assert.equal(latest.lastInventoriedAt, at(3602));
    assert.deepEqual(latest.resource, changed); assert.equal(latest.presence, "unknown");
    assert.equal((await store.queryResources({ toObservedAt: at(3601) })).rows[0]?.lastInventoriedAt, at(2));
  } finally { await store.close(); }
});

test("inventory variants retain the last member in a batch even when that variant was already known", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const one = { ...resource, observedPath: "/alias/one/SKILL.md" }; const two = { ...resource, observedPath: "/alias/two/SKILL.md" };
    const batch = (id: string, resources: readonly ResourceLocation[], seconds: number): Observation => ({ ...observation(id, seconds), evidence: {
      kind: "inventory-snapshot", scanId: id, filesystemId: "fs", rootPath: "/skills", origin: "configured", scope: "account", phase: "batch", resources, batchIndex: 0, error: null,
    } });
    await store.record([batch("earlier", [two], 0), batch("latest", [one, two], 1)]);
    const rows = (await store.queryResources({})).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0]?.resource.observedPath, two.observedPath);
    assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ["resourceId", "machineId", "sourceId", "resource", "rootPaths", "presence", "firstInventoriedAt", "lastInventoriedAt", "lastAccessAt", "attemptCount", "successfulReadCount", "inferredReadCount", "failedReadCount", "executeCount", "openCount", "accessCount", "attributedAccessCount", "unattributedAccessCount", "nonAgentAccessCount", "observation", "coverageFrom", "coverageTo"].sort());
  } finally { await store.close(); }
});

test("v7 backfill is atomic, preserves raw history/outbox/receipts and matches online projections", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-projection-migration-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "capture.sqlite");
  const enrollment = { sourceId: parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), collectorOrigin: parseCollectorOrigin("https://hotplate.test") };
  const first = observation("native:open", 0);
  const one = { ...resource, observedPath: "/alias/one/SKILL.md" }; const two = { ...resource, observedPath: "/alias/two/SKILL.md" };
  const inventory = (id: string, resources: readonly ResourceLocation[], seconds: number): Observation => ({ ...observation(id, seconds), evidence: {
    kind: "inventory-snapshot", scanId: id, filesystemId: "fs", rootPath: "/skills", origin: "configured", scope: "account", phase: "batch", resources, batchIndex: 0, error: null,
  } });
  const original = openCaptureStore({ databasePath, enrollment });
  await original.record([first, inventory("old", [two], 1), inventory("new", [one, two], 2)]);
  const resources = await original.queryResources({}); const content = await original.queryContentAnalytics(query); await original.close();
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  removeAnalyticsProjectionSchema(db); db.exec("PRAGMA user_version = 7");
  const raw = () => Object.fromEntries(["observations", "resource_events", "resource_locations", "catalog_skills", "delivery_outbox", "native_receipts", "database_state"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = raw();
  const execute = DatabaseSync.prototype.exec;
  const failure = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS inventory_scan_facts")) throw new Error("simulated inventory migration failure");
    return execute.call(this, sql);
  });
  assert.throws(() => openCaptureStore({ databasePath, enrollment }), /simulated inventory migration failure/u);
  failure.mock.restore();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'resource_access_facts'").get()?.n, 0);
  assert.deepEqual(raw(), before);
  const upgraded = openCaptureStore({ databasePath, enrollment });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 10);
    assert.deepEqual(raw(), before); assert.deepEqual(await upgraded.queryResources({}), resources); assert.deepEqual(await upgraded.queryContentAnalytics(query), content);
    assert.deepEqual(await upgraded.record(first), { accepted: 0, duplicate: 1, dropped: 0 });
    assert.equal(db.prepare("SELECT SUM(fact_count) AS n FROM filesystem_access_buckets").get()?.n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { await upgraded.close(); }
});

test("derived access, buckets and inventory roll back on aggregate conflicts without counting duplicates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-projections-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "aggregate.sqlite"); const store = openAggregateStore({ databasePath }); t.after(() => store.close());
  const source = { machineId: parseMachineId("machine"), sourceId: parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") };
  const first = observation("first", 1);
  assert.deepEqual(await store.ingest({ source, observations: [first, first] }), { kind: "committed", accepted: 1, duplicate: 1 });
  const db = new DatabaseSync(databasePath, { readOnly: true }); t.after(() => db.close());
  const state = () => Object.fromEntries(["observations", "resource_access_facts", "filesystem_access_buckets", "inventory_scan_facts", "inventory_location_buckets", "inventory_location_variants", "inventory_location_current", "inventory_scan_current", "inventory_memberships", "inventory_membership_members"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = state();
  const inventory: Observation = { ...observation("inventory", 2), evidence: { kind: "inventory-snapshot", scanId: "scan", filesystemId: "fs", rootPath: "/skills", origin: "configured", scope: "account", phase: "batch", batchIndex: 0, resources: [resource], error: null } };
  assert.deepEqual(await store.ingest({ source, observations: [observation("new", 2), inventory, { ...first, observedAt: at(5) }] }), { kind: "conflict", observationIds: [first.id] });
  assert.deepEqual(state(), before);
});
