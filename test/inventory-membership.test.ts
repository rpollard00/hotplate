import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { Observation } from "../src/domain.js";
import type { ResourceLocation } from "../src/resource-domain.js";
import { parseMachineId, parseSourceId } from "../src/observation.js";
import { createAnalyticsReadModel } from "../src/analytics-read-model.js";
import { openAggregateStore, openHotplateReadStore, openHotplateStore } from "../src/store.js";

const resources: ResourceLocation[] = Array.from({ length: 24 }, (_, i) => ({ filesystemId: "fs", canonicalPath: `/skills/nested/${i}.md`,
  observedPath: `/skills/nested/${i}.md`, rootPath: "/skills", kind: "reference", ownerSkillPath: null }));
function publication(index: number, rootPath = "/skills", members = resources): Observation[] {
  const scanId = `scan-${rootPath}-${index}`;
  const time = new Date(Date.UTC(2026, 9, 20) + index * 1000).toISOString();
  const base = { kind: "inventory-snapshot", filesystemId: "fs", rootPath, scanId, origin: "host", scope: "session" } as const;
  const frame = (phase: string, evidence: Observation["evidence"]): Observation => ({ id: `${scanId}-${phase}`, producerId: `${scanId}-${phase}`, sequence: 0, observedAt: time, host: "codex",
    scope: { projectCwd: "/project", sessionId: `session-${index}`, runId: null, sessionFile: null, segmentId: "segment", segmentReason: "unknown", turnId: null, leafId: null }, evidence });
  const ordered = index % 2 ? [...members].reverse() : [...members.slice(index % members.length), ...members.slice(0, index % members.length)];
  const size = 5 + index % 7;
  const batches: Observation[] = [];
  for (let i = 0; i < ordered.length; i += size) batches.push(frame(`batch-${i / size}`, { ...base, phase: "batch", batchIndex: i / size,
    resources: ordered.slice(i, i + size).map(resource => ({ ...resource, rootPath })), error: null }));
  return [frame("start", { ...base, phase: "started", resources: [], error: null }), ...batches,
    frame("complete", { ...base, phase: "complete", resources: [], batchCount: batches.length, error: null })];
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-shared-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "capture.sqlite");
}
function rawDigest(db: DatabaseSync): string {
  const hash = createHash("sha256");
  for (const table of ["observations", "resource_events", "resource_locations", "delivery_outbox"]) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}
function removeSharedModel(db: DatabaseSync): void {
  db.exec(`ALTER TABLE inventory_scan_facts DROP COLUMN membership_id;
    ALTER TABLE inventory_scan_facts DROP COLUMN positive_projection;
    DROP TABLE inventory_scan_current; DROP TABLE inventory_location_current; DROP TABLE inventory_membership_members; DROP TABLE inventory_memberships;
    PRAGMA user_version = 9;`);
}

test("1476 shuffled and rebatched session publications share full membership without bucket expansion", async t => {
  const databasePath = await fixture(t);
  let store = openHotplateStore({ databasePath });
  for (let i = 0; i < 1476; i += 1) await store.record(publication(i));
  for (let i = 0; i < 8; i += 1) await store.record(publication(i, "/skills/nested").reverse());
  await store.close();
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
  assert.equal(count("inventory_memberships"), 2);
  assert.equal(count("inventory_membership_members"), 48);
  assert.equal(count("inventory_location_current"), 48);
  assert.equal(count("inventory_scan_current"), 1484);
  assert.equal(count("inventory_location_buckets"), 0);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM inventory_scan_facts WHERE membership_id IS NOT NULL").get()?.n, 1476);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT membership_id) AS n FROM inventory_scan_facts WHERE root_path = '/skills'").get()?.n, 1);
  const before = rawDigest(db);
  store = openHotplateStore({ databasePath });
  assert.equal((await store.record(publication(7))).duplicate, publication(7).length);
  assert.equal((await store.queryResources({ sessionId: "unpublished" })).rows.length, 0);
  assert.equal((await store.queryResources({ sessionId: "session-1475" })).rows.length, 24);
  assert.deepEqual((await store.queryResources({ sessionId: "session-1475" })).rows[0]?.rootPaths, ["/skills"]);
  assert.deepEqual((await store.queryResources({ sessionId: "session-0" })).rows[0]?.rootPaths, ["/skills", "/skills/nested"]);
  await store.close();
  assert.equal(rawDigest(db), before);
  assert.equal(count("inventory_membership_members"), 48);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  t.diagnostic(JSON.stringify({ publications: 1484, members: count("inventory_membership_members"), currentRows: count("inventory_location_current"), frames: count("inventory_scan_facts"), pages: db.prepare("PRAGMA page_count").get()?.page_count }));
});

test("schema9 migration is atomic, retains raw evidence and analytics, and reopens idempotently", async t => {
  const databasePath = await fixture(t);
  let store = openHotplateStore({ databasePath });
  await store.record(publication(0));
  const [first] = resources;
  assert.ok(first);
  const [frame] = publication(1);
  assert.ok(frame);
  await store.record({ ...frame, id: "read", producerId: "read", evidence: { kind: "resource-access", resource: first, operationId: "read",
    mechanism: "host-tool", access: "read", outcome: "success", model: null, attribution: "session", process: null } });
  await store.close();
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  createAnalyticsReadModel(db);
  removeSharedModel(db);
  const before = rawDigest(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resource_access_facts").get()?.n, 1);
  db.exec("CREATE TRIGGER analytics_must_not_rebuild BEFORE INSERT ON resource_access_facts BEGIN SELECT RAISE(ABORT, 'unexpected analytics rebuild'); END;");
  const exec = DatabaseSync.prototype.exec;
  const failure = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql.includes("CREATE TABLE inventory_memberships")) throw new Error("simulated shared migration failure after DDL");
    return result;
  });
  assert.throws(() => openHotplateStore({ databasePath }), /simulated shared migration failure/u);
  failure.mock.restore();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'inventory_memberships'").get()?.n, 0);
  assert.equal(rawDigest(db), before);
  store = openHotplateStore({ databasePath }); await store.close();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_membership_members").get()?.n, 24);
  assert.equal(rawDigest(db), before);
  const state = db.prepare("SELECT * FROM inventory_location_current ORDER BY variant_id").all();
  store = openHotplateStore({ databasePath }); await store.close();
  assert.deepEqual(db.prepare("SELECT * FROM inventory_location_current ORDER BY variant_id").all(), state);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});


test("changed and failed scans retain partial positives without granting shared availability", async t => {
  const databasePath = await fixture(t);
  const store = openHotplateStore({ databasePath }); t.after(() => store.close());
  await store.record(publication(0));
  const changed = resources.slice(1);
  await store.record(publication(1, "/skills", changed).reverse());
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_memberships").get()?.n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_membership_members").get()?.n, 47);
  assert.equal((await store.queryResources({})).rows.find(row => row.resource.canonicalPath === resources[0]?.canonicalPath)?.presence, "absent");
  assert.equal((await store.queryResources({ sessionId: "session-0" })).rows.every(row => row.presence === "present"), true);
  const failed = publication(2, "/skills", resources.slice(0, 1));
  const [start, batch] = failed;
  assert.ok(start && batch);
  await store.record([start, batch]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_memberships").get()?.n, 2);
  assert.equal((await store.queryResources({ sessionId: "session-2" })).rows.length, 1);
  const terminal = failed.at(-1);
  assert.ok(terminal && terminal.evidence.kind === "inventory-snapshot" && terminal.evidence.phase === "complete");
  await store.record(terminal);
  const beforeConflict = await store.queryResources({ toObservedAt: terminal.observedAt });
  await store.record({ ...terminal, id: "failed-terminal", producerId: "failed-terminal", observedAt: "2026-10-20T00:00:03.000Z",
    evidence: { ...terminal.evidence, phase: "incomplete", error: "io-error" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_scan_facts WHERE scan_id = ? AND membership_id IS NOT NULL").get(terminal.evidence.scanId)?.n, 0);
  assert.deepEqual(await store.queryResources({ toObservedAt: terminal.observedAt }), beforeConflict);
  assert.ok((await store.queryResources({})).rows.some(row => row.presence === "unknown"));
});

test("shared membership keeps account source namespaces distinct", async t => {
  const databasePath = await fixture(t);
  const store = openAggregateStore({ databasePath }); t.after(() => store.close());
  for (const id of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]) {
    assert.equal((await store.ingest({ source: { machineId: parseMachineId("machine"), sourceId: parseSourceId(id) }, observations: publication(0) })).kind, "committed");
  }
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_memberships").get()?.n, 2);
  const read = openHotplateReadStore({ databasePath });
  assert.equal(read.kind, "ready");
  if (read.kind !== "ready") return;
  t.after(() => read.store.close());
  const rows = (await read.store.queryResources({ sessionId: "session-0" })).rows;
  assert.equal(rows.length, 48);
  assert.equal(new Set(rows.map(row => row.sourceId)).size, 2);
});


test("schema9 with an absent analytics projection rebuilds the required retained evidence", async t => {
  const databasePath = await fixture(t);
  let store = openHotplateStore({ databasePath });
  await store.record(publication(0)); await store.close();
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  createAnalyticsReadModel(db); removeSharedModel(db);
  db.exec("DROP TABLE observer_coverage_facts");
  const before = rawDigest(db);
  store = openHotplateStore({ databasePath });
  assert.equal((await store.queryResources({})).rows.length, 24);
  await store.close();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inventory_scan_current").get()?.n, 1);
  assert.equal(rawDigest(db), before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
