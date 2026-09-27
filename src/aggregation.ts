import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SourceIdentity } from "./domain.js";
import { readAggregationCredentials, type AggregationConfiguration } from "./network-config.js";
import { committedAcknowledgment, MAX_ENVELOPE_BYTES, parseEnvelope, REQUEST_DEADLINE_MS } from "./network-protocol.js";
import { respondDashboard } from "./server.js";
import { openAggregateStore } from "./store.js";

const MAX_ACTIVE_REQUESTS = 16;
const MAX_CONNECTIONS = 64;

export async function startAggregationServer(args: { configuration: AggregationConfiguration }): Promise<{ url: string; close(): Promise<void> }> {
  const configuration = args.configuration;
  const origin = new URL(configuration.publicOrigin);
  if ((origin.protocol === "http:" && configuration.transport !== "trusted-http")
    || origin.origin !== configuration.publicOrigin) throw new Error("Invalid aggregate transport configuration");
  const credentials = readAggregationCredentials(configuration.credentialsFile);
  const ingestCredentials = new Map(credentials.ingest.map(entry => [digest(`Bearer ${entry.token}`).toString("hex"), entry.source]));
  const dashboardCredential = credentials.dashboard.kind === "public" ? null : digest(`Basic ${Buffer.from(`${credentials.dashboard.username}:${credentials.dashboard.password}`).toString("base64")}`);
  const store = openAggregateStore({ databasePath: configuration.databasePath });
  const shutdown = new AbortController();
  const work = new Set<Promise<void>>();
  let activeRequests = 0;
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: REQUEST_DEADLINE_MS, requestTimeout: REQUEST_DEADLINE_MS,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 5000 }, (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (activeRequests >= MAX_ACTIVE_REQUESTS || shutdown.signal.aborted) {
      reply(response, 503, "unavailable");
      return;
    }
    activeRequests += 1;
    const finished = new Promise<void>(resolve => {
      const done = () => { response.off("finish", done); response.off("close", done); resolve(); };
      response.once("finish", done);
      response.once("close", done);
    });
    const task = handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reply(response, 500, "request-failed");
    }).finally(async () => { await finished; activeRequests -= 1; work.delete(task); });
    work.add(task);
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(REQUEST_DEADLINE_MS, socket => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!safeRequest(request, origin)) { reply(response, 403, "forbidden-origin"); return; }
    const path = new URL(request.url ?? "/", origin).pathname;
    const authorization = request.headers.authorization ?? "";
    if (path !== "/api/ingest") {
      if (dashboardCredential !== null && !timingSafeEqual(digest(authorization), dashboardCredential)) {
        response.setHeader("www-authenticate", 'Basic realm="Hotplate", charset="UTF-8"');
        reply(response, 401, "unauthorized");
        return;
      }
      await respondDashboard({ request, response, databasePath: configuration.databasePath });
      return;
    }
    const source: SourceIdentity | undefined = ingestCredentials.get(digest(authorization).toString("hex"));
    if (!source) { reply(response, 401, "unauthorized"); return; }
    if (request.method !== "POST") { response.setHeader("allow", "POST"); reply(response, 405, "method-not-allowed"); return; }
    if (request.url !== "/api/ingest") { reply(response, 400, "invalid-request"); return; }
    if (request.headers["content-encoding"] !== undefined) { reply(response, 415, "unsupported-encoding"); return; }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) { reply(response, 415, "unsupported-content-type"); return; }
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_ENVELOPE_BYTES)) { reply(response, 413, "envelope-too-large"); return; }
    const disconnected = new AbortController();
    const onClose = () => { if (!response.writableFinished) disconnected.abort(); };
    response.once("close", onClose);
    const signal = AbortSignal.any([shutdown.signal, disconnected.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
    try {
      let envelope: ReturnType<typeof parseEnvelope>;
      try {
        const body = await readBody(request, signal);
        envelope = parseEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      } catch (error) {
        reply(response, error instanceof BodyTooLarge ? 413 : signal.aborted ? 408 : 400, "invalid-envelope");
        return;
      }
      if (envelope.sourceId !== source.sourceId) { reply(response, 403, "source-mismatch"); return; }
      const result = await store.ingest({ source, observations: envelope.observations, signal });
      switch (result.kind) {
        case "committed": reply(response, 200, committedAcknowledgment({ ...result, sourceId: source.sourceId, observations: envelope.observations })); return;
        case "conflict": reply(response, 409, "identity-conflict"); return;
        case "unavailable": reply(response, 503, "unavailable"); return;
        default: { const exhaustive: never = result; return exhaustive; }
      }
    } finally { response.off("close", onClose); }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuration.port, configuration.host, () => { server.off("error", reject); resolve(); });
    });
  } catch { await store.close(); throw new Error("Cannot start aggregate listener. Check the address, port, and database."); }
  let closing: Promise<void> | undefined;
  return {
    url: configuration.publicOrigin,
    close() {
      closing ??= (async () => {
        shutdown.abort();
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
        await Promise.allSettled(work);
        await store.close();
      })();
      return closing;
    },
  };
}

function safeRequest(request: IncomingMessage, origin: URL): boolean {
  if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
    || !request.url?.startsWith("/") || request.url.startsWith("//")) return false;
  const unique = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    if (name && ["host", "origin", "authorization", "content-type", "content-encoding"].includes(name)) {
      if (unique.has(name)) return false;
      unique.add(name);
    }
  }
  return true;
}
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
class BodyTooLarge extends Error {}
function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData); request.off("end", onEnd); request.off("error", onError); request.off("aborted", onAborted);
      signal.removeEventListener("abort", onAborted);
    };
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
    const onAborted = () => fail(new Error("Request cancelled"));
    const onError = () => fail(new Error("Request failed"));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ENVELOPE_BYTES) fail(new BodyTooLarge());
      else chunks.push(chunk);
    };
    if (signal.aborted) { reject(new Error("Request cancelled")); return; }
    signal.addEventListener("abort", onAborted, { once: true });
    request.on("data", onData); request.once("end", onEnd); request.once("error", onError); request.once("aborted", onAborted);
  });
}
function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  const data = JSON.stringify(typeof body === "string" ? { error: body } : body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), connection: "close" });
  response.end(data);
}
