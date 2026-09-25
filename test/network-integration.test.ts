import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readAccountConfiguration } from "../src/network-config.js";
import { readRelayStatus } from "../src/relay.js";
import { openHotplateReadStore } from "../src/store.js";

const cli = new URL("../src/cli.js", import.meta.url);
const capture = new URL("./fixtures/capture-process.js", import.meta.url);
const sourceIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];

function start(file: URL, args: string[], env: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, ...env };
  if (!Object.hasOwn(env, "HOTPLATE_CONFIG")) delete environment.HOTPLATE_CONFIG;
  delete environment.HOTPLATE_DISABLED;
  const child = spawn(process.execPath, [file.pathname, ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const done = once(child, "close").then(([code]) => ({ code, stdout, stderr }));
  return { child, done, output: () => stdout };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for integration state");
}

test("live SDK capture stays offline, enrolls no old rows, and two source processes relay through the CLI", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-network-sdk-"));
  const children: ChildProcess[] = [];
  let requests = 0;
  const sentinel = createServer((_request, response) => { requests += 1; response.writeHead(503).end(); });
  sentinel.listen(0, "127.0.0.1");
  await once(sentinel, "listening");
  const address = sentinel.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const configs = await Promise.all(sourceIds.map(async (sourceId, index) => {
      const configPath = join(dir, `account-${index}.json`);
      await writeFile(configPath, JSON.stringify({ sourceId, endpoint, trustedHttp: true,
        databasePath: join(dir, `capture-${index}.sqlite`), tokenFile: join(dir, `token-${index}`) }));
      return { path: configPath, configuration: readAccountConfiguration({ path: configPath }) };
    }));
    const first = configs[0];
    assert.ok(first);
    const old = await start(capture, [], { HOTPLATE_DB: first.configuration.databasePath }).done;
    assert.equal(old.code, 0, old.stderr);
    assert.deepEqual(await readRelayStatus({ configuration: first.configuration }), { kind: "not-enrolled" });
    const before = openHotplateReadStore({ databasePath: first.configuration.databasePath });
    assert.equal(before.kind, "ready");
    if (before.kind !== "ready") return;
    const oldCount = (await before.store.queryOverview({})).observationCount;
    await before.store.close();
    assert.ok(oldCount > 0);

    const captures = await Promise.all(configs.map(config => start(capture, [], { HOTPLATE_CONFIG: config.path }).done));
    for (const result of captures) assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 0, "Pi must not contact the endpoint");
    let expected = 0;
    for (const config of configs) {
      assert.equal(existsSync(config.configuration.tokenFile), false, "capture does not need to read a token");
      const status = await readRelayStatus({ configuration: config.configuration });
      assert.equal(status.kind, "ready");
      if (status.kind !== "ready") return;
      assert.ok(status.delivery.pendingCount > 0);
      expected += status.delivery.pendingCount;
    }
    const current = openHotplateReadStore({ databasePath: first.configuration.databasePath });
    assert.equal(current.kind, "ready");
    if (current.kind !== "ready") return;
    const localCount = (await current.store.queryOverview({})).observationCount;
    await current.store.close();
    const status = await readRelayStatus({ configuration: first.configuration });
    assert.ok(status.kind === "ready");
    assert.equal(localCount - oldCount, status.delivery.pendingCount);
    const statusCommand = await start(cli, ["relay", "--config", first.path, "--status"]).done;
    assert.equal(statusCommand.code, 0);
    assert.deepEqual(JSON.parse(statusCommand.stdout), status);
    assert.match(statusCommand.stderr, /no size limit or automatic eviction/);
    assert.equal(requests, 0);
    await new Promise<void>((resolve, reject) => sentinel.close(error => error ? reject(error) : resolve()));

    const credentials = { ingest: sourceIds.map((sourceId, index) => ({ sourceId, machineId: `machine-${index}`, token: `test-token-${index}-${"x".repeat(40)}` })),
      dashboard: { username: "reader", password: "synthetic-reader-password" } };
    await writeFile(join(dir, "credentials.json"), JSON.stringify(credentials));
    for (const [index, config] of configs.entries()) await writeFile(config.configuration.tokenFile, credentials.ingest[index]?.token ?? "");
    const aggregatePath = join(dir, "aggregate.json");
    await writeFile(aggregatePath, JSON.stringify({ databasePath: join(dir, "aggregate.sqlite"), host: "127.0.0.1", port: address.port,
      publicOrigin: endpoint, credentialsFile: join(dir, "credentials.json"), trustedHttp: true }));
    let aggregate = start(cli, ["aggregate", "--config", aggregatePath]);
    children.push(aggregate.child);
    await until(async () => aggregate.output().includes("Hotplate aggregate:"));
    const authorization = `Basic ${Buffer.from("reader:synthetic-reader-password").toString("base64")}`;
    assert.equal((await fetch(`${endpoint}/api/dashboard`)).status, 401);
    const relays = configs.map(config => start(cli, ["relay", "--config", config.path]));
    children.push(...relays.map(relay => relay.child));
    await until(async () => {
      const statuses = await Promise.all(configs.map(config => readRelayStatus({ configuration: config.configuration })));
      return statuses.every(item => item.kind === "ready" && item.delivery.pendingCount === 0);
    });
    for (const relay of relays) { await stop(relay.child); assert.equal((await relay.done).code, 0); }
    const payload = await fetch(`${endpoint}/api/dashboard`, { headers: { authorization } }).then(dashboard);
    assert.equal(payload.overview.observationCount, expected);
    assert.deepEqual(payload.filterOptions.machines, ["machine-0", "machine-1"]);
    assert.equal(payload.overview.successfulReadCount, 2);
    assert.ok(payload.chains.runs.some((run) => run.sourceId === sourceIds[0]));
    assert.ok(payload.chains.runs.some((run) => run.sourceId === sourceIds[1]));
    for (const machine of ["machine-0", "machine-1"]) {
      const filtered = await fetch(`${endpoint}/api/dashboard?machineId=${machine}`, { headers: { authorization } }).then(dashboard);
      assert.equal(filtered.overview.successfulReadCount, 1);
      assert.ok(filtered.skills.rows.every((row) => row.machineId === machine));
    }
    await stop(aggregate.child);
    assert.equal((await aggregate.done).code, 0);
    aggregate = start(cli, ["aggregate", "--config", aggregatePath]);
    children.push(aggregate.child);
    await until(async () => aggregate.output().includes("Hotplate aggregate:"));
    const reopened = await fetch(`${endpoint}/api/dashboard`, { headers: { authorization } }).then(dashboard);
    assert.equal(reopened.overview.observationCount, expected);
  } finally {
    sentinel.closeAllConnections();
    if (sentinel.listening) await new Promise<void>(resolve => sentinel.close(() => resolve()));
    for (const child of children) await stop(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid explicit Pi configuration fails closed with redacted diagnostics and CLI status does not enroll", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-config-sdk-"));
  try {
    const path = join(dir, "account.json");
    const databasePath = join(dir, "local.sqlite");
    const secret = "do-not-print-this-secret";
    await writeFile(path, JSON.stringify({ endpoint: `https://user:${secret}@example.com` }));
    const result = await start(capture, [], { HOTPLATE_CONFIG: path, HOTPLATE_DB: databasePath }).done;
    assert.equal(result.code, 0);
    assert.match(result.stderr, /hotplate_capture_incomplete/);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(existsSync(databasePath), false);
    const invalid = await start(cli, ["relay", "--config", path]).done;
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stderr.includes(secret), false);
    await writeFile(path, JSON.stringify({ sourceId: sourceIds[0], endpoint: "https://hotplate.example", tokenFile: "./absent-token", databasePath }));
    const missing = await start(cli, ["relay", "--config", path, "--status"]).done;
    assert.equal(missing.code, 0);
    assert.deepEqual(JSON.parse(missing.stdout), { kind: "missing" });
    assert.equal(existsSync(databasePath), false);
    const unknown = await start(cli, ["relay", "--token", secret]).done;
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stderr.includes(secret), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function dashboard(response: Response) {
  const payload = record(await response.json());
  const overview = record(payload.overview);
  const filterOptions = record(payload.filterOptions);
  const skills = record(payload.skills);
  const chains = record(payload.chains);
  assert.ok(Array.isArray(skills.rows));
  assert.ok(Array.isArray(chains.runs));
  return { overview, filterOptions, skills: { rows: skills.rows.map(record) }, chains: { runs: chains.runs.map(record) } };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
