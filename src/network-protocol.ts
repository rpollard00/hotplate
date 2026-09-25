import type { Observation, SourceId } from "./domain.js";
import { parseObservation, parseSourceId, serializeObservation } from "./observation.js";

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_OBSERVATIONS = 100;
export const REQUEST_DEADLINE_MS = 10_000;
const ENVELOPE_OVERHEAD_BYTES = 1024;
export const MAX_PAYLOAD_BYTES = MAX_ENVELOPE_BYTES - ENVELOPE_OVERHEAD_BYTES;

export function encodeEnvelope(sourceId: SourceId, observations: readonly Observation[]): string {
  return `{"version":1,"sourceId":${JSON.stringify(sourceId)},"observations":[${observations.map(serializeObservation).join(",")}]}`;
}

export function parseEnvelope(value: unknown): { sourceId: SourceId; observations: readonly Observation[] } {
  const envelope = record(value);
  exactKeys(envelope, ["version", "sourceId", "observations"]);
  if (envelope.version !== 1 || !Array.isArray(envelope.observations)
    || envelope.observations.length < 1 || envelope.observations.length > MAX_OBSERVATIONS) throw new Error("Invalid envelope");
  const sourceId = parseSourceId(envelope.sourceId);
  const ids = new Set<string>();
  const observations = envelope.observations.map((raw: unknown) => {
    const parsed = parseObservation(raw);
    strictMetadata(raw, parsed);
    if (ids.has(parsed.id)) throw new Error("Repeated observation identity");
    ids.add(parsed.id);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.observedAt)
      || !Number.isFinite(Date.parse(parsed.observedAt)) || new Date(parsed.observedAt).toISOString() !== parsed.observedAt) {
      throw new Error("Invalid timestamp");
    }
    return parsed;
  });
  return { sourceId, observations };
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
    const expected = record(canonical);
    const input = record(raw);
    exactKeys(input, Object.keys(expected));
    for (const key of Object.keys(expected)) strictMetadata(input[key], expected[key]);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unexpected fields");
}
