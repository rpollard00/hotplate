import { createHash } from "node:crypto";
import type { Observation, SourceId } from "./domain.js";
import { observationProtocolVersion, parseObservation, type ProtocolVersion, parseSourceId, serializeObservation, validateObservationMetadata } from "./observation.js";

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_OBSERVATIONS = 100;
export const REQUEST_DEADLINE_MS = 10_000;
const ENVELOPE_OVERHEAD_BYTES = 1024;
export const MAX_PAYLOAD_BYTES = MAX_ENVELOPE_BYTES - ENVELOPE_OVERHEAD_BYTES;

export const ACCEPTED_PROTOCOL_VERSIONS = [1, 2, 3, 4, 5] as const satisfies readonly ProtocolVersion[];
export const BASELINE_PROTOCOL_VERSION: ProtocolVersion = 4;

export function envelopeVersion(observations: readonly Observation[]): ProtocolVersion {
  return observations.reduce<ProtocolVersion>((version, item) => {
    const required = observationProtocolVersion(item);
    return required > version ? required : version;
  }, 1);
}

export function encodeEnvelope(sourceId: SourceId, observations: readonly Observation[]): string {
  return `{"version":${envelopeVersion(observations)},"sourceId":${JSON.stringify(sourceId)},"observations":[${observations.map(serializeObservation).join(",")}]}`;
}

export function parseEnvelope(value: unknown): { sourceId: SourceId; observations: readonly Observation[] } {
  const envelope = record(value);
  exactKeys(envelope, ["version", "sourceId", "observations"]);
  const version = ACCEPTED_PROTOCOL_VERSIONS.find(item => item === envelope.version);
  if (version === undefined || !Array.isArray(envelope.observations)
    || envelope.observations.length < 1 || envelope.observations.length > MAX_OBSERVATIONS) throw new Error("Invalid envelope");
  const sourceId = parseSourceId(envelope.sourceId);
  const ids = new Set<string>();
  const observations = envelope.observations.map((raw: unknown) => {
    const parsed = parseObservation(raw);
    validateObservationMetadata(raw, parsed);
    const required = observationProtocolVersion(parsed);
    if (required > version) throw new Error(`Observation requires protocol version ${required}`);
    if (ids.has(parsed.id)) throw new Error("Repeated observation identity");
    ids.add(parsed.id);
    return parsed;
  });
  return { sourceId, observations };
}

export function protocolCapabilities(): { ok: true; protocol: { versions: readonly ProtocolVersion[] } } {
  return { ok: true, protocol: { versions: ACCEPTED_PROTOCOL_VERSIONS } };
}

export function parseProtocolCapabilities(value: unknown): ProtocolVersion {
  const input = record(value);
  if (input.ok !== true) throw new Error("Invalid protocol capabilities");
  if (input.protocol === undefined) return BASELINE_PROTOCOL_VERSION;
  const versions = record(input.protocol).versions;
  if (!Array.isArray(versions)) throw new Error("Invalid protocol capabilities");
  const known = ACCEPTED_PROTOCOL_VERSIONS.filter(version => versions.includes(version));
  const max = known.at(-1);
  if (max === undefined) throw new Error("Invalid protocol capabilities");
  return max;
}

export function committedAcknowledgment(args: {
  sourceId: SourceId; observations: readonly Observation[]; accepted: number; duplicate: number;
}): unknown {
  return { version: 1, kind: "committed", sourceId: args.sourceId, observationIds: args.observations.map(item => item.id), accepted: args.accepted, duplicate: args.duplicate };
}

export function validateAcknowledgment(value: unknown, sourceId: SourceId, observations: readonly Observation[]): void {
  const ack = record(value);
  exactKeys(ack, ["version", "kind", "sourceId", "observationIds", "accepted", "duplicate"]);
  if (ack.version !== 1 || ack.kind !== "committed" || ack.sourceId !== sourceId
    || !isCount(ack.accepted) || !isCount(ack.duplicate) || ack.accepted + ack.duplicate !== observations.length
    || !Array.isArray(ack.observationIds) || ack.observationIds.length !== observations.length
    || !ack.observationIds.every((id: unknown, i: number) => id === observations[i]?.id)) throw new Error("Invalid acknowledgment");
}

function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unexpected fields");
}

export const MAX_ENROLLMENT_BYTES = 4096;
export type TokenDigest = string & { readonly __brand: "TokenDigest" };
export function ingestTokenDigest(token: string): TokenDigest {
  if (!/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(token)) throw new Error("Invalid enrollment");
  return createHash("sha256").update(token).digest("hex") as TokenDigest;
}
export function parseEnrollmentRequest(value: unknown): { sourceId: SourceId; tokenDigest: TokenDigest } {
  const input = record(value);
  exactKeys(input, ["version", "sourceId", "token"]);
  if (input.version !== 1 || typeof input.token !== "string") throw new Error("Invalid enrollment");
  return { sourceId: parseSourceId(input.sourceId), tokenDigest: ingestTokenDigest(input.token) };
}
export function validateEnrollmentReply(value: unknown, sourceId: SourceId): void {
  const input = record(value);
  exactKeys(input, ["version", "sourceId", "machineId"]);
  if (input.version !== 1 || input.sourceId !== sourceId || input.machineId !== `managed-${sourceId}`) throw new Error("Invalid enrollment reply");
}
