import type { HostId, CaptureEnrollment, CollectorOrigin, Evidence, GapReason, InputSource, MachineId, ModelRef, Observation, SegmentReason, SkillRef, SourceId, SourceIdentity } from "./domain.js";
import { posix, win32 } from "node:path";
import type { ReadDelivery, ReadPortion, ResourceEvidence, ResourceLocation, ToolReadMetadata } from "./resource-domain.js";

export const LOCAL_MACHINE_ID = parseMachineId("local");
export const LOCAL_SOURCE_ID = "local";
export const LOCAL_IDENTITY: { machineId: MachineId; sourceId: typeof LOCAL_SOURCE_ID } = {
  machineId: LOCAL_MACHINE_ID, sourceId: LOCAL_SOURCE_ID,
};

export function parseMachineId(value: unknown): MachineId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Invalid machine identity");
  }
  return value as MachineId;
}

export function parseSourceId(value: unknown): SourceId {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Source identity must be a UUID");
  }
  return value.toLowerCase() as SourceId;
}

export function parseCollectorOrigin(value: unknown): CollectorOrigin {
  if (typeof value !== "string") throw new Error("Invalid collector origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid collector origin"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("Collector origin must be a canonical HTTP(S) origin without credentials or a path");
  }
  return url.origin as CollectorOrigin;
}

export function validateEnrollment(enrollment: CaptureEnrollment): CaptureEnrollment {
  return { sourceId: parseSourceId(enrollment.sourceId), collectorOrigin: parseCollectorOrigin(enrollment.collectorOrigin) };
}

export function validateNetworkIdentity(source: SourceIdentity): SourceIdentity {
  const machineId = parseMachineId(source.machineId);
  if (machineId === LOCAL_MACHINE_ID) throw new Error("Reserved local identity cannot ingest network observations");
  return { machineId, sourceId: parseSourceId(source.sourceId) };
}

export function parseObservation(value: unknown): Observation {
  if (!isObservation(value)) throw new Error("Invalid observation");
  return copyObservation(value);
}

// Construct a fresh metadata-only value. Input objects can contain extra properties or toJSON methods.
export function serializeObservation(observation: Observation): string {
  return JSON.stringify(copyObservation(observation));
}

function copySkill(skill: SkillRef): SkillRef {
  return { name: skill.name, canonicalPath: skill.canonicalPath, version: skill.version };
}

function copyEvidence(evidence: Evidence): Evidence {
  switch (evidence.kind) {
    case "command-intent": return { kind: evidence.kind, skillName: evidence.skillName, source: evidence.source };
    case "wrapper-observed": return { kind: evidence.kind, skill: copySkill(evidence.skill), wrapperSource: evidence.wrapperSource };
    case "read-attempt": return { kind: evidence.kind, skill: copySkill(evidence.skill), toolCallId: evidence.toolCallId, model: evidence.model === null ? null : { provider: evidence.model.provider, id: evidence.model.id } };
    case "skill-invocation": return {
      kind: evidence.kind, skill: { name: evidence.skill.name, canonicalPath: evidence.skill.canonicalPath, version: evidence.skill.version },
      toolCallId: evidence.toolCallId, outcome: evidence.outcome, model: evidence.model === null ? null : { provider: evidence.model.provider, id: evidence.model.id },
    };
    case "read-result": return {
      kind: evidence.kind, skill: copySkill(evidence.skill), toolCallId: evidence.toolCallId, outcome: evidence.outcome,
      model: evidence.model === null ? null : { provider: evidence.model.provider, id: evidence.model.id },
    };
    case "catalog-snapshot": return { kind: evidence.kind, skills: Array.from(evidence.skills, copySkill) };
    case "capture-gap": return { kind: evidence.kind, dropped: evidence.dropped, reason: evidence.reason };
    case "resource-access": {
      const base = {
        kind: evidence.kind, resource: copyResource(evidence.resource), operationId: evidence.operationId,
        mechanism: evidence.mechanism, access: evidence.access, outcome: evidence.outcome,
        model: evidence.model === null ? null : { provider: evidence.model.provider, id: evidence.model.id },
        process: evidence.process === null ? null : { bootId: evidence.process.bootId, pid: evidence.process.pid, startTicks: evidence.process.startTicks },
        attribution: evidence.attribution,
      };
      if (evidence.mechanism === "fanotify") return { ...base, mechanism: evidence.mechanism, access: evidence.access, outcome: evidence.outcome };
      const metadata = evidence.toolRead === undefined ? {} : { toolRead: copyToolRead(evidence.toolRead) };
      switch (evidence.access) {
        case "read": return { ...base, mechanism: evidence.mechanism, access: evidence.access, outcome: evidence.outcome,
          ...(evidence.toolRead === undefined ? {} : { toolRead: { ...copyToolRead(evidence.toolRead), kind: "structured-read" } }) };
        case "attempt": return { ...base, mechanism: evidence.mechanism, access: evidence.access, outcome: evidence.outcome, ...metadata };
        case "inferred-read": return { ...base, mechanism: evidence.mechanism, access: evidence.access, outcome: evidence.outcome,
          toolRead: { ...copyToolRead(evidence.toolRead), kind: "literal-command" } };
        default: { const exhaustive: never = evidence; return exhaustive; }
      }
    }
    case "tool-coverage": return {
      kind: evidence.kind, operationId: evidence.operationId, family: evidence.family, outcome: evidence.outcome,
      model: evidence.model === null ? null : { provider: evidence.model.provider, id: evidence.model.id },
      recognition: evidence.recognition.kind === "recognized"
        ? { kind: evidence.recognition.kind, resourceCount: evidence.recognition.resourceCount }
        : { kind: evidence.recognition.kind, reason: evidence.recognition.reason },
    };
    case "inventory-snapshot": {
      const base = { kind: evidence.kind, scanId: evidence.scanId, filesystemId: evidence.filesystemId, rootPath: evidence.rootPath, origin: evidence.origin, scope: evidence.scope };
      switch (evidence.phase) {
        case "started": return { ...base, phase: evidence.phase, resources: [], error: null };
        case "batch": return { ...base, phase: evidence.phase, resources: Array.from(evidence.resources, copyResource), batchIndex: evidence.batchIndex, error: null };
        case "complete": return { ...base, phase: evidence.phase, resources: [], batchCount: evidence.batchCount, error: null };
        case "incomplete": return { ...base, phase: evidence.phase, resources: [], batchCount: evidence.batchCount, error: evidence.error };
        default: { const exhaustive: never = evidence; return exhaustive; }
      }
    }
    case "observer-coverage": {
      const base = { kind: evidence.kind, observerId: evidence.observerId, mechanism: evidence.mechanism, filesystemId: evidence.filesystemId, rootPaths: Array.from(evidence.rootPaths), heartbeatMs: evidence.heartbeatMs };
      return evidence.reason === null ? { ...base, status: evidence.status, reason: null }
        : { ...base, status: evidence.status, reason: evidence.reason };
    }
    default: { const exhaustive: never = evidence; return exhaustive; }
  }
}

function copyPortion(portion: ReadPortion): ReadPortion {
  return portion.kind === "lines" ? { kind: portion.kind, start: portion.start, count: portion.count } : { kind: portion.kind };
}
function copyToolRead(metadata: ToolReadMetadata): ToolReadMetadata {
  return { kind: metadata.kind, requested: copyPortion(metadata.requested),
    delivery: metadata.delivery.kind === "unknown" ? { kind: "unknown" }
      : { kind: "known", returned: copyPortion(metadata.delivery.returned), truncated: metadata.delivery.truncated },
    revision: metadata.revision.kind === "unknown" ? { kind: "unknown" } : { kind: "known", value: metadata.revision.value } };
}

export function requiresToolProtocol4(evidence: Evidence): boolean {
  return evidence.kind === "tool-coverage" || (evidence.kind === "resource-access"
    && (evidence.access === "inferred-read" || evidence.toolRead !== undefined));
}

function copyResource(resource: ResourceLocation): ResourceLocation {
  return { filesystemId: resource.filesystemId, canonicalPath: resource.canonicalPath, observedPath: resource.observedPath, rootPath: resource.rootPath, kind: resource.kind, ownerSkillPath: resource.ownerSkillPath };
}

function copyObservation(observation: Observation): Observation {
  const scope = observation.scope;
  return {
    id: observation.id, producerId: observation.producerId, sequence: observation.sequence, observedAt: observation.observedAt,
    scope: {
      projectCwd: scope.projectCwd, sessionId: scope.sessionId, sessionFile: scope.sessionFile,
      segmentId: scope.segmentId, segmentReason: scope.segmentReason, runId: scope.runId,
      turnId: scope.turnId, leafId: scope.leafId,
    },
    evidence: copyEvidence(observation.evidence),
    ...(observation.host === undefined ? {} : { host: observation.host }),
  };
}

export function isObservation(value: unknown): value is Observation {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.producerId)) return false;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return false;
  if (!isNonEmptyString(value.observedAt) || !isRecord(value.scope)) return false;
  if (value.host !== undefined && !isHostId(value.host)) return false;
  if (isRecord(value.evidence) && (value.evidence.kind === "skill-invocation" || value.evidence.kind === "read-attempt") && value.host === undefined) return false;
  const scope = value.scope;
  if (!isNonEmptyString(scope.projectCwd) || !isNullableString(scope.sessionId) || !isNullableString(scope.sessionFile)
    || !isNonEmptyString(scope.segmentId) || !isSegmentReason(scope.segmentReason) || !isNullableString(scope.runId)
    || !isNullableString(scope.turnId) || !isNullableString(scope.leafId)) return false;
  return isEvidence(value.evidence);
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "command-intent": return isNonEmptyString(value.skillName) && isInputSource(value.source);
    case "wrapper-observed": return isSkillRef(value.skill) && (value.wrapperSource === "expanded-prompt" || value.wrapperSource === "unknown-pasted-or-transformed");
    case "read-attempt": return isSkillRef(value.skill) && isNonEmptyString(value.toolCallId) && isModelRef(value.model);
    case "skill-invocation": return isRecord(value.skill) && isNonEmptyString(value.skill.name) && isNullableString(value.skill.canonicalPath) && isNullableString(value.skill.version) && isNonEmptyString(value.toolCallId) && (value.outcome === "success" || value.outcome === "error") && isModelRef(value.model);
    case "read-result": return isSkillRef(value.skill) && isNonEmptyString(value.toolCallId) && (value.outcome === "success" || value.outcome === "error") && isModelRef(value.model);
    case "catalog-snapshot": return Array.isArray(value.skills) && Array.prototype.every.call(value.skills, isSkillRef);
    case "capture-gap": return typeof value.dropped === "number" && Number.isSafeInteger(value.dropped) && value.dropped >= 0 && isGapReason(value.reason);
    case "resource-access":
    case "tool-coverage":
    case "inventory-snapshot":
    case "observer-coverage": return isResourceEvidence(value);
    default: return false;
  }
}

export function isResourceEvidence(value: unknown): value is ResourceEvidence {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "resource-access":
      return isResourceLocation(value.resource) && metadataString(value.operationId)
        && ((value.mechanism === "fanotify" && (value.access === "open" || value.access === "access") && value.outcome === "unknown" && value.toolRead === undefined)
          || (value.mechanism === "host-tool" && ((value.access === "attempt" && value.outcome === "unknown")
            || (value.access === "read" && (value.outcome === "success" || value.outcome === "error"))
            || (value.access === "inferred-read" && value.outcome === "success" && isToolReadMetadata(value.toolRead) && value.toolRead.kind === "literal-command"))
            && (value.toolRead === undefined || (isToolReadMetadata(value.toolRead)
              && (value.access !== "read" || value.toolRead.kind === "structured-read")
              && (value.outcome === "success" || value.toolRead.delivery.kind === "unknown")))))
        && isModelRef(value.model) && (value.process === null || (isRecord(value.process)
          && metadataString(value.process.bootId) && typeof value.process.pid === "number" && Number.isSafeInteger(value.process.pid) && value.process.pid > 0
          && typeof value.process.startTicks === "string" && /^\d{1,30}$/.test(value.process.startTicks)))
        && (value.attribution === "session" || value.attribution === "harness" || value.attribution === "non-agent" || value.attribution === "unknown");
    case "tool-coverage":
      return metadataString(value.operationId) && (value.family === "file" || value.family === "shell" || value.family === "python" || value.family === "other")
        && (value.outcome === "success" || value.outcome === "error" || value.outcome === "unknown") && isModelRef(value.model)
        && isRecord(value.recognition) && ((value.recognition.kind === "recognized" && nonnegativeInteger(value.recognition.resourceCount) && value.recognition.resourceCount <= 128)
          || (value.recognition.kind === "opaque" && (value.recognition.reason === "unsupported-syntax" || value.recognition.reason === "missing-input"
            || value.recognition.reason === "unsupported-tool" || value.recognition.reason === "limit")));
    case "inventory-snapshot": {
      if (!metadataString(value.scanId) || !metadataString(value.filesystemId) || !absolutePath(value.rootPath)
        || (value.origin !== "configured" && value.origin !== "conventional" && value.origin !== "host")
        || (value.scope !== "account" && value.scope !== "project" && value.scope !== "session" && value.scope !== "unassigned")
        || !Array.isArray(value.resources) || value.resources.length > 2000) return false;
      switch (value.phase) {
        case "started": return value.error === null && value.resources.length === 0;
        case "batch": return value.error === null && nonnegativeInteger(value.batchIndex)
          && Array.from(value.resources).every(item => isResourceLocation(item) && item.filesystemId === value.filesystemId && item.rootPath === value.rootPath);
        case "complete": return value.error === null && value.resources.length === 0 && nonnegativeInteger(value.batchCount);
        case "incomplete": return value.resources.length === 0 && nonnegativeInteger(value.batchCount)
          && (value.error === "unreadable" || value.error === "missing" || value.error === "limit" || value.error === "cancelled" || value.error === "io-error");
        default: return false;
      }
    }
    case "observer-coverage":
      return metadataString(value.observerId) && metadataString(value.filesystemId)
        && (value.mechanism === "host-tool" || value.mechanism === "fanotify")
        && Array.isArray(value.rootPaths) && value.rootPaths.length > 0 && value.rootPaths.length <= 2000 && Array.from(value.rootPaths).every(absolutePath)
        && typeof value.heartbeatMs === "number" && Number.isSafeInteger(value.heartbeatMs) && value.heartbeatMs >= 100 && value.heartbeatMs <= 300_000
        && (((value.status === "active" || value.status === "stopped") && value.reason === null)
          || ((value.status === "unavailable" || value.status === "overflow")
            && (value.reason === "permission-denied" || value.reason === "unsupported" || value.reason === "helper-unavailable"
              || value.reason === "queue-overflow" || value.reason === "process-exited" || value.reason === "io-error")));
    default: return false;
  }
}

export function isReadPortion(value: unknown): value is ReadPortion {
  return isRecord(value) && (value.kind === "unknown" || value.kind === "whole"
    || (value.kind === "lines" && nonnegativeInteger(value.start) && value.start >= 1
      && (value.count === null || (nonnegativeInteger(value.count) && Number.isSafeInteger(value.start + Math.max(value.count - 1, 0))))));
}
export function isReadDelivery(value: unknown): value is ReadDelivery {
  return isRecord(value) && (value.kind === "unknown" || (value.kind === "known" && isReadPortion(value.returned) && typeof value.truncated === "boolean"));
}
function isToolReadMetadata(value: unknown): value is ToolReadMetadata {
  return isRecord(value) && (value.kind === "structured-read" || value.kind === "literal-command")
    && isReadPortion(value.requested) && isReadDelivery(value.delivery) && isRecord(value.revision)
    && (value.revision.kind === "unknown" || (value.revision.kind === "known" && typeof value.revision.value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.revision.value)));
}

export function isResourceLocation(value: unknown): value is ResourceLocation {
  return isRecord(value) && metadataString(value.filesystemId) && absolutePath(value.canonicalPath)
    && absolutePath(value.observedPath) && absolutePath(value.rootPath)
    && (value.ownerSkillPath === null || absolutePath(value.ownerSkillPath))
    && (value.kind === "skill" || value.kind === "principle" || value.kind === "reference" || value.kind === "script" || value.kind === "file");
}
function metadataString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
}
function absolutePath(value: unknown): value is string {
  return metadataString(value) && (posix.isAbsolute(value) ? posix.normalize(value) === value : win32.isAbsolute(value) && win32.normalize(value) === value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSkillRef(value: unknown): value is SkillRef {
  return isRecord(value) && isNonEmptyString(value.name) && isNonEmptyString(value.canonicalPath) && isNullableString(value.version);
}
function isModelRef(value: unknown): value is ModelRef {
  return value === null || (isRecord(value) && isNonEmptyString(value.provider) && isNonEmptyString(value.id));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
export function isInputSource(value: unknown): value is InputSource { return value === "interactive" || value === "rpc" || value === "extension"; }
function isSegmentReason(value: unknown): value is SegmentReason {
  return value === "startup" || value === "reload" || value === "new" || value === "resume" || value === "fork" || value === "branch" || value === "unknown";
}
export function isGapReason(value: unknown): value is GapReason {
  return value === "queue-overflow" || value === "db-busy" || value === "db-error" || value === "shutdown-deadline" || value === "invalid-observation";
}

export function isHostId(value: unknown): value is HostId { return value === "pi" || value === "codex" || value === "claude-code" || value === "opencode-v1" || value === "opencode-v2" || value === "unknown"; }
export function parseHostId(value: unknown): HostId { if (!isHostId(value)) throw new Error("Invalid agent host"); return value; }

export function validateObservationMetadata(raw: unknown, observation: Observation): void {
  strictMetadata(raw, observation);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observation.observedAt)
    || !Number.isFinite(Date.parse(observation.observedAt)) || new Date(observation.observedAt).toISOString() !== observation.observedAt) {
    throw new Error("Invalid timestamp");
  }
}

function strictMetadata(raw: unknown, canonical: unknown): void {
  if (typeof canonical === "string") {
    if (Buffer.byteLength(canonical) > 8192) throw new Error("Metadata string too long");
    return;
  }
  if (Array.isArray(canonical)) {
    if (!Array.isArray(raw) || canonical.length > 2000) throw new Error("Catalog too large");
    canonical.forEach((item: unknown, i: number) => strictMetadata(raw[i], item));
    return;
  }
  if (canonical !== null && typeof canonical === "object") {
    const expected = canonical;
    if (!isRecord(raw)) throw new Error("Expected metadata object");
    const input = raw;
    if (Object.keys(input).length !== Object.keys(expected).length || Object.keys(input).some(key => !Object.keys(expected).includes(key))) throw new Error("Unexpected metadata fields");
    for (const [key, value] of Object.entries(expected)) strictMetadata(input[key], value);
  }
}
