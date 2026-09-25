import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import type { Observation } from "./domain.js";
import { readIngestToken, type AccountConfiguration } from "./network-config.js";
import { encodeEnvelope, MAX_ENVELOPE_BYTES, MAX_OBSERVATIONS, MAX_PAYLOAD_BYTES, REQUEST_DEADLINE_MS, validateAcknowledgment } from "./network-protocol.js";
import { openRelayStore, type DeliveryBlockReason, type DeliveryStatus, type RelayStore } from "./store.js";

type Attempt = { kind: "committed" } | { kind: "retry" } | { kind: "rejected"; reason: DeliveryBlockReason } | { kind: "paused"; message: string };

export async function readRelayStatus(args: { configuration: AccountConfiguration }): Promise<
  { kind: "missing" | "not-enrolled" } | { kind: "ready"; delivery: DeliveryStatus }
> {
  const opened = openRelayStore(args.configuration);
  if (opened.kind !== "ready") return opened;
  try { return { kind: "ready", delivery: await opened.store.queryStatus() }; }
  finally { await opened.store.close(); }
}

export async function runRelay(args: { configuration: AccountConfiguration; signal: AbortSignal }): Promise<void> {
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
    while (!signal.aborted) {
      const candidates = await store.selectPending({ maxCount: MAX_OBSERVATIONS, maxPayloadBytes: MAX_PAYLOAD_BYTES });
      const observations: Observation[] = [];
      for (const candidate of candidates) {
        if (candidate.kind === "oversized") {
          await store.settle({ settlement: { kind: "blocked", observationIds: [candidate.observationId], reason: "oversized" }, signal });
        } else observations.push(candidate.observation);
      }
      if (observations.length === 0) { failures = 0; await delay(1000, undefined, { signal }); continue; }
      const delivered = await deliverBatch({ observations, configuration, token, endpoint, store, signal });
      if (delivered) failures = 0;
      else {
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
  } finally { await store.close(); }
}

class RelayPaused extends Error {}

async function deliverBatch(args: {
  observations: readonly Observation[]; configuration: AccountConfiguration; token: string; endpoint: URL; store: RelayStore; signal: AbortSignal;
}): Promise<boolean> {
  const pending = [args.observations];
  while (pending.length > 0 && !args.signal.aborted) {
    const observations = pending.pop();
    if (!observations) break;
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

async function send(args: {
  configuration: AccountConfiguration; token: string; endpoint: URL; observations: readonly Observation[]; signal: AbortSignal;
}): Promise<Attempt> {
  const body = encodeEnvelope(args.configuration.enrollment.sourceId, args.observations);
  if (Buffer.byteLength(body) > MAX_ENVELOPE_BYTES) return { kind: "rejected", reason: "oversized" };
  const signal = AbortSignal.any([args.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
  try {
    const reply = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const request = (args.endpoint.protocol === "https:" ? httpsRequest : httpRequest)(args.endpoint, {
        method: "POST", signal, maxHeaderSize: 16 * 1024,
        headers: { authorization: `Bearer ${args.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" },
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
      request.end(body);
    });
    if (reply.status === 200) {
      validateAcknowledgment(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body)), args.configuration.enrollment.sourceId, args.observations);
      return { kind: "committed" };
    }
    if (reply.status === 401 || reply.status === 403) return { kind: "paused", message: "Relay authorization failed. Check credentials and source binding, then restart." };
    if (reply.status >= 300 && reply.status < 400) return { kind: "paused", message: "Relay redirects are forbidden. Check the configured origin, then restart." };
    if (reply.status === 409) return { kind: "rejected", reason: "conflict" };
    if (reply.status === 413) return { kind: "rejected", reason: "oversized" };
    if (reply.status === 400 || reply.status === 422) return { kind: "rejected", reason: "invalid" };
    if (reply.status >= 400 && reply.status < 500 && reply.status !== 408 && reply.status !== 429) {
      return { kind: "paused", message: "Relay protocol was refused. Check the server configuration, then restart." };
    }
    return { kind: "retry" };
  } catch { return { kind: "retry" }; }
}
