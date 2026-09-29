import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeEnvelope, parseEnvelope } from "../src/network-protocol.js";
import { parseSourceId, serializeObservation } from "../src/observation.js";
import type { Observation } from "../src/domain.js";

const legacy: Observation = { id: "id", producerId: "producer", sequence: 0, observedAt: "2026-01-01T00:00:00.000Z", scope: { projectCwd: "/project", sessionId: null, sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null }, evidence: { kind: "command-intent", skillName: "test", source: "interactive" } };
const sourceId = parseSourceId("11111111-1111-4111-8111-111111111111");
test("legacy protocol bytes remain v1 and explicit host metadata uses v2", () => {
  const old = encodeEnvelope(sourceId, [legacy]);
  assert.equal(old, `{"version":1,"sourceId":"${sourceId}","observations":[${serializeObservation(legacy)}]}`);
  assert.deepEqual(parseEnvelope(JSON.parse(old)).observations, [legacy]);
  const tagged = { ...legacy, host: "codex" } satisfies Observation;
  const current = encodeEnvelope(sourceId, [tagged]);
  assert.equal(JSON.parse(current).version, 2);
  assert.deepEqual(parseEnvelope(JSON.parse(current)).observations, [tagged]);
  assert.throws(() => parseEnvelope({ ...JSON.parse(current), version: 1 }));
});
test("v2 preserves name-only native invocation without treating it as a read", () => {
  const observation: Observation = { ...legacy, host: "opencode-v2", evidence: { kind: "skill-invocation", skill: { name: "test", canonicalPath: null, version: null }, toolCallId: "tool", outcome: "error", model: null } };
  assert.deepEqual(parseEnvelope(JSON.parse(encodeEnvelope(sourceId, [observation]))).observations, [observation]);
});

test("schema v3 upgrade preserves legacy payload bytes and accepts mixed outbox versions", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { openCaptureStore } = await import("../src/store.js");
  const { parseCollectorOrigin } = await import("../src/observation.js");
  const dir = await mkdtemp(join(tmpdir(), "hotplate-migration-"));
  const databasePath = join(dir, "capture.sqlite");
  const enrollment = { sourceId, collectorOrigin: parseCollectorOrigin("https://collector.example") };
  try {
    const original = openCaptureStore({ databasePath, enrollment });
    await original.record(legacy);
    await original.close();
    const old = new DatabaseSync(databasePath);
    const payload = old.prepare("SELECT payload FROM delivery_outbox").get()?.payload;
    old.exec("DROP INDEX observations_scope_idx; DROP INDEX observations_skill_idx; DROP INDEX observations_model_idx; ALTER TABLE observations DROP COLUMN host");
    old.exec("ALTER TABLE catalog_skills RENAME TO catalog_new");
    old.exec("CREATE TABLE catalog_skills (machine_id TEXT NOT NULL, source_id TEXT NOT NULL, project_cwd TEXT NOT NULL, skill_name TEXT NOT NULL, skill_path TEXT NOT NULL, skill_version TEXT, first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, PRIMARY KEY(machine_id, source_id, project_cwd, skill_name, skill_path)) STRICT; DROP TABLE catalog_new; DROP TABLE native_receipts; PRAGMA user_version = 3");
    old.close();
    const upgraded = openCaptureStore({ databasePath, enrollment });
    await upgraded.record({ ...legacy, id: "native-host", producerId: "native-host", host: "codex" });
    await upgraded.close();
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("SELECT payload FROM delivery_outbox WHERE observation_id = ?").get(legacy.id)?.payload, payload);
    const rows = db.prepare("SELECT payload FROM delivery_outbox ORDER BY observation_id").all();
    assert.equal(rows.length, 2);
    assert.equal(db.prepare("SELECT host FROM observations WHERE id = ?").get(legacy.id)?.host, "unknown");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
