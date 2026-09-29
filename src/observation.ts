import type { HostId, CaptureEnrollment, CollectorOrigin, Evidence, GapReason, InputSource, MachineId, ModelRef, Observation, SegmentReason, SkillRef, SourceId, SourceIdentity } from "./domain.js";

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
    default: { const exhaustive: never = evidence; return exhaustive; }
  }
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
    default: return false;
  }
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
