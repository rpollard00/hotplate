import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import type { Observation } from "./domain.js";
import { readIngestToken, type AccountConfiguration } from "./network-config.js";
import { BASELINE_PROTOCOL_VERSION, encodeEnvelope, envelopeVersion, MAX_ENVELOPE_BYTES, MAX_OBSERVATIONS, MAX_PAYLOAD_BYTES, parseProtocolCapabilities, REQUEST_DEADLINE_MS, validateAcknowledgment } from "./network-protocol.js";
import type { ProtocolVersion } from "./observation.js";
import { openRelayStore, type DeliveryBlockReason, type DeliveryStatus, type RelayStore } from "./store.js";

export type RelayState = "idle" | "sending" | "backoff" | "paused" | "stopped";

const RECEIVER_REFRESH_MS = 60_000;
type Receiver = { version: ProtocolVersion; checkedAt: number };
type Attempt = { kind: "committed" } | { kind: "retry" } | { kind: "rejected"; reason: DeliveryBlockReason } | { kind: "paused"; message: string };

export async function readRelayStatus(args: { configuration: AccountConfiguration }): Promise<
  { kind: "missing" | "not-enrolled" } | { kind: "ready"; delivery: DeliveryStatus }
> {
  const opened = openRelayStore(args.configuration);
  if (opened.kind !== "ready") return opened;
  try { return { kind: "ready", delivery: await opened.store.queryStatus() }; }
  finally { await opened.store.close(); }
}

export async function runRelay(args: { configuration: AccountConfiguration; signal: AbortSignal; maySend?: () => boolean; onState?: (state: RelayState) => void }): Promise<void> {
  const { configuration, signal } = args;
  if (signal.aborted) return;
  const endpoint = new URL("/api/ingest", configuration.enrollment.collectorOrigin);
  if (endpoint.protocol !== "https:" && (endpoint.protocol !== "http:" || configuration.transport !== "trusted-http")) {
    throw new Error("Relay HTTP delivery requires explicit trustedHttp acknowledgment.");
  }
  const opened = openRelayStore(configuration);
  if (opened.kind !== "ready") throw new Error("Relay capture database is missing or not enrolled. Configure live Pi capture first.");
  const store = opened.store;
  try {
    const token = readIngestToken(configuration.tokenFile);
    process.stderr.write("Hotplate relay: retained backlog has no size limit or automatic eviction. Monitor relay --status and available disk space.\n");
    let failures = 0;
    let receiver: Receiver = { version: BASELINE_PROTOCOL_VERSION, checkedAt: -Infinity };
    while (!signal.aborted) {
      if (Date.now() - receiver.checkedAt >= RECEIVER_REFRESH_MS) {
        if (args.maySend && !args.maySend()) throw new RelayPaused("Managed selection changed. Delivery paused.");
        const advertised = await probeReceiver({ endpoint, token, signal });
        if (advertised !== null) await store.recordReceiverVersion(advertised);
        receiver = { version: advertised ?? receiver.version, checkedAt: Date.now() };
      }
      const candidates = await store.selectPending({ maxCount: MAX_OBSERVATIONS, maxPayloadBytes: MAX_PAYLOAD_BYTES, maxVersion: receiver.version });
      const observations: Observation[] = [];
      for (const candidate of candidates) {
        if (candidate.kind === "oversized") {
          await store.settle({ settlement: { kind: "blocked", observationIds: [candidate.observationId], reason: "oversized" }, signal });
        } else observations.push(candidate.observation);
      }
      if (observations.length === 0) { args.onState?.("idle"); failures = 0; await delay(1000, undefined, { signal }); continue; }
      args.onState?.("sending");
      const delivered = await deliverBatch({ observations, configuration, token, endpoint, store, signal, maySend: args.maySend });
      if (delivered) failures = 0;
      else {
        receiver = { ...receiver, checkedAt: -Infinity };
        args.onState?.("backoff");
        const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        failures += 1;
        await delay(Math.floor(ceiling * (0.5 + Math.random() * 0.5)), undefined, { signal });
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      if (error instanceof RelayPaused) throw error;
      throw new Error("Relay delivery stopped. Check credentials, configuration, and local database access, then restart. Pending entries remain retained.");
    }
  } finally { await store.close(); args.onState?.("stopped"); }
}

class RelayPaused extends Error {}

async function deliverBatch(args: {
  observations: readonly Observation[]; configuration: AccountConfiguration; token: string; endpoint: URL; store: RelayStore; signal: AbortSignal; maySend: (() => boolean) | undefined;
}): Promise<boolean> {
  const pending = [args.observations];
  while (pending.length > 0 && !args.signal.aborted) {
    const observations = pending.pop();
    if (!observations) break;
    if (args.maySend && !args.maySend()) throw new RelayPaused("Managed selection changed. Delivery paused.");
    const result = await send({ ...args, observations });
    switch (result.kind) {
      case "retry": return false;
      case "paused": throw new RelayPaused(result.message);
      case "committed":
        await args.store.settle({ settlement: { kind: "committed", observationIds: observations.map(item => item.id) }, signal: args.signal });
        break;
      case "rejected":
        if (observations.length === 1) {
          await args.store.settle({ settlement: { kind: "blocked", observationIds: observations.map(item => item.id), reason: result.reason }, signal: args.signal });
        } else {
          const middle = Math.floor(observations.length / 2);
          pending.push(observations.slice(middle), observations.slice(0, middle));
        }
        break;
      default: { const exhaustive: never = result; return exhaustive; }
    }
  }
  return true;
}

async function probeReceiver(args: { endpoint: URL; token: string; signal: AbortSignal }): Promise<ProtocolVersion | null> {
  try {
    const reply = await exchange({ ...args, method: "GET", body: null });
    if (reply.status === 405) return BASELINE_PROTOCOL_VERSION;
    return reply.status === 200 ? parseProtocolCapabilities(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body))) : null;
  } catch { return null; }
}

async function exchange(args: { endpoint: URL; token: string; method: "GET" | "POST"; body: string | null; signal: AbortSignal }): Promise<{ status: number; body: Buffer }> {
  const signal = AbortSignal.any([args.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
  const content = args.body === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(args.body) };
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = (args.endpoint.protocol === "https:" ? httpsRequest : httpRequest)(args.endpoint, {
      method: args.method, signal, maxHeaderSize: 16 * 1024,
      headers: { authorization: `Bearer ${args.token}`, ...content, connection: "close" },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      if (response.headers["content-encoding"] !== undefined) { response.destroy(); reject(new Error("Invalid response")); return; }
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ENVELOPE_BYTES) { response.destroy(); reject(new Error("Response too large")); }
        else chunks.push(chunk);
      });
      response.once("error", () => reject(new Error("Response failed")));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, size) }));
    });
    request.once("error", () => reject(new Error("Delivery failed")));
    request.end(args.body ?? undefined);
  });
}

async function send(args: {
  configuration: AccountConfiguration; token: string; endpoint: URL; observations: readonly Observation[]; signal: AbortSignal;
}): Promise<Attempt> {
  const body = encodeEnvelope(args.configuration.enrollment.sourceId, args.observations);
  if (Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return { kind: "rejected", reason: "oversized" };
  try {
    const reply = await exchange({ endpoint: args.endpoint, token: args.token, method: "POST", body, signal: args.signal });
    if (reply.status === 200) {
      validateAcknowledgment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body)), args.configuration.enrollment.sourceId, args.observations);
      return { kind: "committed" };
    }
    if (reply.status === 401 || reply.status === 403) return { kind: "paused", message: "Relay authorization failed. Check credentials and source binding, then restart." };
    if (reply.status >= 300 && reply.status < 400) return { kind: "paused", message: "Relay redirects are forbidden. Check the configured origin, then restart." };
    if (reply.status === 409) return { kind: "rejected", reason: "conflict" };
    if (reply.status === 413) return { kind: "rejected", reason: "oversized" };
    if ((reply.status === 400 || reply.status === 422) && args.observations.some(item => item.host !== undefined)) {
      return { kind: "paused", message: `Receiver refused protocol version ${envelopeVersion(args.observations)}. Upgrade the receiver before restarting the relay. Pending entries remain retained.` };
    }
    if (reply.status === 400 || reply.status === 422) return { kind: "rejected", reason: "invalid" };
    if (reply.status >= 400 && reply.status < 500 && reply.status !== 408 && reply.status !== 429) {
      return { kind: "paused", message: "Relay protocol was refused. Check the server configuration, then restart." };
    }
    return { kind: "retry" };
  } catch { return { kind: "retry" }; }
}
