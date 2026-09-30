import { readNativeAccountConfiguration } from "./integrations/native-settings.js";
import { createHash } from "node:crypto";
import type { CaptureWriteSummary, Evidence, NativeHostId, ObservationScope } from "./domain.js";
import { parseObservation, validateObservationMetadata } from "./observation.js";
import { openCaptureStore, openHotplateStore, resolveHotplateDatabasePath } from "./store.js";

export type CaptureFact = {
  host: NativeHostId;
  sessionId: string;
  actorId: string;
  occurrenceId: string;
  observedAt: string;
  scope: ObservationScope;
  evidence: Extract<Evidence, { kind: "command-intent" | "read-attempt" | "read-result" | "skill-invocation" | "catalog-snapshot" }>;
};

export function parseCaptureFact(value: unknown): CaptureFact {
  if (typeof value !== "object" || value === null || !("host" in value) || !("sessionId" in value)
    || !("actorId" in value) || !("occurrenceId" in value) || !("observedAt" in value)
    || !("scope" in value) || !("evidence" in value)) throw new Error("Invalid capture metadata");
  const host = value.host;
  if (host !== "codex" && host !== "claude-code" && host !== "opencode-v1" && host !== "opencode-v2") throw new Error("Invalid capture host");
  for (const id of [value.sessionId, value.actorId, value.occurrenceId]) {
    if (typeof id !== "string" || id.length === 0 || Buffer.byteLength(id) > 8192) throw new Error("Invalid capture identity");
  }
  if (typeof value.sessionId !== "string" || typeof value.actorId !== "string" || typeof value.occurrenceId !== "string") throw new Error("Invalid capture identity");
  const observation = parseObservation({ id: "validation", producerId: "validation", sequence: 0, host, observedAt: value.observedAt, scope: value.scope, evidence: value.evidence });
  validateObservationMetadata(observation, observation);
  const evidence = observation.evidence;
  if (evidence.kind !== "read-attempt" && evidence.kind !== "command-intent" && evidence.kind !== "read-result" && evidence.kind !== "skill-invocation" && evidence.kind !== "catalog-snapshot") throw new Error("Invalid native evidence");
  if (observation.scope.sessionId !== value.sessionId) throw new Error("Invalid capture scope");
  const fact: CaptureFact = { host, sessionId: value.sessionId, actorId: value.actorId, occurrenceId: value.occurrenceId, observedAt: observation.observedAt, scope: observation.scope, evidence };
  if (Buffer.byteLength(JSON.stringify(fact)) > 512 * 1024) throw new Error("Capture metadata too large");
  return fact;
}

export async function captureFact(args: { fact: CaptureFact; env?: NodeJS.ProcessEnv }): Promise<
  { kind: "disabled" } | ({ kind: "recorded" } & CaptureWriteSummary)
> {
  const env = args.env ?? process.env;
  if (env.HOTPLATE_DISABLED === "1" || env.HOTPLATE_DISABLED === "true") return { kind: "disabled" };
  const fact = parseCaptureFact(args.fact);
  const receipt = createHash("sha256").update(JSON.stringify([fact.host, fact.sessionId, fact.actorId, fact.occurrenceId, fact.evidence.kind])).digest("hex");
  const configuration = readNativeAccountConfiguration(env);
  const store = configuration
    ? openCaptureStore(configuration)
    : openHotplateStore({ databasePath: resolveHotplateDatabasePath({ env }) });
  try {
    return { kind: "recorded", ...await store.record({
      id: `native:${receipt}`, producerId: `native:${receipt}`, sequence: 0, host: fact.host,
      observedAt: fact.observedAt, scope: fact.scope, evidence: fact.evidence,
    }) };
  } finally { await store.close(); }
}
