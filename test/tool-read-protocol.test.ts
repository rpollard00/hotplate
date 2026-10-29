import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Evidence, Observation } from "../src/domain.js";
import type { ResourceAccessEvidence, ToolCoverageEvidence } from "../src/resource-domain.js";
import { captureFact, type CaptureFact } from "../src/capture.js";
import { encodeEnvelope, parseEnvelope, parseProtocolCapabilities } from "../src/network-protocol.js";
import { parseCollectorOrigin, parseMachineId, parseObservation, parseSourceId, serializeObservation } from "../src/observation.js";
import { openAggregateStore, openCaptureStore, openHotplateReadStore, openHotplateStore, openRelayStore } from "../src/store.js";
import { removeAnalyticsProjectionSchema } from "./fixtures/legacy-database.js";

const sourceId = parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const machineId = parseMachineId("machine-a");
const enrollment = { sourceId, collectorOrigin: parseCollectorOrigin("https://hotplate.lan") };
const scope = { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null } as const;
const resource = { filesystemId: "filesystem", canonicalPath: "/skills/example/references/file.md", observedPath: "/skills/example/references/file.md", rootPath: "/skills", kind: "reference", ownerSkillPath: "/skills/example/SKILL.md" } as const;
const legacyRead = { kind: "resource-access", resource, operationId: "operation", mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" } satisfies ResourceAccessEvidence;
const inferredRead = { ...legacyRead, access: "inferred-read", toolRead: {
  kind: "literal-command", requested: { kind: "lines", start: 2, count: 5 }, delivery: { kind: "unknown" }, revision: { kind: "unknown" },
} } satisfies ResourceAccessEvidence;
const execution = { ...legacyRead, resource: { ...resource, canonicalPath: "/skills/example/scripts/log.sh", observedPath: "/skills/example/scripts/log.sh", kind: "script" },
  access: "execute", outcome: "success" } satisfies ResourceAccessEvidence;
const coverage: ToolCoverageEvidence = { kind: "tool-coverage", operationId: "opaque-op", family: "python", outcome: "success", model: null,
  recognition: { kind: "opaque", reason: "unsupported-syntax" } };
function observation(evidence: Evidence, id: string = evidence.kind): Observation {
  return { id, producerId: id, sequence: 0, host: "claude-code", observedAt: "2026-10-19T00:00:00.000Z", scope, evidence };
}
function fact(evidence: CaptureFact["evidence"]): CaptureFact {
  return { host: "claude-code", actorId: "actor", occurrenceId: "operation", sessionId: "session", observedAt: "2026-10-19T00:00:00.000Z", scope, evidence };
}

test("version four preserves new read evidence while versions one through three reject new semantics", () => {
  const structured: ResourceAccessEvidence = { ...legacyRead, toolRead: { ...inferredRead.toolRead, kind: "structured-read" } };
  for (const evidence of [inferredRead, structured, coverage]) {
    const event = observation(evidence);
    const encoded = encodeEnvelope(sourceId, [event]);
    assert.match(encoded, /^\{"version":4,/);
    assert.deepEqual(parseEnvelope(JSON.parse(encoded)), { sourceId, observations: [event] });
    for (const version of [1, 2, 3]) assert.throws(() => parseEnvelope({ version, sourceId, observations: [event] }), /version [24]/);
  }
  assert.match(encodeEnvelope(sourceId, [observation(legacyRead)]), /^\{"version":3,/);
});

test("new evidence validates safe portions, hashes, status combinations and coverage counts", () => {
  const meta = inferredRead.toolRead;
  for (const evidence of [
    { ...inferredRead, toolRead: undefined },
    { ...inferredRead, outcome: "unknown" },
    { ...legacyRead, toolRead: meta },
    { ...inferredRead, mechanism: "fanotify" },
    { ...inferredRead, toolRead: { ...meta, requested: { kind: "lines", start: 0, count: 1 } } },
    { ...inferredRead, toolRead: { ...meta, requested: { kind: "lines", start: 1, count: -1 } } },
    { ...inferredRead, toolRead: { ...meta, requested: { kind: "lines", start: Number.MAX_SAFE_INTEGER, count: 2 } } },
    { ...inferredRead, toolRead: { ...meta, revision: { kind: "known", value: "PRIVATE_RAW_REVISION" } } },
    { ...inferredRead, access: "attempt", outcome: "unknown", toolRead: { ...meta, delivery: { kind: "known", returned: { kind: "whole" }, truncated: false } } },
    { ...coverage, recognition: { kind: "recognized", resourceCount: 129 } },
    { ...coverage, recognition: { kind: "opaque", reason: "PRIVATE_ERROR" } },
  ]) assert.throws(() => parseObservation({ ...observation(coverage), evidence }), /Invalid observation/);
  const known = observation({ ...inferredRead, toolRead: { ...meta, revision: { kind: "known", value: `sha256:${"f".repeat(64)}` } } });
  assert.deepEqual(parseObservation(known), known);
});

test("canonical new metadata excludes nested content and wire validation rejects added fields", () => {
  const event = observation(inferredRead);
  const expanded = { ...event, evidence: { ...inferredRead, command: "PRIVATE_COMMAND", toolRead: {
    ...inferredRead.toolRead, requested: { ...inferredRead.toolRead.requested, code: "PRIVATE_CODE" },
    delivery: { kind: "unknown", content: "PRIVATE_OUTPUT" }, revision: { kind: "unknown", value: "PRIVATE_HASH" },
  } } };
  const canonical = parseObservation(expanded);
  assert.deepEqual(canonical, event);
  assert.ok(!serializeObservation(canonical).includes("PRIVATE_"));
  assert.throws(() => parseEnvelope({ version: 4, sourceId, observations: [expanded] }), /Unexpected metadata fields/);
});

test("schema six migration preserves historical payloads, native receipts, outbox and resource foreign keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-tool-migration-"));
  const databasePath = join(directory, "capture.sqlite");
  try {
    const store = openCaptureStore({ databasePath, enrollment });
    const old = observation(legacyRead, "legacy-resource");
    assert.deepEqual(await store.record(old), { accepted: 1, duplicate: 0, dropped: 0 });
    await store.close();
    const original = new DatabaseSync(databasePath);
    removeAnalyticsProjectionSchema(original);
    const saved = original.prepare("SELECT payload FROM resource_events").get()?.payload;
    const outbox = original.prepare("SELECT payload FROM delivery_outbox").get()?.payload;
    original.exec("INSERT INTO native_receipts VALUES ('native:old-receipt', 'preserve-digest')");
    const schema = String(original.prepare("SELECT sql FROM sqlite_master WHERE name='observations'").get()?.sql);
    const indexes = original.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='observations' AND sql IS NOT NULL").all();
    original.exec("PRAGMA foreign_keys=OFF");
    original.exec(schema.replace(/CREATE TABLE "?observations"?/, "CREATE TABLE observations_v6").replace(", 'tool-coverage'", ""));
    original.exec("INSERT INTO observations_v6 SELECT * FROM observations; DROP TABLE observations; ALTER TABLE observations_v6 RENAME TO observations");
    for (const index of indexes) original.exec(String(index.sql));
    original.exec("PRAGMA user_version=6; PRAGMA foreign_keys=ON");
    original.close();
    const before = new DatabaseSync(databasePath);
    assert.ok(!String(before.prepare("SELECT sql FROM sqlite_master WHERE name='observations'").get()?.sql).includes("tool-coverage"));
    before.close();
    const upgraded = openHotplateStore({ databasePath });
    assert.deepEqual(await upgraded.record(observation(coverage)), { accepted: 1, duplicate: 0, dropped: 0 });
    assert.equal((await upgraded.queryResources({})).rows[0]?.successfulReadCount, 1);
    await upgraded.close();
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 10);
    assert.equal(db.prepare("SELECT payload FROM resource_events WHERE observation_id='legacy-resource'").get()?.payload, saved);
    assert.equal(db.prepare("SELECT payload FROM delivery_outbox").get()?.payload, outbox);
    assert.equal(db.prepare("SELECT protocol_version FROM delivery_outbox").get()?.protocol_version, 3);
    assert.equal(db.prepare("SELECT digest FROM native_receipts WHERE id='native:old-receipt'").get()?.digest, "preserve-digest");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('observations_evidence_time_idx','observations_sequence_lookup_idx')").get()?.n, 2);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new capture receipts deduplicate aliases and retry timestamps without changing legacy receipt identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-tool-receipts-"));
  const env = { HOTPLATE_DB: join(directory, "capture.sqlite") };
  try {
    const old = fact(legacyRead);
    const oldIdentity = [old.host, old.sessionId, old.actorId, old.occurrenceId, old.evidence.kind, resource.filesystemId, resource.canonicalPath, resource.observedPath];
    const oldId = `native:${createHash("sha256").update(JSON.stringify(oldIdentity)).digest("hex")}`;
    assert.equal((await captureFact({ fact: old, env })).kind, "recorded");
    assert.deepEqual(await captureFact({ fact: { ...old, observedAt: "2026-10-19T01:00:00.000Z" }, env }), { kind: "recorded", accepted: 0, duplicate: 1, dropped: 0 });
    const input = fact(inferredRead);
    assert.deepEqual(await captureFact({ fact: input, env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    const alias = { ...inferredRead, resource: { ...resource, observedPath: "/skills/example/references/alias.md" } };
    assert.deepEqual(await captureFact({ fact: { ...input, observedAt: "2026-10-19T02:00:00.000Z", evidence: alias }, env }), { kind: "recorded", accepted: 0, duplicate: 1, dropped: 0 });
    assert.deepEqual(await captureFact({ fact: { ...input, actorId: "second-actor" }, env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    const db = new DatabaseSync(env.HOTPLATE_DB);
    assert.equal(db.prepare("SELECT id FROM native_receipts WHERE id=?").get(oldId)?.id, oldId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations").get()?.n, 3);
    db.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool evidence survives relay, aggregate reopen and scoped content analytics without watcher events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-tool-relay-"));
  const databasePath = join(directory, "capture.sqlite");
  const aggregatePath = join(directory, "aggregate.sqlite");
  try {
    const store = openCaptureStore({ databasePath, enrollment });
    const events = [observation(inferredRead), observation(coverage)];
    assert.deepEqual(await store.record(events), { accepted: 2, duplicate: 0, dropped: 0 });
    await store.close();
    const opened = openRelayStore({ databasePath, enrollment });
    assert.ok(opened.kind === "ready");
    const pending = await opened.store.selectPending({ maxCount: 100, maxPayloadBytes: 1_000_000, maxVersion: 5 });
    const ready = pending.flatMap(item => item.kind === "ready" ? [item.observation] : []);
    assert.deepEqual(ready, events);
    const envelope = parseEnvelope(JSON.parse(encodeEnvelope(sourceId, ready)));
    const aggregate = openAggregateStore({ databasePath: aggregatePath });
    assert.deepEqual(await aggregate.ingest({ source: { sourceId, machineId }, observations: envelope.observations }), { kind: "committed", accepted: 2, duplicate: 0 });
    assert.deepEqual(await aggregate.ingest({ source: { sourceId, machineId }, observations: envelope.observations }), { kind: "committed", accepted: 0, duplicate: 2 });
    await aggregate.close();
    await opened.store.close();
    const read = openHotplateReadStore({ databasePath: aggregatePath });
    assert.ok(read.kind === "ready");
    assert.equal((await read.store.queryResources({})).rows[0]?.inferredReadCount, 1);
    const query = { content: "both", measure: "toolActivity", split: "agent", selection: { kind: "all" }, filter: {} } as const;
    const report = await read.store.queryContentAnalytics(query);
    assert.equal(report.displayed.count, 1);
    assert.equal(report.displayed.counts.inferredReads, 1);
    assert.equal(report.displayed.counts.successfulReads, 0);
    assert.equal(report.coverage.displayed.opaqueOperations, 1);
    const other = await read.store.queryContentAnalytics({ ...query, filter: { sessionId: "different" } });
    assert.equal(other.displayed.count, 0);
    assert.equal(other.coverage.displayed.opaqueOperations, 0);
    await read.store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("version five carries script executions while older envelopes and malformed executions are refused", () => {
  for (const evidence of [execution, { ...execution, outcome: "unknown" } satisfies ResourceAccessEvidence]) {
    const event = observation(evidence);
    const encoded = encodeEnvelope(sourceId, [event, observation(inferredRead, "inferred")]);
    assert.match(encoded, /^\{"version":5,/);
    assert.deepEqual(parseEnvelope(JSON.parse(encoded)).observations[0], event);
    for (const version of [1, 2, 3, 4]) assert.throws(() => parseEnvelope({ version, sourceId, observations: [event] }), /version 5/);
  }
  assert.match(encodeEnvelope(sourceId, [observation(inferredRead)]), /^\{"version":4,/);
  for (const evidence of [
    { ...execution, outcome: "error" },
    { ...execution, toolRead: inferredRead.toolRead },
    { ...execution, mechanism: "fanotify", outcome: "unknown" },
  ]) assert.throws(() => parseObservation({ ...observation(coverage), evidence }), /Invalid observation/);
});

test("a read and an execution of one file in one operation keep distinct receipts and separate counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-tool-execution-"));
  const databasePath = join(directory, "capture.sqlite");
  const aggregatePath = join(directory, "aggregate.sqlite");
  const env = { HOTPLATE_DB: databasePath };
  try {
    const read = { ...inferredRead, resource: execution.resource };
    assert.deepEqual(await captureFact({ fact: fact(read), env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    assert.deepEqual(await captureFact({ fact: fact(execution), env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    assert.deepEqual(await captureFact({ fact: { ...fact(execution), observedAt: "2026-10-19T03:00:00.000Z" }, env }), { kind: "recorded", accepted: 0, duplicate: 1, dropped: 0 });
    const local = openHotplateReadStore({ databasePath });
    assert.ok(local.kind === "ready");
    const [row] = (await local.store.queryResources({})).rows;
    assert.deepEqual([row?.inferredReadCount, row?.executeCount, row?.attemptCount, row?.successfulReadCount], [1, 1, 0, 0]);
    await local.store.close();
    const aggregate = openAggregateStore({ databasePath: aggregatePath });
    const events = [observation(read, "read"), observation(execution, "execute")];
    const envelope = parseEnvelope(JSON.parse(encodeEnvelope(sourceId, events)));
    assert.deepEqual(await aggregate.ingest({ source: { sourceId, machineId }, observations: envelope.observations }), { kind: "committed", accepted: 2, duplicate: 0 });
    await aggregate.close();
    const reader = openHotplateReadStore({ databasePath: aggregatePath });
    assert.ok(reader.kind === "ready");
    try {
      assert.equal((await reader.store.queryResources({})).rows[0]?.executeCount, 1);
      const query = { content: "resources", measure: "executions", split: "agent", selection: { kind: "all" }, filter: {} } as const;
      const report = await reader.store.queryContentAnalytics(query);
      assert.equal(report.overall.count, 1);
      assert.deepEqual([report.overall.counts.executions, report.overall.counts.inferredReads, report.overall.counts.readAttempts], [1, 1, 0]);
      assert.equal((await reader.store.queryContentAnalytics({ ...query, measure: "toolActivity" })).overall.count, 2);
      assert.equal((await reader.store.queryContentAnalytics({ ...query, measure: "inferredReads" })).overall.count, 1);
    } finally { await reader.store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("receiver capabilities cap at this build's protocol and default older receivers to version four", () => {
  assert.equal(parseProtocolCapabilities({ ok: true }), 4);
  assert.equal(parseProtocolCapabilities({ ok: true, protocol: { versions: [1, 2, 3, 4] } }), 4);
  assert.equal(parseProtocolCapabilities({ ok: true, protocol: { versions: [1, 2, 3, 4, 5, 6] } }), 5);
  for (const value of [{ ok: false }, { ok: true, protocol: { versions: [6] } }, { ok: true, protocol: { versions: "5" } }, null]) {
    assert.throws(() => parseProtocolCapabilities(value), /protocol capabilities|Expected object/);
  }
});
