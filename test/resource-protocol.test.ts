import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/domain.js";
import { encodeEnvelope, parseEnvelope } from "../src/network-protocol.js";
import { parseObservation, parseSourceId, serializeObservation } from "../src/observation.js";

const sourceId = parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const observation: Observation = {
  id: "resource-observation", producerId: "observer", sequence: 0, observedAt: "2026-10-18T00:00:00.000Z",
  scope: { projectCwd: "/project", sessionId: null, sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null },
  evidence: { kind: "resource-access", resource: { filesystemId: "linux:machine", canonicalPath: "/skills/reference.md", observedPath: "/skills/reference.md", rootPath: "/skills", kind: "reference", ownerSkillPath: null }, operationId: "operation", mechanism: "fanotify", access: "open", outcome: "unknown", model: null, process: { bootId: "boot", pid: 1234, startTicks: "999" }, attribution: "unknown" },
};

test("resource evidence uses protocol three and is rejected in older envelopes", () => {
  const encoded = encodeEnvelope(sourceId, [observation]);
  const envelope: unknown = JSON.parse(encoded);
  assert.match(encoded, /^\{"version":3,/);
  assert.deepEqual(parseEnvelope(envelope), { sourceId, observations: [observation] });
  for (const version of [1, 2]) assert.throws(() => parseEnvelope({ version, sourceId, observations: [observation] }), /version 3/);
});

test("legacy version one and host version two retain their exact serialization", () => {
  const legacy: Observation = { ...observation, evidence: { kind: "catalog-snapshot", skills: [] } };
  for (const [version, event] of [[1, legacy], [2, { ...legacy, host: "codex" }]] as const) {
    assert.equal(encodeEnvelope(sourceId, [event]), `{"version":${version},"sourceId":${JSON.stringify(sourceId)},"observations":[${serializeObservation(event)}]}`);
    assert.deepEqual(parseEnvelope(JSON.parse(encodeEnvelope(sourceId, [event]))), { sourceId, observations: [event] });
  }
});

test("resource serialization excludes arbitrary content while wire parsing rejects it", () => {
  if (observation.evidence.kind !== "resource-access") throw new Error("Expected resource fixture");
  const expanded = { ...observation, evidence: { ...observation.evidence, content: "private document body", resource: { ...observation.evidence.resource, fileContent: "secret" } } };
  const serialized = serializeObservation(expanded);
  assert.ok(!serialized.includes("private document body"));
  assert.ok(!serialized.includes("secret"));
  assert.deepEqual(JSON.parse(serialized), observation);
  assert.throws(() => parseEnvelope({ version: 3, sourceId, observations: [expanded] }), /Unexpected metadata fields/);
});

test("resource boundary rejects invalid process identity, paths, and fabricated read success", () => {
  if (observation.evidence.kind !== "resource-access") throw new Error("Expected resource fixture");
  for (const evidence of [
    { ...observation.evidence, process: { bootId: "boot", pid: -1, startTicks: "1" } },
    { ...observation.evidence, process: { bootId: "boot", pid: 100, startTicks: "not-ticks" } },
    { ...observation.evidence, resource: { ...observation.evidence.resource, canonicalPath: "/skills/../outside.md" } },
    { ...observation.evidence, access: "read", outcome: "success" },
    { ...observation.evidence, resource: { ...observation.evidence.resource, rootPath: "relative" } },
  ]) assert.throws(() => parseObservation({ ...observation, evidence }), /Invalid observation/);
});

test("inventory wire objects require matching namespaces and complete-scan batch counts", () => {
  if (observation.evidence.kind !== "resource-access") throw new Error("Expected resource fixture");
  const base = { kind: "inventory-snapshot", scanId: "scan", filesystemId: "linux:machine", rootPath: "/skills", origin: "configured", scope: "project" };
  for (const evidence of [
    { ...base, phase: "complete", resources: [], error: null },
    { ...base, phase: "batch", resources: [{ ...observation.evidence.resource, filesystemId: "other" }], batchIndex: 0, error: null },
    { ...base, phase: "incomplete", resources: [], batchCount: 0, error: "raw operating system exception" },
  ]) assert.throws(() => parseObservation({ ...observation, evidence }), /Invalid observation/);
});

test("unassigned inventory survives relay without claiming project or session availability", () => {
  const event: Observation = { ...observation, evidence: { kind: "inventory-snapshot", scanId: "scan", filesystemId: "linux:machine",
    rootPath: "/skills", origin: "host", scope: "unassigned", phase: "started", resources: [], error: null } };
  assert.deepEqual(parseEnvelope(JSON.parse(encodeEnvelope(sourceId, [event]))), { sourceId, observations: [event] });
});
