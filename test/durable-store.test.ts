import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { CaptureEnrollment, Observation, SourceIdentity } from "../src/domain.js";
import { LOCAL_MACHINE_ID, LOCAL_SOURCE_ID, parseCollectorOrigin, parseMachineId, parseObservation, parseSourceId, serializeObservation } from "../src/observation.js";
import { openAggregateStore, openCaptureStore, openHotplateReadStore, openHotplateStore, openRelayStore, type RelayStore } from "../src/store.js";
import { createLegacyDatabase } from "./fixtures/legacy-database.js";

const sourceA = parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const sourceB = parseSourceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const machineA = parseMachineId("machine-a");
const machineB = parseMachineId("machine-b");
const enrollment: CaptureEnrollment = { sourceId: sourceA, collectorOrigin: parseCollectorOrigin("https://hotplate.lan") };
const identity: SourceIdentity = { machineId: machineA, sourceId: sourceA };
const skill = { name: "alpha", canonicalPath: "/skills/alpha", version: "v1" };

function observation(id = "obs-1", evidence: Observation["evidence"] = { kind: "read-result", skill, model: { provider: "provider", id: "model" }, toolCallId: "tool", outcome: "success" }): Observation {
  return {
    id, producerId: "producer", sequence: Number(id.replace(/\D/g, "")) || 0, observedAt: "2026-01-02T00:00:00.000Z",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: "/session.jsonl", segmentId: "segment", segmentReason: "startup", runId: "run", turnId: "turn", leafId: null },
    evidence,
  };
}

async function withDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-durable-"));
  try { await run(join(dir, "analytics.sqlite")); } finally { await rm(dir, { recursive: true, force: true }); }
}
function relay(databasePath: string): RelayStore {
  const open = openRelayStore({ databasePath, enrollment });
  assert.equal(open.kind, "ready");
  if (open.kind !== "ready") throw new Error("Expected enrolled relay");
  return open.store;
}
function reader(databasePath: string) {
  const open = openHotplateReadStore({ databasePath });
  assert.equal(open.kind, "ready");
  if (open.kind !== "ready") throw new Error("Expected reader");
  return open.store;
}

test("observation parser copies only allowed metadata and validates external identities", () => {
  const base = observation("obs-1", { kind: "catalog-snapshot", skills: [skill] });
  const input = { ...base, prompt: "secret", toJSON: () => ({ secret: "leak" }), scope: { ...base.scope, text: "secret" }, evidence: { kind: "catalog-snapshot", skills: [{ ...skill, text: "secret", toJSON: () => ({ secret: "leak" }) }], output: "secret" } };
  assert.deepEqual(parseObservation(input), base);
  assert.equal(serializeObservation(parseObservation(input)), serializeObservation(base));
  assert.throws(() => parseObservation({ ...base, sequence: Number.MAX_SAFE_INTEGER + 1 }), /Invalid observation/);
  assert.throws(() => parseSourceId("local"), /UUID/);
  assert.throws(() => parseMachineId("bad machine"), /Invalid machine/);
  for (const origin of ["https://user:pass@hotplate.lan", "https://hotplate.lan/path", "https://hotplate.lan?x", "https://hotplate.lan#x", "https://HOTPLATE.lan", "https://hotplate.lan/@", "file:///tmp"]) {
    assert.throws(() => parseCollectorOrigin(origin));
  }
  assert.equal(parseCollectorOrigin("https://hotplate.lan/"), enrollment.collectorOrigin);
});

test("v1 readers require an upgrade without mutation; writer migration preserves rows and creates no backlog", async () => {
  await withDatabase(async databasePath => {
    createLegacyDatabase(databasePath);
    assert.throws(() => reader(databasePath), /database requires an upgrade.*current capture command or openHotplateStore/u);
    assert.deepEqual(openRelayStore({ databasePath, enrollment }), { kind: "not-enrolled" });
    let db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='delivery_outbox'").get()?.n, 0);
    db.close();
    const store = openHotplateStore({ databasePath });
    assert.equal((await store.queryOverview({})).observationCount, 1);
    assert.equal((await store.queryOverview({})).catalogSkillCount, 1);
    assert.equal((await store.querySkillTable({})).rows[0]?.machineId, LOCAL_MACHINE_ID);
    await store.close();
    db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
    assert.deepEqual({ ...db.prepare("SELECT machine_id, source_id, digest FROM observations").get() }, { machine_id: LOCAL_MACHINE_ID, source_id: LOCAL_SOURCE_ID, digest: null });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get()?.n, 0);
    db.close();
    const capture = openCaptureStore({ databasePath, enrollment });
    const outbox = relay(databasePath);
    assert.equal((await outbox.queryStatus()).pendingCount, 0);
    assert.deepEqual(await capture.record(observation("legacy-catalog")), { accepted: 0, duplicate: 1, dropped: 0 });
    assert.equal((await outbox.queryStatus()).pendingCount, 0);
    await outbox.close();
    await capture.close();
  });
});

test("failed migration rolls back table renames, copied data, delivery schema and version", async () => {
  await withDatabase(async databasePath => {
    createLegacyDatabase(databasePath);
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA ignore_check_constraints=ON; UPDATE observations SET sequence=-1");
    assert.throws(() => openHotplateStore({ databasePath }), /CHECK constraint/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(db.prepare("SELECT sequence FROM observations").get()?.sequence, -1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('observations_v1', 'delivery_outbox')").get()?.n, 0);
    db.exec("UPDATE observations SET sequence=0");
    db.close();
    const store = openHotplateStore({ databasePath });
    assert.equal((await store.queryOverview({})).catalogSkillCount, 1);
    await store.close();
  });
});

function childProcess(code: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exited };
}
const storeUrl = new URL("../src/store.js", import.meta.url).href;

test("concurrent first writer opens migrate v1 exactly once", async () => {
  await withDatabase(async databasePath => {
    createLegacyDatabase(databasePath);
    const code = `import {openHotplateStore} from ${JSON.stringify(storeUrl)}; const store=openHotplateStore({databasePath:process.argv[1]}); await store.close();`;
    const results = await Promise.all(Array.from({ length: 4 }, () => childProcess(code, [databasePath]).exited));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const read = reader(databasePath);
    assert.equal((await read.queryOverview({})).observationCount, 1);
    assert.equal((await read.queryOverview({})).catalogSkillCount, 1);
    await read.close();
  });
});

test("a process interrupted during migration leaves recoverable v1 data and no partial upgrade", async () => {
  await withDatabase(async databasePath => {
    createLegacyDatabase(databasePath);
    let db = new DatabaseSync(databasePath);
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
      INSERT INTO observations (id,producer_id,sequence,observed_at,project_cwd,segment_id,segment_reason,evidence_kind)
      SELECT 'bulk-'||x, 'bulk', x, '2026-01-01T00:00:00.000Z', '/'||hex(zeroblob(512)), 'segment','startup','catalog-snapshot' FROM n;`);
    db.close();
    const running = childProcess(`import {openHotplateStore} from ${JSON.stringify(storeUrl)}; const store=openHotplateStore({databasePath:process.argv[1]}); await store.close();`, [databasePath]);
    let interrupted = false;
    for (let attempt = 0; attempt < 5000; attempt += 1) {
      if (running.child.exitCode !== null) break;
      const wal = await stat(`${databasePath}-wal`).catch(() => null);
      if (wal && wal.size > 1024 * 1024) { interrupted = running.child.kill("SIGKILL"); break; }
      await delay(1);
    }
    if (!interrupted) running.child.kill("SIGKILL");
    const result = await running.exited;
    assert.ok(interrupted, `Migration did not expose an uncommitted WAL: ${result.stderr}`);
    assert.equal(result.signal, "SIGKILL");
    db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations").get()?.n, 50001);
    db.close();
    const store = openHotplateStore({ databasePath });
    assert.equal((await store.queryOverview({})).observationCount, 50001);
    await store.close();
  });
});

test("relay startup never creates or enrolls capture; binding cannot redirect pending metadata", async () => {
  await withDatabase(async databasePath => {
    assert.deepEqual(openRelayStore({ databasePath, enrollment }), { kind: "missing" });
    assert.equal(await stat(databasePath).catch(() => null), null);
    const local = openHotplateStore({ databasePath });
    await local.record(observation("obs-1"));
    assert.deepEqual(openRelayStore({ databasePath, enrollment }), { kind: "not-enrolled" });
    const capture = openCaptureStore({ databasePath, enrollment });
    await capture.record(observation("obs-2"));
    await local.record(observation("obs-3"));
    const outbox = relay(databasePath);
    assert.equal((await outbox.queryStatus()).pendingCount, 1);
    assert.throws(() => openCaptureStore({ databasePath, enrollment: { ...enrollment, sourceId: sourceB } }), /does not match/);
    assert.throws(() => openRelayStore({ databasePath, enrollment: { ...enrollment, collectorOrigin: parseCollectorOrigin("https://other.lan") } }), /does not match/);
    await outbox.close();
    await capture.close();
    await local.close();
  });
});

test("capture and full allowlisted catalog delivery commit atomically, and duplicates never re-enroll", async () => {
  await withDatabase(async databasePath => {
    const capture = openCaptureStore({ databasePath, enrollment });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON delivery_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END");
    const base = observation("obs-1", { kind: "catalog-snapshot", skills: [skill, { ...skill, name: "beta" }] });
    assert.deepEqual(await capture.record(base), { accepted: 0, duplicate: 0, dropped: 1 });
    assert.equal((await capture.queryOverview({})).observationCount, 0);
    assert.equal((await capture.queryOverview({})).catalogSkillCount, 0);
    db.exec("DROP TRIGGER fail_outbox");
    db.close();
    const extra = { ...base, prompt: "secret", scope: { ...base.scope, text: "secret" } };
    assert.deepEqual(await capture.record(extra), { accepted: 1, duplicate: 0, dropped: 0 });
    const outbox = relay(databasePath);
    const candidates = await outbox.selectPending({ maxCount: 100, maxPayloadBytes: 1024 * 1024 });
    assert.deepEqual(candidates, [{ kind: "ready", observation: base, payloadBytes: Buffer.byteLength(serializeObservation(base)) }]);
    assert.equal((await capture.queryOverview({})).catalogSkillCount, 2);
    await outbox.settle({ settlement: { kind: "committed", observationIds: [base.id] } });
    assert.deepEqual(await capture.record(base), { accepted: 0, duplicate: 1, dropped: 0 });
    assert.equal((await outbox.queryStatus()).pendingCount, 0);
    await outbox.close();
    await capture.close();
  });
});

test("outbox bounds payload reads, retains oversized entries and settles exact IDs without resurrection", async () => {
  await withDatabase(async databasePath => {
    const capture = openCaptureStore({ databasePath, enrollment });
    const huge = observation("obs-1", { kind: "catalog-snapshot", skills: [{ ...skill, canonicalPath: "x".repeat(1024 * 1024) }] });
    const small = observation("obs-2");
    await capture.record([huge, small, observation("obs-3")]);
    const first = relay(databasePath);
    const second = relay(databasePath);
    const size = Buffer.byteLength(serializeObservation(small));
    const selected = await first.selectPending({ maxCount: 100, maxPayloadBytes: size });
    assert.equal(selected.length, 2);
    assert.deepEqual(selected[0], { kind: "oversized", observationId: huge.id, payloadBytes: Buffer.byteLength(serializeObservation(huge)) });
    assert.equal(selected[1]?.kind, "ready");
    assert.equal((await capture.queryOverview({})).observationCount, 3);
    assert.equal((await first.queryStatus()).pendingCount, 3);
    await first.settle({ settlement: { kind: "blocked", observationIds: [huge.id], reason: "oversized" } });
    await second.settle({ settlement: { kind: "committed", observationIds: [small.id, "not-present"] } });
    await first.settle({ settlement: { kind: "blocked", observationIds: [small.id], reason: "conflict" } });
    const status = await first.queryStatus();
    assert.equal(status.pendingCount, 2);
    assert.equal(status.blockedCount, 1);
    assert.equal(status.pendingBytes, Buffer.byteLength(serializeObservation(huge)) + size);
    assert.ok(status.oldestPendingAt);
    const remaining = await second.selectPending({ maxCount: 100, maxPayloadBytes: 1024 * 1024 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.kind === "ready" && remaining[0].observation.id, "obs-3");
    const signal = AbortSignal.abort();
    await assert.rejects(first.settle({ settlement: { kind: "committed", observationIds: ["obs-3"] }, signal }));
    assert.equal((await first.queryStatus()).pendingCount, 2);
    await first.close(); await second.close(); await capture.close();
    const restarted = relay(databasePath);
    assert.equal((await restarted.queryStatus()).pendingCount, 2);
    assert.equal((await restarted.queryStatus()).blockedCount, 1);
    await restarted.close();
  });
});

test("aggregate commits full batches with exact canonical retry conflicts including catalog members", async () => {
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    const catalog = observation("obs-1", { kind: "catalog-snapshot", skills: [skill] });
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [catalog] }), { kind: "committed", accepted: 1, duplicate: 0 });
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [catalog] }), { kind: "committed", accepted: 0, duplicate: 1 });
    const changed = { ...catalog, evidence: { kind: "catalog-snapshot", skills: [{ ...skill, version: "changed" }] } } satisfies Observation;
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [observation("obs-2"), changed] }), { kind: "conflict", observationIds: [catalog.id] });
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [{ ...catalog, id: "another-id" }] }), { kind: "conflict", observationIds: ["another-id"] });
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [observation("obs-3"), { ...observation("obs-3"), observedAt: "2026-01-03T00:00:00.000Z" }] }), { kind: "conflict", observationIds: ["obs-3"] });
    let read = reader(databasePath);
    assert.equal((await read.queryOverview({})).observationCount, 1);
    assert.equal((await read.querySkillTable({})).rows[0]?.version, "v1");
    await read.close();
    const cancelled = await aggregate.ingest({ source: identity, observations: [observation("obs-2")], signal: AbortSignal.abort() });
    assert.deepEqual(cancelled, { kind: "unavailable", reason: "cancelled" });
    const lock = new DatabaseSync(databasePath);
    lock.exec("BEGIN IMMEDIATE");
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [observation("obs-2")] }), { kind: "unavailable", reason: "busy" });
    lock.exec("ROLLBACK"); lock.close();
    await aggregate.close();
    const reopened = openAggregateStore({ databasePath });
    assert.deepEqual(await reopened.ingest({ source: identity, observations: [catalog] }), { kind: "committed", accepted: 0, duplicate: 1 });
    read = reader(databasePath);
    assert.equal((await read.queryOverview({})).observationCount, 1);
    await read.close(); await reopened.close();
  });
});

test("aggregate identity isolation includes machines, account sources, activations, catalogs and chains", async () => {
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    const observations = [observation("obs-1"), observation("obs-2", { kind: "catalog-snapshot", skills: [skill] })];
    for (const source of [identity, { machineId: machineA, sourceId: sourceB }, { machineId: machineB, sourceId: sourceA }]) {
      assert.deepEqual(await aggregate.ingest({ source, observations }), { kind: "committed", accepted: 2, duplicate: 0 });
    }
    const read = reader(databasePath);
    const all = await read.queryOverview({});
    assert.equal(all.observationCount, 6);
    assert.equal(all.uniqueObservedSkillRunActivations, 3);
    assert.equal(all.catalogSkillCount, 2);
    assert.equal((await read.queryOverview({ machineId: machineA })).uniqueObservedSkillRunActivations, 2);
    assert.equal((await read.queryOverview({ machineId: machineB })).catalogSkillCount, 1);
    const skills = (await read.querySkillTable({})).rows;
    assert.equal(skills.length, 2);
    assert.equal(skills.find(row => row.machineId === machineA)?.uniqueObservedRunActivations, 2);
    const matrix = (await read.queryModelMatrix({})).rows;
    assert.equal(matrix.length, 2);
    assert.equal(matrix.find(row => row.machineId === machineA)?.uniqueObservedRunActivations, 2);
    assert.equal((await read.querySkillChain({})).runs.length, 3);
    assert.deepEqual((await read.querySkillChain({ machineId: machineA })).runs.map(run => run.sourceId).sort(), [sourceA, sourceB]);
    await read.close(); await aggregate.close();
  });
});

test("catalog late delivery preserves first/last times, deterministic versions and project-specific counts", async () => {
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    const snapshot = (id: string, time: string, version: string): Observation => ({ ...observation(id, { kind: "catalog-snapshot", skills: [{ ...skill, version }] }), observedAt: time });
    await aggregate.ingest({ source: identity, observations: [snapshot("obs-1", "2026-01-03T00:00:00.000Z", "v3")] });
    await aggregate.ingest({ source: identity, observations: [snapshot("obs-2", "2026-01-01T00:00:00.000Z", "v1")] });
    await aggregate.ingest({ source: identity, observations: [snapshot("obs-3", "2026-01-03T00:00:00.000Z", "v4"), snapshot("obs-4", "2026-01-03T00:00:00.000Z", "v2")] });
    const otherProject = snapshot("obs-5", "2026-01-03T00:00:00.000Z", "v4");
    otherProject.scope.projectCwd = "/other-project";
    await aggregate.ingest({ source: identity, observations: [otherProject] });
    const read = reader(databasePath);
    assert.equal((await read.querySkillTable({ projectCwd: "/project" })).rows[0]?.version, "v4");
    assert.equal((await read.queryOverview({})).catalogSkillCount, 2);
    assert.equal((await read.queryOverview({ projectCwd: "/project", toObservedAt: "2026-01-02T00:00:00.000Z" })).catalogSkillCount, 1);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare("SELECT first_observed_at, last_observed_at FROM catalog_skills WHERE project_cwd='/project'").get();
    assert.equal(row?.first_observed_at, "2026-01-01T00:00:00.000Z");
    assert.equal(row?.last_observed_at, "2026-01-03T00:00:00.000Z");
    db.close(); await read.close(); await aggregate.close();
  });
});

test("filter options share the read snapshot and scope projects/models without trapping the machine selector", async () => {
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    await aggregate.ingest({ source: identity, observations: [observation()] });
    const other = observation();
    other.scope.projectCwd = "/machine-b";
    other.evidence = { kind: "read-result", skill, toolCallId: "tool", outcome: "success", model: { provider: "provider-b", id: "model-b" } };
    await aggregate.ingest({ source: { machineId: machineB, sourceId: sourceB }, observations: [other] });
    const read = reader(databasePath);
    const options = await read.queryFilterOptions({ machineId: machineA });
    assert.deepEqual(options.machines, [machineA, machineB]);
    assert.deepEqual(options.projects, ["/project"]);
    assert.deepEqual(options.modelProviders, ["provider"]);
    assert.deepEqual(options.modelIds, ["model"]);
    await aggregate.ingest({ source: identity, observations: [observation("obs-2")] });
    assert.equal((await read.queryOverview({})).observationCount, 2);
    await read.close(); await aggregate.close();
  });
});

test("structured tuple keys distinguish delimiter characters, null and empty run identities", async () => {
  await withDatabase(async databasePath => {
    const store = openHotplateStore({ databasePath });
    const first = observation("obs-1", { kind: "wrapper-observed", skill: { ...skill, name: "a\u001fb", canonicalPath: "c" }, wrapperSource: "expanded-prompt" });
    const second = observation("obs-2", { kind: "wrapper-observed", skill: { ...skill, name: "a", canonicalPath: "b\u001fc" }, wrapperSource: "expanded-prompt" });
    first.scope.runId = null;
    second.scope.runId = "";
    const third = observation("obs-3", first.evidence);
    third.scope.runId = "";
    await store.record([first, second, third]);
    assert.equal((await store.querySkillTable({})).rows.length, 2);
    assert.equal((await store.querySkillTable({})).rows.find(row => row.skillName === "a\u001fb")?.uniqueObservedRunActivations, 2);
    assert.equal((await store.queryOverview({})).uniqueObservedSkillRunActivations, 3);
    assert.equal((await store.querySkillChain({})).runs.length, 2);
    await store.close();
  });
});

test("aggregate storage errors roll back observations and catalog changes for the entire batch", async () => {
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TRIGGER reject_catalog BEFORE INSERT ON catalog_skills BEGIN SELECT RAISE(ABORT, 'injected catalog failure'); END");
    const result = await aggregate.ingest({ source: identity, observations: [observation("obs-1"), observation("obs-2", { kind: "catalog-snapshot", skills: [skill] })] });
    assert.deepEqual(result, { kind: "unavailable", reason: "storage-error" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations").get()?.n, 0);
    db.close(); await aggregate.close();
  });
});

test("concurrent aggregate processes accept an identity once; reordered properties are an identical retry", async () => {
  await withDatabase(async databasePath => {
    const input = observation();
    const code = `import {openAggregateStore} from ${JSON.stringify(storeUrl)};
      const store = openAggregateStore({databasePath:process.argv[1]});
      const result = await store.ingest({source:${JSON.stringify(identity)},observations:[${JSON.stringify(input)}]});
      if (result.kind !== 'committed') throw new Error(JSON.stringify(result));
      await store.close();`;
    for (const result of await Promise.all(Array.from({ length: 4 }, () => childProcess(code, [databasePath]).exited))) {
      assert.equal(result.code, 0, result.stderr);
    }
    const aggregate = openAggregateStore({ databasePath });
    const reordered = { evidence: input.evidence, scope: input.scope, observedAt: input.observedAt, sequence: input.sequence, producerId: input.producerId, id: input.id, extra: "not metadata" };
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [reordered] }), { kind: "committed", accepted: 0, duplicate: 1 });
    const read = reader(databasePath);
    assert.equal((await read.queryOverview({})).observationCount, 1);
    await read.close(); await aggregate.close();
  });
});

test("an acknowledged aggregate batch survives process termination before database close", async () => {
  await withDatabase(async databasePath => {
    const code = `import {openAggregateStore} from ${JSON.stringify(storeUrl)};
      const store = openAggregateStore({databasePath:process.argv[1]});
      const result = await store.ingest({source:${JSON.stringify(identity)},observations:[${JSON.stringify(observation())}]});
      if (result.kind !== 'committed') throw new Error(JSON.stringify(result));
      process.stdout.write('acknowledged'); setInterval(() => {}, 1000);`;
    const running = childProcess(code, [databasePath]);
    try {
      const acknowledged = new Promise<void>(resolve => running.child.stdout.once("data", () => resolve()));
      await Promise.race([acknowledged, running.exited.then(result => { throw new Error(`No acknowledgment: ${result.stderr}`); })]);
    } finally { running.child.kill("SIGKILL"); }
    assert.equal((await running.exited).signal, "SIGKILL");
    const aggregate = openAggregateStore({ databasePath });
    assert.deepEqual(await aggregate.ingest({ source: identity, observations: [observation()] }), { kind: "committed", accepted: 0, duplicate: 1 });
    await aggregate.close();
  });
});

test("an already-open local handle cannot write after an empty database becomes an aggregate", async () => {
  await withDatabase(async databasePath => {
    const local = openHotplateStore({ databasePath });
    const aggregate = openAggregateStore({ databasePath });
    assert.deepEqual(await local.record(observation()), { accepted: 0, duplicate: 0, dropped: 1 });
    await local.close(); await aggregate.close();
  });
});

test("local producer/sequence reuse remains valid while aggregate/local modes cannot mix", async () => {
  await withDatabase(async databasePath => {
    const local = openHotplateStore({ databasePath });
    assert.deepEqual(await local.record([observation("one"), observation("two")]), { accepted: 2, duplicate: 0, dropped: 0 });
    await local.close();
    assert.throws(() => openAggregateStore({ databasePath }), /separate database/);
  });
  await withDatabase(async databasePath => {
    const aggregate = openAggregateStore({ databasePath });
    await assert.rejects(aggregate.ingest({ source: { machineId: LOCAL_MACHINE_ID, sourceId: sourceA }, observations: [observation()] }), /Reserved local/);
    assert.throws(() => openHotplateStore({ databasePath }), /separate database/);
    assert.throws(() => openCaptureStore({ databasePath, enrollment }), /separate database/);
    await aggregate.close();
  });
});
