import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { startAggregationServer } from "../src/aggregation.js";
import { seedDemoDatabase } from "../src/cli.js";
import { startDashboardServer } from "../src/server.js";
import { openHotplateStore } from "../src/store.js";
import { parseCollectorOrigin } from "../src/observation.js";

test("readiness performs bounded indexed reads and leaves a missing database untouched", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-readiness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "database.sqlite");
  const server = await startDashboardServer({ databasePath, port: 0 });
  t.after(() => server.close());
  const missing = await fetch(`${server.url}/api/readiness`);
  assert.equal(missing.status, 503);
  assert.partialDeepStrictEqual(await missing.json(), { ok: false });
  assert.equal(existsSync(databasePath), false);
  const store = openHotplateStore({ databasePath });
  await store.close();
  const queries: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    queries.push(sql);
    return prepare.call(this, sql);
  });
  const ready = await fetch(`${server.url}/api/readiness`);
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), '{"ok":true}\n');
  assert.ok(queries.some(query => query.includes("WHERE singleton = 1")));
  assert.ok(queries.some(query => query.includes("LIMIT 1")));
  assert.ok(queries.every(query => !/COUNT|json_extract|resource_events|GROUP BY/iu.test(query)));
  const head = await fetch(`${server.url}/api/readiness`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "12");
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${server.url}/api/readiness`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${server.url}/api/readiness`, { headers: { Origin: "https://elsewhere.invalid" } })).status, 403);
});

test("readiness rejects incompatible, damaged and incomplete database state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-readiness-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "database.sqlite");
  const server = await startDashboardServer({ databasePath, port: 0 });
  t.after(() => server.close());
  await writeFile(databasePath, "this is not SQLite");
  assert.equal((await fetch(`${server.url}/api/readiness`)).status, 503);
  await rm(databasePath);
  const store = openHotplateStore({ databasePath });
  await store.close();
  const db = new DatabaseSync(databasePath);
  t.after(() => db.close());
  const originalVersion = db.prepare("PRAGMA user_version").get()?.user_version;
  assert.equal(typeof originalVersion, "number");
  db.exec("PRAGMA user_version = 999");
  const incompatible = await fetch(`${server.url}/api/readiness`);
  assert.equal(incompatible.status, 503);
  assert.partialDeepStrictEqual(await incompatible.json(), { ok: false, message: "Unsupported Hotplate schema version 999" });
  db.exec(`PRAGMA user_version = ${Number(originalVersion)}`);
  db.exec("DELETE FROM database_state");
  assert.equal((await fetch(`${server.url}/api/readiness`)).status, 503);
  assert.equal((await fetch(`${server.url}/health`)).status, 200);
});

test("aggregate readiness uses the dashboard authentication policy", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-readiness-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const credentialsFile = join(directory, "credentials.json");
  await writeFile(credentialsFile, JSON.stringify({ dashboard: { username: "reader", password: "readiness-password-123456" },
    ingest: [{ token: "a".repeat(48), sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", machineId: "machine-a" }] }), { mode: 0o600 });
  const server = await startAggregationServer({ configuration: {
    databasePath: join(directory, "aggregate.sqlite"), host: "127.0.0.1", port,
    publicOrigin: parseCollectorOrigin(`http://127.0.0.1:${port}`), credentialsFile, transport: "trusted-http",
  } });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/api/readiness`)).status, 401);
  const response = await fetch(`${server.url}/api/readiness`, { headers: {
    Authorization: `Basic ${Buffer.from("reader:readiness-password-123456").toString("base64")}`,
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("JSON compression negotiates gzip without changing identity bodies or HEAD lengths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-compression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "database.sqlite");
  await seedDemoDatabase({ databasePath, force: true });
  const server = await startDashboardServer({ databasePath, port: 0 });
  t.after(() => server.close());
  const identity = await rawRequest(`${server.url}/api/dashboard`, "identity");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.headers.vary, "Accept-Encoding");
  const compressed = await rawRequest(`${server.url}/api/dashboard`, "gzip");
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers["content-length"], String(compressed.body.length));
  assert.deepEqual(gunzipSync(compressed.body), identity.body);
  assert.ok(compressed.body.length < identity.body.length / 2);
  const head = await rawRequest(`${server.url}/api/dashboard`, "gzip", "HEAD");
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(head.headers["content-length"], compressed.headers["content-length"]);
  assert.equal(head.body.length, 0);
  assert.equal((await rawRequest(`${server.url}/api/dashboard`, "gzip;q=0, *;q=1")).headers["content-encoding"], undefined);
  assert.equal((await rawRequest(`${server.url}/api/dashboard`, "GZIP; q=0.5")).headers["content-encoding"], "gzip");
  assert.equal((await rawRequest(`${server.url}/health`, "gzip")).headers["content-encoding"], undefined);
});

function rawRequest(url: string, encoding: string, method = "GET"): Promise<{ headers: import("node:http").IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method, headers: { "accept-encoding": encoding } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
