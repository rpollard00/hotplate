import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { startAggregationServer } from "../src/aggregation.js";
import type { Observation } from "../src/domain.js";
import { readAccountConfiguration, readAggregationConfiguration, readAggregationCredentials, type AccountConfiguration, type AggregationConfiguration } from "../src/network-config.js";
import { parseCollectorOrigin, parseSourceId } from "../src/observation.js";
import { readRelayStatus, runRelay } from "../src/relay.js";
import { openCaptureStore, openHotplateReadStore, openHotplateStore } from "../src/store.js";

const sourceId = parseSourceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const otherSource = parseSourceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const token = "a".repeat(48);
const otherToken = "b".repeat(48);
const password = "dashboard-password-only";
const basic = `Basic ${Buffer.from(`reader:${password}`).toString("base64")}`;
const bearer = `Bearer ${token}`;
function observation(id = "obs-1"): Observation {
  return { id, producerId: "producer", sequence: Number(id.replace(/\D/g, "")) || 0, observedAt: "2026-02-03T04:05:06.000Z",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: "/session.jsonl", segmentId: "segment", segmentReason: "startup", runId: "run", turnId: "turn", leafId: null },
    evidence: { kind: "command-intent", skillName: "alpha", source: "interactive" } };
}
function envelope(observations: readonly unknown[] = [observation()], source = sourceId): string { return JSON.stringify({ version: 1, sourceId: source, observations }); }
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
async function fixture(t: TestContext, proxy = false, dashboard: { kind: "public" } | { username: string; password: string } = { username: "reader", password }) {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-network-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  const publicPort = proxy ? await freePort() : port;
  const origin = parseCollectorOrigin(`http://127.0.0.1:${publicPort}`);
  const tokenFile = join(dir, "token");
  const credentialsFile = join(dir, "credentials.json");
  const credentials = { ingest: [{ token, sourceId, machineId: "machine-a" }, { token: otherToken, sourceId: otherSource, machineId: "machine-b" }], dashboard };
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  const account: AccountConfiguration = { databasePath: join(dir, "capture.sqlite"), enrollment: { sourceId, collectorOrigin: origin }, tokenFile, transport: "trusted-http" };
  const aggregate: AggregationConfiguration = { databasePath: join(dir, "aggregate.sqlite"), host: "127.0.0.1", port, publicOrigin: origin, credentialsFile, transport: "trusted-http" };
  const running = await startAggregationServer({ configuration: aggregate });
  t.after(() => running.close());
  return { dir, port, publicPort, origin, account, aggregate, running, credentials };
}
async function http(args: { url: string; method?: string; body?: string | Buffer; headers?: Record<string, string> }): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(args.url, { method: args.method ?? "GET", headers: args.headers ?? {}, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    req.once("error", reject);
    req.end(args.body);
  });
}
function post(origin: string, body = envelope(), headers: Record<string, string> = {}) {
  return http({ url: `${origin}/api/ingest`, method: "POST", body, headers: { authorization: bearer, "content-type": "application/json", ...headers } });
}
async function count(databasePath: string): Promise<number> {
  const opened = openHotplateReadStore({ databasePath });
  assert.equal(opened.kind, "ready");
  if (opened.kind !== "ready") throw new Error();
  try { return (await opened.store.queryOverview({})).observationCount; } finally { await opened.store.close(); }
}
async function capture(account: AccountConfiguration, observations: readonly Observation[]): Promise<void> {
  const store = openCaptureStore(account);
  try { assert.equal((await store.record(observations)).accepted, observations.length); } finally { await store.close(); }
}
async function waitFor(predicate: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() >= deadline) assert.fail("Timed out waiting for network state"); await delay(25); }
}
async function pending(account: AccountConfiguration): Promise<number> {
  const status = await readRelayStatus({ configuration: account });
  assert.equal(status.kind, "ready");
  return status.kind === "ready" ? status.delivery.pendingCount : -1;
}
function relay(t: TestContext, account: AccountConfiguration) {
  const controller = new AbortController();
  const done = runRelay({ configuration: account, signal: controller.signal });
  // Attach immediately so a paused relay cannot become an unhandled rejection.
  void done.catch(() => {});
  t.after(async () => { controller.abort(); await done.catch(() => {}); });
  return { done, stop: async () => { controller.abort(); await done; } };
}

test("network configuration requires explicit complete enrollment, canonical origins, and trusted HTTP", async t => {
  const f = await fixture(t);
  const path = join(f.dir, "account.json");
  const value = { sourceId, endpoint: "https://hotplate.lan", tokenFile: "missing-token" };
  await writeFile(path, JSON.stringify(value));
  const parsed = readAccountConfiguration({ path, env: { HOTPLATE_DB: join(f.dir, "env.sqlite") } });
  assert.equal(parsed.tokenFile, join(f.dir, "missing-token"));
  assert.equal(parsed.databasePath, join(f.dir, "env.sqlite"));
  assert.equal(parsed.transport, "tls");
  assert.deepEqual(await readRelayStatus({ configuration: parsed }), { kind: "missing" });
  for (const patch of [{ sourceId: undefined }, { tokenFile: undefined }, { sourceId: "local" }, { endpoint: "http://hotplate.lan" },
    { endpoint: "https://secret:password@hotplate.lan" }, { endpoint: "https://hotplate.lan/path" }, { endpoint: "https://HOTPLATE.lan" },
    { endpoint: "https://hotplate.lan?token=secret" }, { extra: "secret" }, { trustedHttp: "yes" }]) {
    await writeFile(path, JSON.stringify({ ...value, ...patch }));
    assert.throws(() => readAccountConfiguration({ path }), error => error instanceof Error && !error.message.includes("secret"));
  }
  await writeFile(path, JSON.stringify({ ...value, endpoint: f.origin, databasePath: "relative.sqlite", trustedHttp: true }));
  assert.equal(readAccountConfiguration({ path }).databasePath, join(f.dir, "relative.sqlite"));
  assert.equal(readAccountConfiguration({ path }).transport, "trusted-http");
  const aggregation = { databasePath: "aggregate.sqlite", publicOrigin: f.origin, credentialsFile: "credentials.json", trustedHttp: true };
  await writeFile(path, JSON.stringify(aggregation));
  assert.equal(readAggregationConfiguration({ path }).port, 7345);
  assert.equal(readAggregationConfiguration({ path }).credentialsFile, f.aggregate.credentialsFile);
  for (const patch of [{ publicOrigin: undefined }, { trustedHttp: false }, { credentialsFile: undefined }, { port: 0 }, { publicOrigin: "https://u:secret@h" }]) {
    await writeFile(path, JSON.stringify({ ...aggregation, ...patch }));
    assert.throws(() => readAggregationConfiguration({ path }), /Invalid aggregate configuration/);
  }
});

test("aggregate refuses missing, ambiguous, reserved, or shared credentials before opening its database", async t => {
  const f = await fixture(t);
  const badPath = join(f.dir, "bad-credentials.json");
  const config = { ...f.aggregate, databasePath: join(f.dir, "must-not-exist.sqlite"), credentialsFile: badPath };
  await assert.rejects(startAggregationServer({ configuration: config }), /Invalid aggregate credentials/);
  for (const value of [ {}, { ...f.credentials, ingest: [] },
    { ...f.credentials, ingest: [{ token, sourceId, machineId: "local" }] },
    { ...f.credentials, ingest: [...f.credentials.ingest, { token: "c".repeat(40), sourceId, machineId: "different" }] },
    { ...f.credentials, ingest: [...f.credentials.ingest, { token, sourceId, machineId: "machine-a" }] },
    { ...f.credentials, dashboard: { username: "reader", password: token } },
    { ...f.credentials, dashboard: { username: "reader", password: "weak" } },
    ...[undefined, null, {}, [], { kind: "public", username: "reader" }, { kind: "public", password },
      { kind: "basic", username: "reader", password }, { kind: "unknown" }, { public: true }]
      .map(dashboard => ({ ...f.credentials, dashboard }))]) {
    await writeFile(badPath, JSON.stringify(value));
    await assert.rejects(startAggregationServer({ configuration: config }), /Invalid aggregate credentials/);
  }
  await assert.rejects(readFile(config.databasePath), { code: "ENOENT" });
});

test("aggregate authenticates before body parsing, separates roles, and binds source and machine", async t => {
  const f = await fixture(t);
  for (const authorization of ["", basic, `Bearer ${password}`]) {
    assert.equal((await post(f.origin, "not json", { authorization })).status, 401);
  }
  for (const path of ["/", "/health", "/assets/app.js", "/api/dashboard", "/not-found"]) {
    for (const authorization of ["", bearer]) assert.equal((await http({ url: `${f.origin}${path}`, headers: { authorization } })).status, 401);
  }
  const dashboard = await http({ url: `${f.origin}/api/dashboard`, headers: { authorization: basic } });
  assert.equal(dashboard.status, 200);
  assert.equal(JSON.parse(dashboard.body).overview.observationCount, 0);
  assert.equal(dashboard.headers["access-control-allow-origin"], undefined);
  assert.equal((await http({ url: `${f.origin}/?token=${token}` })).status, 401);
  assert.equal((await post(f.origin, envelope([observation()], otherSource))).status, 403);
  assert.equal((await post(f.origin, JSON.stringify({ version: 1, sourceId, machineId: "machine-b", observations: [observation()] }))).status, 400);
  const accepted = await post(f.origin);
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), { version: 1, kind: "committed", sourceId, observationIds: ["obs-1"], accepted: 1, duplicate: 0 });
  assert.equal(JSON.parse((await post(f.origin)).body).duplicate, 1);
  assert.equal((await post(f.origin, envelope([{ ...observation(), observedAt: "2026-03-03T04:05:06.000Z" }]))).status, 409);
  assert.equal((await post(f.origin, envelope([observation()], otherSource), { authorization: `Bearer ${otherToken}` })).status, 200);
  assert.equal(await count(f.aggregate.databasePath), 2);
  const data = JSON.parse((await http({ url: `${f.origin}/api/dashboard`, headers: { authorization: basic } })).body);
  assert.deepEqual(data.filterOptions.machines, ["machine-a", "machine-b"]);
});

test("aggregate public dashboard remains read-only and preserves ingest identity and origin guards", async t => {
  const f = await fixture(t, false, { kind: "public" });
  assert.deepEqual(readAggregationCredentials(f.aggregate.credentialsFile).dashboard, { kind: "public" });
  for (const path of ["/", "/health", "/assets/app.js", "/api/dashboard"]) {
    const response = await http({ url: `${f.origin}${path}` });
    assert.equal(response.status, 200);
    assert.equal(response.headers["www-authenticate"], undefined);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal((await http({ url: `${f.origin}${path}`, method: "POST" })).status, 405);
    for (const headers of [{ host: "attacker.invalid" }, { origin: "http://attacker.invalid" }]) {
      assert.equal((await http({ url: `${f.origin}${path}`, headers })).status, 403);
    }
  }
  for (const authorization of ["", basic, `Bearer ${password}`]) {
    assert.equal((await post(f.origin, "not json", { authorization })).status, 401);
  }
  assert.equal((await post(f.origin, envelope(), { host: "attacker.invalid" })).status, 403);
  assert.equal((await post(f.origin, envelope(), { origin: "http://attacker.invalid" })).status, 403);
  assert.equal((await post(f.origin, envelope([], otherSource))).status, 400);
  assert.equal((await post(f.origin, envelope([observation()], otherSource))).status, 403);
  assert.equal((await post(f.origin)).status, 200);
  assert.equal(await count(f.aggregate.databasePath), 1);
});

test("legacy dashboard credentials parse to the basic policy", async t => {
  const f = await fixture(t);
  const dashboard = readAggregationCredentials(f.aggregate.credentialsFile).dashboard;
  assert.equal(dashboard.kind, "basic");
  assert.ok(dashboard.kind === "basic");
  assert.equal(dashboard.username, "reader");
  assert.equal(dashboard.password, password);
});

test("aggregate enforces exact authority and canonical Origin without trusting proxy headers", async t => {
  const f = await fixture(t);
  for (const headers of [{ host: "attacker.invalid" }, { origin: "http://attacker.invalid" }, { origin: `${f.origin}/` },
    { origin: `${f.origin}/path` }, { origin: `${f.origin}?query` }, { origin: "null" },
    { host: "attacker.invalid", "x-forwarded-host": new URL(f.origin).host, "x-forwarded-proto": "http" }]) {
    assert.equal((await post(f.origin, envelope(), headers)).status, 403);
  }
  assert.equal((await post(f.origin, envelope(), { origin: f.origin })).status, 200);
  assert.equal((await http({ url: `${f.origin}/api/ingest?token=${token}`, method: "POST", body: envelope(), headers: { authorization: bearer, "content-type": "application/json" } })).status, 400);
});

test("ingest rejects malformed metadata, unknown fields, unsafe counters, timestamps, strings and catalogs", async t => {
  const f = await fixture(t);
  const obs = observation();
  const invalid = ["not json", envelope([]), JSON.stringify({ version: 2, sourceId, observations: [obs] }), envelope([obs, obs]),
    envelope([{ ...obs, prompt: "private raw prompt" }]), envelope([{ ...obs, scope: { ...obs.scope, text: "private" } }]),
    envelope([{ ...obs, evidence: { ...obs.evidence, output: "private" } }]), envelope([{ ...obs, sequence: -1 }]),
    envelope([{ ...obs, sequence: Number.MAX_SAFE_INTEGER + 1 }]), envelope([{ ...obs, observedAt: "yesterday" }]),
    envelope([{ ...obs, observedAt: "2026-02-30T04:05:06.000Z" }]), envelope([{ ...obs, id: "a".repeat(8193) }]),
    envelope([{ ...obs, evidence: { kind: "catalog-snapshot", skills: Array.from({ length: 2001 }, () => ({ name: "a", canonicalPath: "/a", version: null })) } }]),
    envelope([{ ...obs, evidence: { kind: "catalog-snapshot", skills: [{ name: "a", canonicalPath: "/a", version: null, body: "private" }] } }]),
    envelope(Array.from({ length: 101 }, (_, i) => observation(`obs-${i}`))),
  ];
  for (const body of invalid) {
    const result = await post(f.origin, body);
    assert.equal(result.status, 400);
    assert.equal(result.body.includes("private"), false);
  }
  assert.equal(await count(f.aggregate.databasePath), 0);
  assert.equal((await post(f.origin, "a".repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await post(f.origin, envelope(), { "content-encoding": "gzip" })).status, 415);
  assert.equal((await post(f.origin, envelope(), { "content-encoding": "identity" })).status, 415);
  assert.equal((await post(f.origin, envelope(), { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(f.origin, envelope(), { "x-padding": "a".repeat(17 * 1024) })).status, 431);
});

test("relay status never enrolls, imports history, reads tokens or makes network requests", async t => {
  const f = await fixture(t);
  const configuration = { ...f.account, tokenFile: join(f.dir, "no-token") };
  assert.deepEqual(await readRelayStatus({ configuration }), { kind: "missing" });
  await assert.rejects(runRelay({ configuration, signal: new AbortController().signal }), /not enrolled/);
  const local = openHotplateStore({ databasePath: configuration.databasePath });
  await local.record(observation());
  await local.close();
  assert.deepEqual(await readRelayStatus({ configuration }), { kind: "not-enrolled" });
  await assert.rejects(runRelay({ configuration, signal: new AbortController().signal }), /not enrolled/);
  await capture(configuration, [observation("obs-2")]);
  const status = await readRelayStatus({ configuration });
  assert.equal(status.kind, "ready");
  if (status.kind !== "ready") throw new Error();
  assert.equal(status.delivery.pendingCount, 1);
  assert.ok(status.delivery.pendingBytes > 100);
  assert.equal(status.delivery.blockedCount, 0);
  assert.ok(status.delivery.oldestPendingAt);
  assert.equal(await count(f.aggregate.databasePath), 0);
});

test("real SQLite and HTTP relay survives outage, process-style restart and concurrent delivery", async t => {
  const f = await fixture(t, true);
  await capture(f.account, [observation(), observation("obs-2")]);
  const first = relay(t, f.account);
  await delay(150);
  assert.equal(await pending(f.account), 2);
  const start = Date.now();
  await first.stop();
  assert.ok(Date.now() - start < 500, "cancellation stops backoff");
  assert.equal(await pending(f.account), 2);
  let sends = 0;
  const proxy = forwardingProxy(f.port, () => { sends += 1; return false; });
  await listen(proxy, f.publicPort);
  t.after(() => close(proxy));
  const second = relay(t, f.account);
  const concurrent = relay(t, f.account);
  await waitFor(async () => await pending(f.account) === 0);
  await second.stop(); await concurrent.stop();
  assert.ok(sends >= 2, "concurrent relays both sent the pending batch");
  assert.equal(await count(f.aggregate.databasePath), 2);
  await f.running.close();
  const restarted = await startAggregationServer({ configuration: f.aggregate });
  t.after(() => restarted.close());
  assert.equal(JSON.parse((await post(f.origin, envelope([observation(), observation("obs-2")]))).body).duplicate, 2);
  assert.equal(await count(f.aggregate.databasePath), 2);
});

function forwardingProxy(port: number, onResponse?: (args: { body: Buffer; status: number; drop(): void }) => boolean): Server {
  return createServer((downstream, response) => {
    const upstream = request({ hostname: "127.0.0.1", port, path: downstream.url, method: downstream.method, headers: downstream.headers, agent: false }, received => {
      const chunks: Buffer[] = [];
      received.on("data", chunk => chunks.push(chunk));
      received.on("end", () => {
        const body = Buffer.concat(chunks);
        if (onResponse?.({ body, status: received.statusCode ?? 0, drop: () => response.destroy() })) return;
        response.writeHead(received.statusCode ?? 500, received.headers);
        response.end(body);
      });
    });
    upstream.on("error", () => response.destroy());
    downstream.pipe(upstream);
  });
}

test("lost acknowledgment replays committed SQLite observations without duplicate analytics", async t => {
  const f = await fixture(t, true);
  let lose = true;
  let requests = 0;
  const proxy = forwardingProxy(f.port, ({ drop }) => { requests += 1; if (lose) { drop(); return true; } return false; });
  await listen(proxy, f.publicPort); t.after(() => close(proxy));
  await capture(f.account, [observation()]);
  const first = relay(t, f.account);
  await waitFor(async () => await count(f.aggregate.databasePath) === 1);
  await first.stop();
  assert.equal(await pending(f.account), 1);
  lose = false;
  const second = relay(t, f.account);
  await waitFor(async () => await pending(f.account) === 0);
  await second.stop();
  assert.ok(requests >= 2);
  assert.equal(await count(f.aggregate.databasePath), 1);
});

test("relay isolates conflicting, invalid and oversized entries without blocking valid observations", async t => {
  const f = await fixture(t);
  assert.equal((await post(f.origin)).status, 200);
  await capture(f.account, [
    { ...observation(), evidence: { kind: "command-intent", skillName: "changed", source: "interactive" } },
    { ...observation("obs-2"), observedAt: "invalid timestamp" },
    observation("obs-3"),
    { ...observation("obs-4"), evidence: { kind: "catalog-snapshot", skills: [{ name: "a".repeat(1024 * 1024), canonicalPath: "/a", version: null }] } },
    observation("obs-5"),
  ]);
  const running = relay(t, f.account);
  await waitFor(async () => {
    const status = await readRelayStatus({ configuration: f.account });
    return status.kind === "ready" && status.delivery.pendingCount === 3 && status.delivery.blockedCount === 3;
  });
  await running.stop();
  assert.equal(await count(f.aggregate.databasePath), 3);
  assert.equal(await count(f.account.databasePath), 5, "network limits do not discard local captures");
});

test("relay authorization failure is redacted, retains entries and permits token rotation on restart", async t => {
  const f = await fixture(t);
  await capture(f.account, [observation()]);
  await writeFile(f.account.tokenFile, "wrong-private-token-".repeat(3));
  await assert.rejects(runRelay({ configuration: f.account, signal: new AbortController().signal }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("wrong-private-token"), false); return true;
  });
  assert.equal(await pending(f.account), 1);
  await writeFile(f.account.tokenFile, token);
  const running = relay(t, f.account);
  await waitFor(async () => await pending(f.account) === 0);
  await running.stop();
});

test("relay forbids redirects, validates full acknowledgments, and retains entries on 429 and 5xx", async t => {
  const f = await fixture(t, true);
  let destinationRequests = 0;
  const destination = createServer((_req, res) => { destinationRequests += 1; res.end(); });
  const destPort = await freePort(); await listen(destination, destPort); t.after(() => close(destination));
  let status = 302;
  let ack: unknown = {};
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); requests += 1;
    res.writeHead(status, { location: `http://127.0.0.1:${destPort}`, "content-type": "application/json" });
    res.end(JSON.stringify(ack));
  });
  await listen(server, f.publicPort); t.after(() => close(server));
  await capture(f.account, [observation()]);
  await assert.rejects(runRelay({ configuration: f.account, signal: new AbortController().signal }), /redirects are forbidden/);
  assert.equal(destinationRequests, 0); assert.equal(await pending(f.account), 1);
  for (const next of [429, 503, 200]) {
    status = next; requests = 0;
    ack = { version: 1, kind: "committed", sourceId, observationIds: ["wrong-id"], accepted: 1, duplicate: 0 };
    const running = relay(t, f.account);
    await waitFor(async () => requests > 0);
    await running.stop();
    assert.equal(await pending(f.account), 1);
  }
  status = 200;
  ack = { version: 1, kind: "committed", sourceId, observationIds: ["obs-1"], accepted: 0, duplicate: 0 };
  const running = relay(t, f.account);
  await delay(150); await running.stop();
  assert.equal(await pending(f.account), 1);
});

test("relay cancellation aborts an active HTTP request and aggregate shutdown closes partial uploads", async t => {
  const f = await fixture(t, true);
  let received = false;
  const server = createServer(req => { req.resume(); received = true; });
  await listen(server, f.publicPort); t.after(() => close(server));
  await capture(f.account, [observation()]);
  const running = relay(t, f.account);
  await waitFor(async () => received);
  const before = Date.now(); await running.stop();
  assert.ok(Date.now() - before < 500);
  assert.equal(await pending(f.account), 1);
  const partial = request({ hostname: "127.0.0.1", port: f.port, path: "/api/ingest", method: "POST", headers: { host: new URL(f.origin).host, authorization: bearer, "content-type": "application/json", "content-length": "1000" } });
  const disconnected = new Promise<void>(resolve => { partial.on("error", () => resolve()); partial.on("close", () => resolve()); });
  partial.write("{"); await delay(50);
  await f.running.close(); await disconnected;
});

test("aggregate bounds concurrent requests and connections", async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 16 }, () => {
    const req = request(`${f.origin}/api/ingest`, { method: "POST", agent: false, headers: { authorization: bearer, "content-type": "application/json", "content-length": "1000" } });
    req.on("error", () => {}); req.write("{"); return req;
  });
  t.after(() => { requests.forEach(req => req.destroy()); });
  await delay(100);
  assert.equal((await post(f.origin)).status, 503);
  requests.forEach(req => req.destroy()); await delay(100);
  const sockets = Array.from({ length: 70 }, () => connect(f.port, "127.0.0.1"));
  let closed = 0;
  sockets.forEach(socket => { socket.on("error", () => {}); socket.on("close", () => { closed += 1; }); });
  t.after(() => { sockets.forEach(socket => socket.destroy()); });
  await delay(300);
  assert.ok(closed >= 6, `expected excess connections to close, got ${closed}`);
  sockets.forEach(socket => socket.destroy());
});

test("aggregate body deadline stops slow clients even when they keep sending bytes", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const start = Date.now();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${f.origin}/api/ingest`, { method: "POST", agent: false, headers: { authorization: bearer, "content-type": "application/json", "content-length": "10000" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
    });
    req.on("error", reject); req.write("{");
    const interval = setInterval(() => req.write(" "), 200);
    t.after(() => { clearInterval(interval); req.destroy(); });
    req.on("close", () => clearInterval(interval));
  });
  assert.equal(status, 408);
  assert.ok(Date.now() - start < 13_000);
  assert.equal(await count(f.aggregate.databasePath), 0);
});

test("relay retries an outage in the same process with retained SQLite state", async t => {
  const f = await fixture(t, true);
  await capture(f.account, [observation()]);
  const running = relay(t, f.account);
  await delay(150);
  assert.equal(await pending(f.account), 1);
  const proxy = forwardingProxy(f.port);
  await listen(proxy, f.publicPort); t.after(() => close(proxy));
  await waitFor(async () => await pending(f.account) === 0);
  await running.stop();
  assert.equal(await count(f.aggregate.databasePath), 1);
});

test("relay process kill leaves committed captures pending for a fresh process", async t => {
  const f = await fixture(t, true);
  await capture(f.account, [observation()]);
  const moduleUrl = new URL("../src/relay.js", import.meta.url).href;
  function processRelay() {
    const code = `import { runRelay } from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      await runRelay({ configuration: JSON.parse(process.argv[1]), signal: controller.signal });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(f.account)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await done; });
    return { child, done, ready: () => stderr.includes("retained backlog") };
  }
  const first = processRelay();
  await waitFor(async () => first.ready());
  await delay(100);
  first.child.kill("SIGKILL");
  assert.equal((await first.done).signal, "SIGKILL");
  assert.equal(await pending(f.account), 1);
  const proxy = forwardingProxy(f.port);
  await listen(proxy, f.publicPort); t.after(() => close(proxy));
  const second = processRelay();
  await waitFor(async () => await pending(f.account) === 0);
  second.child.kill("SIGTERM");
  assert.equal((await second.done).code, 0);
  assert.equal(await count(f.aggregate.databasePath), 1);
});

test("relay request deadline and aggregate header deadline stop unresponsive peers", { timeout: 15_000 }, async t => {
  const f = await fixture(t, true);
  await capture(f.account, [observation()]);
  let requests = 0;
  const silent = createServer(req => { requests += 1; req.resume(); });
  await listen(silent, f.publicPort); t.after(() => close(silent));
  const running = relay(t, f.account);
  const socket = connect(f.port, "127.0.0.1");
  t.after(() => socket.destroy());
  let response = "";
  socket.setEncoding("utf8"); socket.on("data", chunk => { response += chunk; });
  const headerClosed = new Promise<void>((resolve, reject) => { socket.on("error", reject); socket.on("close", () => resolve()); });
  socket.write(`POST /api/ingest HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nX-Slow: `);
  const interval = setInterval(() => socket.write("x"), 200);
  t.after(() => clearInterval(interval));
  socket.on("close", () => clearInterval(interval));
  await Promise.all([headerClosed, waitFor(async () => requests >= 2, 13_000)]);
  assert.match(response, /408 Request Timeout/);
  await running.stop();
  assert.equal(await pending(f.account), 1);
});
