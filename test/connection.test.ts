import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { startAggregationServer } from "../src/aggregation.js";
import { parseConnectionOrigin, readAccountConfiguration, type AggregationConfiguration } from "../src/network-config.js";
import { ingestTokenDigest } from "../src/network-protocol.js";
import { parseMachineId, parseSourceId } from "../src/observation.js";
import { ENROLLMENTS_PER_MINUTE, MAX_DYNAMIC_SOURCES, openAggregateStore, openRelayStore } from "../src/store.js";
import { runRelay } from "../src/relay.js";
import { SessionConnection } from "../src/connection.js";
import { createFixture, createSessionFromLocalPackage } from "./fixtures/sdk-session.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hotplate-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const sourceId = parseSourceId(randomUUID());
  const token = "s".repeat(64);
  const credentialsFile = join(root, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({ ingest: [{ sourceId, machineId: "static", token }], dashboard: { kind: "public" } }));
  const configuration: AggregationConfiguration = { databasePath: join(root, "aggregate.sqlite"), credentialsFile,
    host: "127.0.0.1", port: address.port, publicOrigin: parseConnectionOrigin(`127.0.0.1:${address.port}`), transport: "trusted-http", openEnrollment: true };
  return { root, configuration, sourceId, token };
}
async function enroll(configuration: AggregationConfiguration, sourceId: string, token: string, headers: Record<string, string> = {}) {
  return fetch(`${configuration.publicOrigin}/api/enroll`, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ version: 1, sourceId, token }), redirect: "manual" });
}
function scalar(path: string, sql: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).get()?.value; } finally { db.close(); }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, "timed out"); await delay(40); }
}

test("connection origins canonicalize authority only and reject hostile inputs", () => {
  for (const input of ["hotplate.lan", "HTTP://HOTPLATE.LAN:80", "http://hotplate.lan"]) assert.equal(parseConnectionOrigin(input), "http://hotplate.lan");
  assert.equal(parseConnectionOrigin("192.168.88.12:7345"), "http://192.168.88.12:7345");
  assert.equal(parseConnectionOrigin("https://hotplate.lan:443"), "https://hotplate.lan");
  for (const input of ["http://user:secret@host", "host/", "host?x", "host#x", "host:0", "host:65536", "host:", "ftp://host", " host", "host\\evil", "127.1", "2130706433", "0x7f000001", "host..lan"]) assert.throws(() => parseConnectionOrigin(input), input);
});

test("HTTP enrollment survives restart, closed exact retry works, identities stay reserved", async t => {
  const f = await fixture(t);
  let running = await startAggregationServer({ configuration: f.configuration });
  t.after(() => running.close());
  const id = randomUUID(), token = "d".repeat(64);
  assert.equal((await enroll(f.configuration, id, token)).status, 200);
  assert.equal((await enroll(f.configuration, id, "e".repeat(64))).status, 403);
  assert.equal((await enroll(f.configuration, randomUUID(), token)).status, 403);
  assert.equal((await enroll(f.configuration, f.sourceId, "e".repeat(64))).status, 403);
  assert.equal((await enroll(f.configuration, randomUUID(), f.token)).status, 403);
  assert.equal((await enroll(f.configuration, randomUUID(), "x".repeat(64), { origin: "http://evil.invalid" })).status, 403);
  assert.equal((await enroll(f.configuration, randomUUID(), "x".repeat(5000))).status, 413);
  await running.close();
  running = await startAggregationServer({ configuration: { ...f.configuration, openEnrollment: false } });
  const retry = await enroll(f.configuration, id, token);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { version: 1, sourceId: id, machineId: `managed-${id}` });
  assert.equal((await enroll(f.configuration, randomUUID(), "x".repeat(64))).status, 403);
  const response = await fetch(`${f.configuration.publicOrigin}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, sourceId: id, observations: [{ id: "live", producerId: "producer", sequence: 1, observedAt: new Date().toISOString(), scope: { projectCwd: "/test", sessionId: null, sessionFile: null, segmentId: "segment", segmentReason: "startup", runId: null, turnId: null, leafId: null }, evidence: { kind: "command-intent", skillName: "test", source: "interactive" } }] }) });
  assert.equal(response.status, 200);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations"), 1);
  assert.equal(scalar(f.configuration.databasePath, "SELECT token_digest AS value FROM registered_sources"), ingestTokenDigest(token));
});

test("registry rate limits new tuples but not exact retries; historical source bindings reserve identity", async t => {
  const f = await fixture(t);
  const store = openAggregateStore({ databasePath: f.configuration.databasePath });
  t.after(() => store.close());
  const history = parseSourceId(randomUUID());
  await store.ingest({ source: { sourceId: history, machineId: parseMachineId("old") }, observations: [{ id: "old", producerId: "old", sequence: 1, observedAt: new Date().toISOString(), scope: { projectCwd: "/old", sessionId: null, sessionFile: null, segmentId: "old", segmentReason: "startup", runId: null, turnId: null, leafId: null }, evidence: { kind: "command-intent", skillName: "old", source: "interactive" } }] });
  assert.equal((await store.register({ sourceId: history, tokenDigest: ingestTokenDigest("h".repeat(64)), openEnrollment: true })).kind, "refused");
  const registrations = Array.from({ length: ENROLLMENTS_PER_MINUTE }, (_, i) => ({ sourceId: parseSourceId(randomUUID()), tokenDigest: ingestTokenDigest(String(i).padStart(64, "0")), openEnrollment: true }));
  for (const registration of registrations) assert.equal((await store.register(registration)).kind, "registered");
  const first = registrations[0]; assert.ok(first);
  assert.equal((await store.register({ ...first, openEnrollment: false })).kind, "registered");
  assert.equal((await store.register({ sourceId: parseSourceId(randomUUID()), tokenDigest: ingestTokenDigest("z".repeat(64)), openEnrollment: true })).kind, "limited");
});

test("actual Pi commands share identity, automatically deliver live-only data, disconnect and restart", async t => {
  const f = await fixture(t);
  const running = await startAggregationServer({ configuration: f.configuration });
  t.after(() => running.close());
  const sdk = await createFixture();
  t.after(() => rm(sdk.rootDir, { recursive: true, force: true }));
  const previous = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = sdk.databasePath;
  t.after(() => { if (previous === undefined) delete process.env.HOTPLATE_DB; else process.env.HOTPLATE_DB = previous; });
  const first = await createSessionFromLocalPackage(sdk);
  const second = await createSessionFromLocalPackage(sdk);
  const close = async (session: typeof first) => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };
  t.after(async () => { await close(first); await close(second); });
  await first.prompt("/skill:integration-skill");
  await delay(50);
  const historical = scalar(sdk.databasePath, "SELECT COUNT(*) AS value FROM observations");
  await Promise.all([first.prompt(`/hotplate connect ${f.configuration.publicOrigin}`), second.prompt(`/hotplate connect 127.0.0.1:${f.configuration.port}`)]);
  const root = join(sdk.rootDir, "account-data", "hotplate");
  const bundles = await readdir(join(root, "connections"));
  assert.equal(bundles.length, 1);
  const bundle = join(root, "connections", bundles[0] ?? "missing");
  const account = await readFile(join(bundle, "account.json"), "utf8");
  const secret = await readFile(join(bundle, "token"), "utf8");
  await delay(1100);
  await first.prompt("/skill:integration-skill");
  await until(() => Number(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'")) === 1);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 1);
  assert.equal(scalar(sdk.databasePath, "SELECT COUNT(*) AS value FROM observations"), historical);
  assert.ok(!JSON.stringify(first.messages).includes(secret));
  await first.prompt("/hotplate disconnect");
  await delay(1100);
  await second.prompt("/skill:integration-skill");
  await delay(100);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'"), 1);
  await first.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  assert.equal(await readFile(join(bundle, "account.json"), "utf8"), account);
  const started = performance.now();
  await close(first); await close(second);
  assert.ok(performance.now() - started < 1500);
  const third = await createSessionFromLocalPackage(sdk);
  try { await third.prompt("/skill:integration-skill"); await until(() => Number(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'")) === 2); }
  finally { await close(third); }
});


test("observed incomplete, symlinked and nonprivate bundles fail closed without enrollment", async t => {
  const f = await fixture(t);
  const running = await startAggregationServer({ configuration: f.configuration });
  t.after(() => running.close());
  const sdk = await createFixture();
  t.after(() => rm(sdk.rootDir, { recursive: true, force: true }));
  const previous = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = sdk.databasePath;
  const session = await createSessionFromLocalPackage(sdk);
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    if (previous === undefined) delete process.env.HOTPLATE_DB; else process.env.HOTPLATE_DB = previous;
  });
  const bundle = join(sdk.rootDir, "account-data", "hotplate", "connections", createHash("sha256").update(f.configuration.publicOrigin).digest("hex"));
  await mkdir(bundle, { mode: 0o700 });
  await session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
  assert.deepEqual(await readdir(bundle), []);
  await rm(bundle, { recursive: true });
  await symlink(sdk.rootDir, bundle);
  await session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
  await rm(bundle);
  await session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  const original = await readFile(join(bundle, "account.json"), "utf8");
  await chmod(join(bundle, "token"), 0o644);
  await session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  assert.equal(await readFile(join(bundle, "account.json"), "utf8"), original);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 1);
});

test("v2 migration is additive and registry capacity excludes exact retries", async t => {
  const f = await fixture(t);
  let store = openAggregateStore({ databasePath: f.configuration.databasePath });
  const staticSource = { sourceId: f.sourceId, machineId: parseMachineId("static") };
  const old = { id: "v2-preserved", producerId: "v2", sequence: 1, observedAt: "2026-02-03T04:05:06.000Z",
    scope: { projectCwd: "/old", sessionId: null, sessionFile: null, segmentId: "old", segmentReason: "startup", runId: null, turnId: null, leafId: null },
    evidence: { kind: "command-intent", skillName: "preserved", source: "interactive" } } satisfies import("../src/domain.js").Observation;
  await store.ingest({ source: staticSource, observations: [old] });
  await store.close();
  let db = new DatabaseSync(f.configuration.databasePath);
  db.exec("DROP TABLE registered_sources; PRAGMA user_version = 2");
  db.close();
  store = openAggregateStore({ databasePath: f.configuration.databasePath, staticRegistrations: [{ source: staticSource, tokenDigest: ingestTokenDigest(f.token) }] });
  assert.deepEqual(store.authenticate(ingestTokenDigest(f.token)), staticSource);
  assert.deepEqual(await store.ingest({ source: staticSource, observations: [old] }), { kind: "committed", accepted: 0, duplicate: 1 });
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations"), 1);
  await store.close();
  db = new DatabaseSync(f.configuration.databasePath);
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO registered_sources VALUES (?, ?, ?)");
  const first = { sourceId: parseSourceId(randomUUID()), tokenDigest: ingestTokenDigest("a".repeat(64)), openEnrollment: false };
  insert.run(first.sourceId, `managed-${first.sourceId}`, first.tokenDigest);
  for (let i = 1; i < MAX_DYNAMIC_SOURCES; i++) {
    const id = randomUUID();
    insert.run(id, `managed-${id}`, ingestTokenDigest(String(i).padStart(64, "0")));
  }
  db.exec("COMMIT"); db.close();
  store = openAggregateStore({ databasePath: f.configuration.databasePath });
  try {
    assert.equal((await store.register(first)).kind, "registered");
    assert.equal((await store.register({ sourceId: parseSourceId(randomUUID()), tokenDigest: ingestTokenDigest("z".repeat(64)), openEnrollment: true })).kind, "limited");
    assert.throws(() => openAggregateStore({ databasePath: f.configuration.databasePath, staticRegistrations: [{ source: { sourceId: first.sourceId, machineId: parseMachineId("static") }, tokenDigest: ingestTokenDigest("b".repeat(64)) }] }));
  } finally { await store.close(); }
});


async function sdkSession(t: TestContext) {
  const sdk = await createFixture();
  const previous = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = sdk.databasePath;
  let session: Awaited<ReturnType<typeof createSessionFromLocalPackage>>;
  try { session = await createSessionFromLocalPackage(sdk); }
  finally { if (previous === undefined) delete process.env.HOTPLATE_DB; else process.env.HOTPLATE_DB = previous; }
  const notifications: string[] = [];
  const statuses = new Map<string, string>();
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notifications.push(text); },
    setStatus: (key, text) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); } } });
  const close = async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); };
  t.after(async () => { await close(); await rm(sdk.rootDir, { recursive: true, force: true }); });
  return { ...sdk, session, notifications, statuses, close, root: join(sdk.rootDir, "account-data", "hotplate") };
}
function bundlePath(root: string, origin: string): string { return join(root, "connections", createHash("sha256").update(origin).digest("hex")); }
async function proxyFixture(t: TestContext) {
  const f = await fixture(t);
  let mode: "forward" | "lose-ack" | "hold-ack" | "outage" | "unauthorized" | "hang" | "redirect" | "oversized" | "compressed" | "hang-enrollment" | "slow-ack" = "forward";
  let ingestRequests = 0;
  let duplicates = 0;
  let release: (() => void) | undefined;
  const proxy = createHttpServer((incoming, response) => {
    if (incoming.url === "/api/ingest") ingestRequests += 1;
    if (mode === "outage" || (mode === "unauthorized" && incoming.url === "/api/ingest")) {
      incoming.resume(); response.writeHead(mode === "outage" ? 503 : 401).end(); return;
    }
    if ((mode === "hang" && incoming.url === "/api/ingest") || (mode === "hang-enrollment" && incoming.url === "/api/enroll")) { incoming.resume(); return; }
    if (incoming.url === "/api/enroll" && ["redirect", "oversized", "compressed"].includes(mode)) {
      incoming.resume();
      if (mode === "redirect") response.writeHead(307, { location: f.configuration.publicOrigin + "/api/enroll" }).end();
      else if (mode === "compressed") response.writeHead(200, { "content-encoding": "gzip" }).end("invalid");
      else response.writeHead(200).end("x".repeat(4097));
      return;
    }
    const outgoing = request(`${f.configuration.publicOrigin}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, upstream => {
      const chunks: Buffer[] = [];
      upstream.on("data", chunk => chunks.push(chunk));
      upstream.on("end", () => {
        const body = Buffer.concat(chunks);
        if (incoming.url === "/api/ingest" && upstream.statusCode === 200) {
          const ack: unknown = JSON.parse(body.toString());
          if (ack && typeof ack === "object" && "duplicate" in ack && typeof ack.duplicate === "number") duplicates += ack.duplicate;
        }
        const send = () => { response.writeHead(upstream.statusCode ?? 500, upstream.headers).end(body); };
        if (incoming.url === "/api/enroll" && mode === "lose-ack") response.destroy();
        else if (incoming.url === "/api/enroll" && mode === "hold-ack") release = send;
        else if (incoming.url === "/api/ingest" && mode === "slow-ack") {
          const timer = setTimeout(send, 500); response.once("close", () => clearTimeout(timer));
        } else send();
      });
    });
    outgoing.on("error", () => { response.writeHead(503).end(); });
    incoming.pipe(outgoing);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  const origin = parseConnectionOrigin(`127.0.0.1:${address.port}`);
  let server = await startAggregationServer({ configuration: { ...f.configuration, publicOrigin: origin } });
  t.after(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await server.close(); });
  return { ...f, origin, setMode(value: typeof mode) { mode = value; }, get ingestRequests() { return ingestRequests; }, get duplicates() { return duplicates; },
    get held() { return release !== undefined; }, release() { release?.(); release = undefined; },
    async closeEnrollment() { await server.close(); server = await startAggregationServer({ configuration: { ...f.configuration, publicOrigin: origin, openEnrollment: false } }); } };
}

test("real SDK processes concurrently publish one complete stable private identity", { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const running = await startAggregationServer({ configuration: f.configuration });
  t.after(() => running.close());
  const sdk = await createFixture();
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [fileURLToPath(new URL("./fixtures/connection-process.js", import.meta.url))], {
    env: { ...process.env, HOME: sdk.rootDir, HOTPLATE_CONFIG: undefined, HOTPLATE_DISABLED: undefined }, stdio: ["pipe", "pipe", "pipe"],
  }));
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await rm(sdk.rootDir, { recursive: true, force: true }); });
  const exits = children.map(child => once(child, "exit"));
  const ready = children.map(child => new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("ready\n")) resolve(); });
    child.once("exit", code => { if (!output.includes("ready\n")) reject(new Error(`Fixture exited before startup: ${code}`)); });
    child.stderr.resume();
    child.stdin.write(JSON.stringify({ ...sdk, origin: f.configuration.publicOrigin }) + "\n");
  }));
  let timeout: NodeJS.Timeout | undefined;
  try { await Promise.race([Promise.all(ready), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Process startup timed out")), 15_000); })]); }
  finally { clearTimeout(timeout); }
  for (const child of children) child.stdin.end("connect\n");
  const results = await Promise.all(exits);
  assert.ok(results.every(result => result[0] === 0));
  const root = join(sdk.rootDir, "account-data", "hotplate");
  const bundles = await readdir(join(root, "connections"));
  assert.equal(bundles.length, 1);
  const bundle = bundlePath(root, f.configuration.publicOrigin);
  for (const path of ["account.json", "token", "capture.sqlite"]) assert.equal((await stat(join(bundle, path))).mode & 0o777, 0o600);
  assert.equal((await stat(bundle)).mode & 0o777, 0o700);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 1);
  assert.equal(scalar(join(root, "control.sqlite"), "SELECT intent AS value FROM selection"), 4);
});

test("lost enrollment ACK retains identity, closed retry activates, late ACK cannot undo disconnect", async t => {
  const f = await proxyFixture(t);
  const sdk = await sdkSession(t);
  f.setMode("lose-ack");
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  const bundle = bundlePath(sdk.root, f.origin);
  const account = await readFile(join(bundle, "account.json"), "utf8");
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), null);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 1);
  await f.closeEnrollment(); f.setMode("forward");
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  assert.equal(await readFile(join(bundle, "account.json"), "utf8"), account);
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), f.origin);
  f.setMode("hold-ack");
  const pending = sdk.session.prompt(`/hotplate connect ${f.origin}`);
  await until(() => f.held);
  await sdk.session.prompt("/hotplate status");
  assert.match(sdk.notifications.at(-1) ?? "", /"phase":"enrolling"/);
  await sdk.session.prompt("/hotplate disconnect");
  f.release(); await pending;
  await delay(1100);
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), null);
  const token = await readFile(join(bundle, "token"), "utf8");
  assert.ok(!sdk.notifications.join().includes(token));
  assert.ok(!JSON.stringify(sdk.session.messages).includes(token));
});

test("managed transport refuses redirects, compression and oversized responses without selecting a target", async t => {
  const f = await proxyFixture(t);
  const sdk = await sdkSession(t);
  for (const mode of ["redirect", "oversized", "compressed", "outage"] as const) {
    f.setMode(mode);
    await sdk.session.prompt(`/hotplate connect ${f.origin}`);
    assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), null);
  }
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
});

test("corrupt published control state is never recreated; denying control stops managed sends", async t => {
  const f = await proxyFixture(t);
  const sdk = await sdkSession(t);
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  await delay(1100);
  const control = join(sdk.root, "control.sqlite");
  await chmod(control, 0o000);
  const requests = f.ingestRequests;
  await sdk.session.prompt("/skill:integration-skill"); await delay(1200);
  assert.equal(f.ingestRequests, requests);
  await sdk.session.prompt("/hotplate status");
  assert.match(sdk.notifications.at(-1) ?? "", /"mode":"unavailable"/);
  await chmod(control, 0o600);
  await sdk.close();
  const db = new DatabaseSync(control); db.exec("DELETE FROM selection"); db.close();
  const next = await createSessionFromLocalPackage(sdk);
  try { await next.prompt(`/hotplate connect ${f.origin}`); assert.equal(scalar(control, "SELECT COUNT(*) AS value FROM selection"), 0); }
  finally { await next.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); next.dispose(); }
});

test("managed authorization pauses, outage backs off, disconnect aborts hanging sends, manual overlap settles safely", async t => {
  const f = await proxyFixture(t);
  const sdk = await sdkSession(t);
  f.setMode("unauthorized");
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  await until(() => f.ingestRequests > 0);
  const pausedCount = f.ingestRequests;
  await delay(1500);
  assert.equal(f.ingestRequests, pausedCount);
  await sdk.session.prompt("/hotplate status");
  assert.match(sdk.notifications.at(-1) ?? "", /"phase":"paused"/);
  assert.match(sdk.notifications.at(-1) ?? "", /"deliveryState":"paused"/);
  assert.ok(sdk.statuses.has("hotplate-connection"));
  f.setMode("forward");
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  assert.equal(sdk.statuses.has("hotplate-connection"), false);
  const account = readAccountConfiguration({ path: join(bundlePath(sdk.root, f.origin), "account.json") });
  f.setMode("slow-ack");
  const beforeLoad = f.ingestRequests;
  const loadStarted = performance.now();
  const abort = new AbortController();
  const manual = runRelay({ configuration: account, signal: abort.signal });
  t.after(async () => { abort.abort(); await manual; });
  for (let i = 0; i < 250; i++) await sdk.session.extensionRunner.emitInput("/skill:integration-skill", undefined, "interactive");
  await until(() => scalar(account.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox") === 0);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'"), 250);
  assert.ok(f.duplicates > 0, "automatic and manual relays must overlap real deliveries");
  assert.ok(f.ingestRequests - beforeLoad <= 12);
  t.diagnostic(`250 live inputs, ${f.ingestRequests - beforeLoad} requests, ${f.duplicates} duplicate acknowledgments, ${(performance.now() - loadStarted).toFixed(0)} ms`);
  const opened = openRelayStore(account); assert.equal(opened.kind, "ready");
  if (opened.kind !== "ready") throw new Error("Missing relay fixture");
  const settled = scalar(account.databasePath, "SELECT id AS value FROM observations LIMIT 1");
  assert.equal(typeof settled, "string");
  if (typeof settled !== "string") throw new Error("Missing settled observation");
  await opened.store.settle({ settlement: { kind: "committed", observationIds: [settled] } });
  await opened.store.settle({ settlement: { kind: "blocked", observationIds: [settled], reason: "conflict" } });
  assert.equal((await opened.store.queryStatus()).pendingCount, 0);
  await opened.store.close(); abort.abort(); await manual;
  f.setMode("outage");
  await sdk.session.prompt("/skill:integration-skill");
  const before = f.ingestRequests; await delay(2500);
  assert.ok(f.ingestRequests - before >= 1 && f.ingestRequests - before <= 4);
  f.setMode("hang");
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  const current = f.ingestRequests;
  await until(() => f.ingestRequests > current);
  const start = performance.now();
  await sdk.session.prompt("/hotplate disconnect");
  await sdk.close();
  assert.ok(performance.now() - start < 1500);
  assert.ok(Number(scalar(account.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox")) > 0);
});


test("disabled and explicit manual configuration remain authoritative in real SDK commands", async t => {
  const f = await fixture(t);
  const running = await startAggregationServer({ configuration: f.configuration }); t.after(() => running.close());
  const path = join(f.root, "manual.json");
  const capture = join(f.root, "manual.sqlite");
  await writeFile(path, JSON.stringify({ sourceId: f.sourceId, endpoint: f.configuration.publicOrigin, trustedHttp: true,
    tokenFile: "missing-token-is-not-read-by-manual-capture", databasePath: capture }));
  const savedConfig = process.env.HOTPLATE_CONFIG, savedDisabled = process.env.HOTPLATE_DISABLED;
  try {
    for (const mode of ["disabled", "manual", "invalid"] as const) {
      if (mode === "disabled") process.env.HOTPLATE_DISABLED = "1"; else delete process.env.HOTPLATE_DISABLED;
      process.env.HOTPLATE_CONFIG = mode === "invalid" ? join(f.root, "missing.json") : path;
      const sdk = await sdkSession(t);
      await sdk.session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
      await sdk.session.prompt("/hotplate disconnect");
      await sdk.session.prompt("/skill:integration-skill");
      await sdk.close();
      assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
      await assert.rejects(stat(sdk.root));
      await assert.rejects(stat(sdk.databasePath));
      if (mode === "manual") assert.equal(scalar(capture, "SELECT COUNT(*) AS value FROM delivery_outbox WHERE payload LIKE '%command-intent%'"), 1);
    }
  } finally {
    if (savedConfig === undefined) delete process.env.HOTPLATE_CONFIG; else process.env.HOTPLATE_CONFIG = savedConfig;
    if (savedDisabled === undefined) delete process.env.HOTPLATE_DISABLED; else process.env.HOTPLATE_DISABLED = savedDisabled;
  }
});

test("newer cross-origin intent wins delayed ACK; fresh collectors retain each origin backlog and gaps", async t => {
  const a = await proxyFixture(t), b = await proxyFixture(t);
  const sdk = await sdkSession(t);
  a.setMode("hold-ack");
  const stale = sdk.session.prompt(`/hotplate connect ${a.origin}`);
  await until(() => a.held);
  await sdk.session.prompt(`/hotplate connect ${b.origin}`);
  a.release(); await stale;
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), b.origin);
  a.setMode("forward");
  await sdk.session.prompt(`/hotplate connect ${a.origin}`);
  a.setMode("outage");
  const runner = sdk.session.extensionRunner;
  await Promise.all(Array.from({ length: 1300 }, () => runner.emitInput("/skill:old-origin", undefined, "interactive")));
  const accountA = readAccountConfiguration({ path: join(bundlePath(sdk.root, a.origin), "account.json") });
  await sdk.session.prompt(`/hotplate connect ${b.origin}`);
  const retained = Number(scalar(accountA.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox"));
  assert.ok(retained > 0);
  const gaps = Number(scalar(accountA.databasePath, "SELECT COALESCE(SUM(dropped),0) AS value FROM observations"));
  assert.ok(gaps > 0);
  await runner.emitInput("/skill:new-origin", undefined, "interactive");
  await until(() => scalar(b.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE skill_name = 'new-origin'") === 1);
  assert.equal(scalar(b.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE skill_name = 'old-origin' OR evidence_kind = 'capture-gap'"), 0);
  assert.equal(scalar(accountA.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox"), retained);
  a.setMode("forward");
  await sdk.session.prompt(`/hotplate connect ${a.origin}`);
  await until(() => scalar(accountA.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox") === 0);
  assert.equal(scalar(a.configuration.databasePath, "SELECT COALESCE(SUM(dropped),0) AS value FROM observations"), gaps);
  assert.equal(scalar(a.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE skill_name = 'new-origin'"), 0);
});

test("commands await their own idle cutover and shutdown fences enrollment plus old control handles", async t => {
  const f = await proxyFixture(t);
  const sdk = await sdkSession(t);
  const connection = new SessionConnection(() => [], { XDG_DATA_HOME: join(sdk.rootDir, "direct"), HOTPLATE_DB: join(sdk.rootDir, "direct-local.sqlite") });
  t.after(() => connection.close());
  const context = sdk.session.extensionRunner.createContext();
  await connection.start({ type: "session_start", reason: "startup" }, context);
  let idle: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { idle = resolve; });
  const command = connection.execute({ kind: "connect", instance: f.origin }, { ...sdk.session.extensionRunner.createCommandContext(), waitForIdle: () => waiting });
  await until(() => scalar(join(sdk.rootDir, "direct", "hotplate", "control.sqlite"), "SELECT origin AS value FROM selection") === f.origin);
  await delay(1100);
  const before = await connection.status(); assert.notEqual(before.desiredRevision, before.appliedRevision);
  assert.equal(before.phase, "transitioning");
  assert.equal(before.mode, "local"); assert.equal(before.origin, null);
  idle?.(); const after = await command; assert.equal(after.desiredRevision, after.appliedRevision);
  const b = await proxyFixture(t);
  const accountA = readAccountConfiguration({ path: join(bundlePath(join(sdk.rootDir, "direct", "hotplate"), f.origin), "account.json") });
  await until(() => scalar(accountA.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox") === 0);
  f.setMode("outage");
  connection.collector.input({ type: "input", text: "/skill:waiting-on-a", source: "interactive" }, context);
  await until(() => Number(scalar(accountA.databasePath, "SELECT COUNT(*) AS value FROM delivery_outbox")) > 0);
  const pendingA = (await connection.status()).delivery;
  let releaseSwitch: (() => void) | undefined;
  const switchIdle = new Promise<void>(resolve => { releaseSwitch = resolve; });
  t.after(() => releaseSwitch?.());
  const switching = connection.execute({ kind: "connect", instance: b.origin }, { ...sdk.session.extensionRunner.createCommandContext(), waitForIdle: () => switchIdle });
  await until(() => scalar(join(sdk.rootDir, "direct", "hotplate", "control.sqlite"), "SELECT origin AS value FROM selection") === b.origin);
  const duringSwitch = await connection.status();
  assert.equal(duringSwitch.mode, "managed"); assert.equal(duringSwitch.origin, f.origin);
  assert.equal(duringSwitch.phase, "transitioning"); assert.deepEqual(duringSwitch.delivery, pendingA);
  releaseSwitch?.(); await switching;
  assert.equal((await connection.status()).origin, b.origin);
  let releaseDisconnect: (() => void) | undefined;
  const disconnectIdle = new Promise<void>(resolve => { releaseDisconnect = resolve; });
  t.after(() => releaseDisconnect?.());
  const disconnecting = connection.execute({ kind: "disconnect" }, { ...sdk.session.extensionRunner.createCommandContext(), waitForIdle: () => disconnectIdle });
  const duringDisconnect = await connection.status();
  assert.equal(duringDisconnect.mode, "managed"); assert.equal(duringDisconnect.origin, b.origin);
  assert.equal(duringDisconnect.phase, "transitioning");
  releaseDisconnect?.(); await disconnecting;
  assert.equal((await connection.status()).mode, "local");
  f.setMode("forward");
  await connection.execute({ kind: "connect", instance: f.origin }, sdk.session.extensionRunner.createCommandContext());
  const control = join(sdk.rootDir, "direct", "hotplate", "control.sqlite");
  await rename(control, control + ".old");
  await writeFile(control, "", { mode: 0o600 });
  const requests = f.ingestRequests;
  connection.collector.input({ type: "input", text: "/skill:fenced", source: "interactive" }, context);
  await delay(1200);
  assert.equal(f.ingestRequests, requests);
  assert.equal((await connection.status()).mode, "unavailable");
  await connection.close();
  f.setMode("hold-ack");
  const pending = sdk.session.prompt(`/hotplate connect ${f.origin}`);
  await until(() => f.held);
  const started = performance.now();
  await sdk.close(); f.release(); await pending;
  assert.ok(performance.now() - started < 1500);
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), null);
});


test("publication crash points preserve complete identity or fail closed without regeneration", { timeout: 30_000 }, async t => {
  for (const point of ["before-control", "after-control-link", "before-bundle", "after-bundle"]) {
    const f = await fixture(t);
    const running = await startAggregationServer({ configuration: f.configuration }); t.after(() => running.close());
    const sdk = await createFixture(); t.after(() => rm(sdk.rootDir, { recursive: true, force: true }));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/connection-crash.js", import.meta.url))], {
      env: { ...process.env, HOME: sdk.rootDir, HOTPLATE_CONFIG: undefined, HOTPLATE_DISABLED: undefined, HOTPLATE_TEST_CRASH: point }, stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    child.stdout.resume(); child.stderr.resume();
    const exited = once(child, "exit");
    child.stdin.end(JSON.stringify({ ...sdk, origin: f.configuration.publicOrigin }) + "\nconnect\n");
    assert.equal((await exited)[0], 73, point);
    const root = join(sdk.rootDir, "account-data", "hotplate");
    const bundle = bundlePath(root, f.configuration.publicOrigin);
    const original = point === "after-bundle" ? await readFile(join(bundle, "account.json"), "utf8") : null;
    const session = await createSessionFromLocalPackage(sdk);
    try {
      await session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
      if (point === "after-control-link") {
        assert.equal((await stat(join(root, "control.sqlite"))).nlink, 2);
        assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
      } else {
        assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 1);
        assert.equal((await stat(join(bundle, "token"))).mode & 0o777, 0o600);
        if (original !== null) assert.equal(await readFile(join(bundle, "account.json"), "utf8"), original);
      }
    } finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  }
});

test("enrollment admission rejects method/query/content/header ambiguity and remains bounded", async t => {
  const f = await fixture(t);
  const server = await startAggregationServer({ configuration: f.configuration }); t.after(() => server.close());
  const url = f.configuration.publicOrigin + "/api/enroll";
  const body = JSON.stringify({ version: 1, sourceId: randomUUID(), token: "z".repeat(64) });
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url + "?extra=1", { method: "POST", headers: { "content-type": "application/json" }, body })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 415);
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body })).status, 415);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", host: "wrong.invalid" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.on("error", reject); req.end(body);
  });
  assert.equal(wrongHost, 403);
  const response = await new Promise<number>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: ["Host", new URL(url).host, "Content-Type", "application/json", "Content-Type", "application/json"] }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.on("error", reject); req.end(body);
  });
  assert.equal(response, 403);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
});

test("SDK reload replaces owned resources, retains managed identity and bounded writer-loss reporting", async t => {
  const f = await fixture(t);
  const server = await startAggregationServer({ configuration: f.configuration }); t.after(() => server.close());
  const sdk = await sdkSession(t);
  await sdk.session.prompt(`/hotplate connect ${f.configuration.publicOrigin}`);
  const account = readAccountConfiguration({ path: join(bundlePath(sdk.root, f.configuration.publicOrigin), "account.json") });
  const before = await readFile(account.tokenFile, "utf8");
  const savedData = process.env.XDG_DATA_HOME, savedDb = process.env.HOTPLATE_DB;
  process.env.XDG_DATA_HOME = join(sdk.rootDir, "account-data"); process.env.HOTPLATE_DB = sdk.databasePath;
  try { await sdk.session.reload(); }
  finally {
    if (savedData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedData;
    if (savedDb === undefined) delete process.env.HOTPLATE_DB; else process.env.HOTPLATE_DB = savedDb;
  }
  await sdk.session.prompt("/skill:integration-skill");
  await until(() => scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'") === 1);
  assert.ok(await readFile(account.tokenFile, "utf8") === before);
  const statuses: string[] = [];
  sdk.session.extensionRunner.setUIContext({ ...sdk.session.extensionRunner.getUIContext(), setStatus: (_key, text) => { if (text) statuses.push(text); } });
  const lock = new DatabaseSync(account.databasePath); lock.exec("BEGIN IMMEDIATE");
  try {
    await sdk.session.extensionRunner.emitInput("/skill:locked", undefined, "interactive");
    const started = performance.now(); await sdk.close();
    assert.ok(performance.now() - started < 1500);
    assert.ok(statuses.some(text => text.includes("incomplete")));
  } finally { lock.exec("ROLLBACK"); lock.close(); }
});


test("managed enrollment deadline bounds an unresponsive peer and retains local selection", { timeout: 15_000 }, async t => {
  const f = await proxyFixture(t), sdk = await sdkSession(t);
  f.setMode("hang-enrollment");
  const started = performance.now();
  await sdk.session.prompt(`/hotplate connect ${f.origin}`);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 9000 && elapsed < 12_500);
  assert.equal(scalar(join(sdk.root, "control.sqlite"), "SELECT origin AS value FROM selection"), null);
  assert.equal(scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM registered_sources"), 0);
  assert.ok((await stat(join(bundlePath(sdk.root, f.origin), "token"))).size > 0);
});


test("SDK duplicate package loading and repeated lifecycle start leave one capturing extension and no owned relay after shutdown", async t => {
  const f = await proxyFixture(t), sdk = await createFixture();
  const session = await createSessionFromLocalPackage(sdk, true);
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); await rm(sdk.rootDir, { recursive: true, force: true }); });
  assert.equal(session.extensionRunner.getExtensionPaths().filter(path => path.endsWith("/src/extension.ts")).length, 1);
  await session.prompt(`/hotplate connect ${f.origin}`);
  await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  await session.prompt("/skill:integration-skill");
  await until(() => scalar(f.configuration.databasePath, "SELECT COUNT(*) AS value FROM observations WHERE evidence_kind = 'command-intent'") === 1);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  const sent = f.ingestRequests;
  await delay(1100);
  assert.equal(f.ingestRequests, sent);
});


test("registry read failures remain retryable server errors instead of false authorization failures", async t => {
  const f = await fixture(t);
  const server = await startAggregationServer({ configuration: f.configuration }); t.after(() => server.close());
  const sourceId = randomUUID(), token = "r".repeat(64);
  assert.equal((await enroll(f.configuration, sourceId, token)).status, 200);
  const db = new DatabaseSync(f.configuration.databasePath);
  try { db.prepare("UPDATE registered_sources SET machine_id = 'local' WHERE source_id = ?").run(sourceId); }
  finally { db.close(); }
  const response = await fetch(f.configuration.publicOrigin + "/api/ingest", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "request-failed" });
});
