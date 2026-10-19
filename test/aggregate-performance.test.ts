import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { Observation } from "../src/domain.js";
import { parseCollectorOrigin, parseMachineId, parseSourceId } from "../src/observation.js";
import { openAggregateStore, openCaptureStore, openHotplateReadStore } from "../src/store.js";

const source = { machineId: parseMachineId("machine-a"), sourceId: parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") };
const enrollment = { sourceId: source.sourceId, collectorOrigin: parseCollectorOrigin("https://hotplate.lan") };
const skill = { name: "alpha", canonicalPath: "/skills/alpha/SKILL.md", version: null };
const storeUrl = new URL("../src/store.js", import.meta.url).href;

function observation(id: string, sequence = 1, evidence: Observation["evidence"] = { kind: "command-intent", skillName: "alpha", source: "interactive" }): Observation {
  return { id, producerId: "producer", sequence, observedAt: "2026-10-19T00:00:00.000Z", host: "codex",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "startup", runId: null, turnId: null, leafId: null }, evidence };
}

function resourceObservation(id: string, sequence = 1): Observation {
  return observation(id, sequence, { kind: "resource-access", resource: {
    filesystemId: "linux:fixture", canonicalPath: "/skills/alpha/reference.md", observedPath: "/skills/alpha/reference.md",
    rootPath: "/skills", kind: "reference", ownerSkillPath: skill.canonicalPath,
  }, operationId: id, mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" });
}

async function database(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-aggregate-perf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "analytics.sqlite");
}

function insertLegacyCollisions(db: DatabaseSync, sequence: number, count: number): void {
  db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?)
    INSERT INTO observations (machine_id, source_id, id, producer_id, sequence, observed_at, project_cwd, segment_id, segment_reason, evidence_kind)
    SELECT ?, ?, 'legacy-' || x, 'producer', ?, '2026-10-19T00:00:00.000Z', '/project', 'segment', 'startup', 'command-intent' FROM n`)
    .run(count, source.machineId, source.sourceId, sequence);
}

function storedState(db: DatabaseSync) {
  return Object.fromEntries(["observations", "catalog_skills", "resource_events", "resource_locations", "database_state", "delivery_outbox", "native_receipts", "registered_sources"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function populatedV5(databasePath: string): Promise<void> {
  const capture = openCaptureStore({ databasePath, enrollment });
  try {
    assert.deepEqual(await capture.record([resourceObservation("native:resource"), observation("catalog", 2, { kind: "catalog-snapshot", skills: [skill] })]),
      { accepted: 2, duplicate: 0, dropped: 0 });
  } finally { await capture.close(); }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("DROP INDEX IF EXISTS observations_sequence_lookup_idx; DROP INDEX IF EXISTS observations_evidence_time_idx; PRAGMA user_version = 5");
    db.prepare("INSERT INTO registered_sources VALUES (?, ?, ?)").run(source.sourceId, source.machineId, "a".repeat(64));
    db.exec("UPDATE observations SET digest = 'preserved-receipt' WHERE id = 'native:resource'");
  } finally { db.close(); }
}

test("aggregate reconciles both identities and rolls back earlier resource and catalog writes", async t => {
  const databasePath = await database(t);
  const aggregate = openAggregateStore({ databasePath });
  t.after(() => aggregate.close());
  const first = observation("first", 1);
  const second = observation("second", 2);
  assert.deepEqual(await aggregate.ingest({ source, observations: [first, second, first] }), { kind: "committed", accepted: 2, duplicate: 1 });
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const before = storedState(db);
  assert.deepEqual(await aggregate.ingest({ source, observations: [
    resourceObservation("new-resource", 3), observation("new-catalog", 4, { kind: "catalog-snapshot", skills: [skill] }),
    { ...first, sequence: second.sequence },
  ] }), { kind: "conflict", observationIds: [first.id] });
  assert.deepEqual(storedState(db), before);
  assert.deepEqual(await aggregate.ingest({ source, observations: [{ ...first, observedAt: "2026-10-18T00:00:00.000Z" }] }),
    { kind: "conflict", observationIds: [first.id] });
});

for (const legacyCount of [1, 2000]) {
  test(`legacy sequence collisions remain conflicts with ${legacyCount} null-digest rows`, async t => {
    const databasePath = await database(t);
    const aggregate = openAggregateStore({ databasePath });
    t.after(() => aggregate.close());
    const current = observation("current", 7);
    assert.deepEqual(await aggregate.ingest({ source, observations: [current] }), { kind: "committed", accepted: 1, duplicate: 0 });
    const db = new DatabaseSync(databasePath);
    t.after(() => db.close());
    insertLegacyCollisions(db, current.sequence, legacyCount);
    const before = storedState(db);
    for (const incoming of [current, { ...current, id: "unseen" }, { ...current, id: "legacy-1" }]) {
      assert.deepEqual(await aggregate.ingest({ source, observations: [incoming] }), { kind: "conflict", observationIds: [incoming.id] });
    }
    assert.deepEqual(storedState(db), before);
    db.prepare("DELETE FROM observations WHERE id = ?").run(current.id);
    assert.deepEqual(await aggregate.ingest({ source, observations: [current] }), { kind: "conflict", observationIds: [current.id] });
  });
}

test("ingest prepares bounded full-key identity seeks once per batch", async t => {
  const databasePath = await database(t);
  const aggregate = openAggregateStore({ databasePath });
  t.after(() => aggregate.close());
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  insertLegacyCollisions(db, 5000, 2000);
  const queries: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const observed = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (/SELECT id, digest FROM observations/u.test(sql)) queries.push(sql);
    return prepare.call(this, sql);
  });
  const batch = Array.from({ length: 100 }, (_, index) => observation(`batch-${index}`, index));
  assert.deepEqual(await aggregate.ingest({ source, observations: batch }), { kind: "committed", accepted: 100, duplicate: 0 });
  observed.mock.restore();
  assert.equal(queries.length, 2);
  const idQuery = queries.find(sql => /AND id = \?/u.test(sql));
  const sequenceQuery = queries.find(sql => /AND producer_id = \?/u.test(sql));
  assert.ok(idQuery);
  assert.ok(sequenceQuery);
  const idPlan = db.prepare(`EXPLAIN QUERY PLAN ${idQuery}`).all(source.machineId, source.sourceId, "missing");
  const sequencePlan = db.prepare(`EXPLAIN QUERY PLAN ${sequenceQuery}`).all(source.machineId, source.sourceId, "producer", 5000);
  assert.match(String(idPlan[0]?.detail), /SEARCH observations USING INDEX sqlite_autoindex_observations_1 \(machine_id=\? AND source_id=\? AND id=\?\)/u);
  assert.match(String(sequencePlan[0]?.detail), /SEARCH observations USING INDEX observations_sequence_lookup_idx \(machine_id=\? AND source_id=\? AND producer_id=\? AND sequence=\?\)/u);
  assert.equal(db.prepare(sequenceQuery).all(source.machineId, source.sourceId, "producer", 5000).length, 2);
});

test("populated v5 upgrades preserve resource tables, enrollment, outbox and receipts", async t => {
  const databasePath = await database(t);
  await populatedV5(databasePath);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const before = storedState(db);
  const tables = db.prepare("SELECT name, rootpage, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const capture = openCaptureStore({ databasePath, enrollment });
  await capture.close();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.deepEqual(storedState(db), before);
  assert.deepEqual(db.prepare("SELECT name, rootpage, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(), tables);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('observations_sequence_lookup_idx', 'observations_evidence_time_idx')").get()?.n, 2);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reopened = openCaptureStore({ databasePath, enrollment });
    assert.equal((await reopened.queryResources({})).rows.length, 1);
    await reopened.close();
  }
  assert.deepEqual(storedState(db), before);
});

test("read-only opens do not migrate v5 or update current planner statistics", async t => {
  const databasePath = await database(t);
  await populatedV5(databasePath);
  const before = await readFile(databasePath);
  assert.throws(() => openHotplateReadStore({ databasePath }), /requires an upgrade/u);
  assert.deepEqual(await readFile(databasePath), before);
  const capture = openCaptureStore({ databasePath, enrollment });
  await capture.close();
  const upgraded = await readFile(databasePath);
  const read = openHotplateReadStore({ databasePath });
  assert.equal(read.kind, "ready");
  if (read.kind === "ready") {
    assert.equal((await read.store.queryOverview({})).observationCount, 2);
    await read.store.close();
  }
  assert.deepEqual(await readFile(databasePath), upgraded);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get()?.n, 0); }
  finally { db.close(); }
});

test("v5 migration rolls back both new indexes when the second index cannot be created", async t => {
  const databasePath = await database(t);
  await populatedV5(databasePath);
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  db.exec("CREATE TABLE observations_evidence_time_idx (value TEXT)");
  const before = storedState(db);
  assert.throws(() => openCaptureStore({ databasePath, enrollment }), /observations_evidence_time_idx/u);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'observations_sequence_lookup_idx'").get()?.n, 0);
  assert.deepEqual(storedState(db), before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("DROP TABLE observations_evidence_time_idx");
  const capture = openCaptureStore({ databasePath, enrollment });
  await capture.close();
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
  assert.deepEqual(storedState(db), before);
});

test("concurrent writers upgrade populated v5 once", async t => {
  const databasePath = await database(t);
  await populatedV5(databasePath);
  const code = `import {openCaptureStore} from ${JSON.stringify(storeUrl)}; const store = openCaptureStore({ databasePath: process.argv[1], enrollment: ${JSON.stringify(enrollment)} }); await store.close();`;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, databasePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr }));
  })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resource_events").get()?.n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
