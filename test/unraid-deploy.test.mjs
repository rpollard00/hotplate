import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { exchange, probe, readConfiguration, validateRelease } from "../scripts/deploy-unraid";

const directory = mkdtempSync(join(tmpdir(), "hotplate-deploy-unit-"));
const configuration = {
  version: 1, installation: randomUUID(), sshTarget: "root@unraid.example.invalid", hostName: "media",
  network: "br0", networkDriver: "macvlan", address: "192.0.2.12", origin: "http://192.0.2.12:7345",
  appdata: "/mnt/user/appdata/hotplate", aggregateFile: join(directory, "aggregate.json"),
  credentialsFile: join(directory, "credentials.json"), releaseDirectory: join(directory, "releases"),
};
const path = join(directory, "deploy.json");
test.after(() => rmSync(directory, { recursive: true, force: true }));
function config(value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return readConfiguration(path); }

function deploymentFixture(t) {
  const privateDirectory = mkdtempSync(join(tmpdir(), "hotplate-full-deploy-"));
  t.after(() => rmSync(privateDirectory, { recursive: true, force: true }));
  const bin = join(privateDirectory, "bin");
  mkdirSync(bin);
  const target = { ...configuration, aggregateFile: join(privateDirectory, "aggregate.json"),
    credentialsFile: join(privateDirectory, "credentials.json"), releaseDirectory: join(privateDirectory, "releases with spaces") };
  for (const [name, value] of Object.entries({
    "deploy.json": target,
    "aggregate.json": { databasePath: "/data/aggregate.sqlite", host: "0.0.0.0", port: 7345,
      publicOrigin: target.origin, credentialsFile: "/run/secrets/hotplate-credentials.json", trustedHttp: true },
    "credentials.json": { ingest: [{ sourceId: randomUUID(), machineId: "test", token: "a".repeat(48) }], dashboard: { kind: "public" } },
  })) writeFileSync(join(privateDirectory, name), JSON.stringify(value), { mode: 0o600 });
  const fixture = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
function record(step, detail = {}) {
  appendFileSync(process.env.DEPLOY_TRACE, JSON.stringify({ step, ...detail }) + '\\n');
  if (process.env.FAIL_STEP === step) process.exit(1);
}
if (command === 'npm') {
  record('check', { args });
  console.log('Build output with a misleading Built /tmp/not-the-release/release.json');
} else if (command === 'jj') {
  record('revision');
  console.log('a'.repeat(40));
} else if (command === 'docker') {
  record('docker-' + args.slice(0, 2).join('-'));
  if (args[0] === 'image' && args[1] === 'inspect') console.log(JSON.stringify([{ Os: 'linux', Architecture: 'amd64', Id: 'sha256:' + 'b'.repeat(64) }]));
  if (args[0] === 'image' && args[1] === 'save') writeFileSync(args[3], 'synthetic image archive');
} else if (command === 'ssh') {
  let input = '';
  process.stdin.on('data', chunk => {
    input += chunk;
    if (!input.includes('\\n')) return;
    const request = JSON.parse(input.split('\\n')[0]);
    record(request.command, { release: request.release, target: request.target });
    console.log(JSON.stringify({ kind: 'Result', state: request.command === 'plan' ? 'Ready' : 'Healthy',
      operation: request.operation, journalState: 'Healthy', containers: [] }));
    process.stdin.destroy();
  });
}
`;
  for (const name of ["npm", "jj", "docker", "ssh"]) writeFileSync(join(bin, name), fixture, { mode: 0o700 });
  const tracePath = join(privateDirectory, "trace.jsonl");
  return {
    privateDirectory,
    run(args = [], overrides = {}) {
      return spawnSync(process.execPath, [resolve("scripts/deploy-unraid"), "deploy", ...args], {
        encoding: "utf8", timeout: 20_000,
        env: { ...process.env, HOME: privateDirectory, PATH: `${bin}:${process.env.PATH}`, HOTPLATE_PRIVATE: privateDirectory, DEPLOY_TRACE: tracePath, ...overrides },
      });
    },
    trace() { return readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line)); },
  };
}

for (const selection of ["default", "empty environment", "environment", "explicit"]) test(`full deployment uses the exact new release (${selection} configuration)`, t => {
  const fixture = deploymentFixture(t);
  const defaultDirectory = join(fixture.privateDirectory, ".config", "hotplate-unraid");
  mkdirSync(defaultDirectory, { recursive: true });
  const useDefault = ["default", "empty environment"].includes(selection);
  writeFileSync(join(defaultDirectory, "deploy.json"),
    useDefault ? readFileSync(join(fixture.privateDirectory, "deploy.json")) : "invalid default configuration", { mode: 0o600 });
  const overrides = selection === "explicit" ? { HOTPLATE_PRIVATE: "/not/the/configuration" }
    : useDefault ? { HOTPLATE_PRIVATE: selection === "default" ? undefined : "" } : {};
  const result = fixture.run(selection === "explicit" ? ["--config", join(fixture.privateDirectory, "deploy.json")] : [], overrides);
  assert.equal(result.status, 0, result.stderr);
  const events = fixture.trace();
  assert.deepEqual(events.map(event => event.step), ["check", "revision", "docker-build---platform", "docker-image-inspect", "docker-image-save", "plan", "apply", "status"]);
  assert.deepEqual(events[0].args, ["run", "check"]);
  const releasePath = result.stdout.match(/^Built (.+)$/m)?.[1];
  assert.ok(releasePath?.startsWith(join(fixture.privateDirectory, "releases with spaces")));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  assert.deepEqual(events[5].release, release);
  assert.deepEqual(events[6].release, release);
  assert.equal(events[7].release, null);
});

for (const step of ["check", "docker-build---platform", "docker-image-save", "plan", "apply", "status"]) {
  test(`full deployment stops on ${step} failure`, t => {
    const fixture = deploymentFixture(t);
    const result = fixture.run([], { FAIL_STEP: step });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fixture.trace().at(-1).step, step);
  });
}

test("full deployment rejects missing configuration and unsupported arguments before external commands", t => {
  const fixture = deploymentFixture(t);
  const missing = fixture.run([], { HOTPLATE_PRIVATE: undefined });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Deployment failed/);
  for (const args of [["--config"], ["--release", "old.json"], ["--config", join(fixture.privateDirectory, "deploy.json"), "--release", "old.json"]]) {
    assert.equal(fixture.run(args).status, 1);
  }
  assert.throws(() => fixture.trace(), { code: "ENOENT" });
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["deploy:unraid"], "node scripts/deploy-unraid deploy");
});

test("invalid overrides do not fall back to the default configuration", t => {
  const fixture = deploymentFixture(t);
  const defaultDirectory = join(fixture.privateDirectory, ".config", "hotplate-unraid");
  mkdirSync(defaultDirectory, { recursive: true });
  writeFileSync(join(defaultDirectory, "deploy.json"), readFileSync(join(fixture.privateDirectory, "deploy.json")), { mode: 0o600 });
  assert.equal(fixture.run([], { HOTPLATE_PRIVATE: join(fixture.privateDirectory, "missing") }).status, 1);
  assert.equal(fixture.run(["--config", join(fixture.privateDirectory, "missing.json")]).status, 1);
  assert.throws(() => fixture.trace(), { code: "ENOENT" });
});

test("deploy-unraid accepts an explicit private target configuration", () => {
  assert.deepEqual(config(configuration), configuration);
  const publicTarget = { ...configuration, origin: `http://${configuration.address}` };
  assert.deepEqual(config(publicTarget), publicTarget);
});
test("deploy-unraid refuses shell syntax, unknown keys, noncanonical addresses and paths", () => {
  for (const mutation of [
    { sshTarget: "root@host;touch /tmp/unwanted" }, { network: "br0$(id)" }, { hostName: "$(id)" },
    { address: "192.168.088.12" }, { address: "300.1.1.1" }, { origin: "http://other:7345" },
    ...[":80", ":7346", "/", ":7345/", "?query"].map(suffix => ({ origin: `http://${configuration.address}${suffix}` })),
    { appdata: "/mnt/user/../appdata" }, { appdata: "/tmp/x,y" }, { installation: "other" },
    { unexpected: true }, { releaseDirectory: process.cwd() },
  ]) assert.throws(() => config({ ...configuration, ...mutation }));
});
test("deploy-unraid refuses readable private configuration", () => {
  config(configuration);
  chmodSync(path, 0o644);
  assert.throws(() => readConfiguration(path));
  chmodSync(path, 0o600);
});
test("deploy-unraid refuses incomplete or mutable release identity", () => {
  assert.throws(() => validateRelease({ imageId: "hotplate:latest" }));
});
test("deploy-unraid acknowledgment binds the exact operation and candidate", async () => {
  const operation = randomUUID();
  const candidate = "a".repeat(64);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createInterface} from 'node:readline';
    const lines=createInterface({input:process.stdin}); let request;
    for await (const line of lines) {
      if (!request) { request=JSON.parse(line); console.log(JSON.stringify({kind:'Probe', operation:request.operation,candidate:'${candidate}'})); }
      else { const ack=JSON.parse(line); if(ack.operation!==request.operation || ack.candidate!=='${candidate}') process.exit(2);
        console.log(JSON.stringify({kind:'Result',state:'Healthy',operation:request.operation})); process.exit(0); }
    }
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const probes = [];
  await exchange(child, { command: "apply", operation }, null, id => { probes.push(id); });
  assert.deepEqual(probes, [candidate]);
});
test("deploy-unraid rejects retirement failure without acknowledging or probing a replacement", async () => {
  const operation = randomUUID();
  const child = spawn(process.execPath, ["-e", `
    process.stdin.once('data', () => {
      console.log(JSON.stringify({kind:'Result',state:'RecoveryRequired',operation:'${operation}'}));
      process.exitCode=1; process.stdin.destroy();
    });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(exchange(child, { command: "apply", operation }, null, () => assert.fail("No candidate exists after refused retirement")));
});

test("deploy-unraid probes require healthy application payloads, not only HTTP 200", async t => {
  let health = { ok: true };
  let dashboard = { kind: "ready" };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/health" ? health : dashboard));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = { kind: "basic", username: "test", password: "synthetic-password" };
  await probe(origin, credentials);
  dashboard = { kind: "error" };
  await assert.rejects(probe(origin, credentials));
  dashboard = { kind: "ready" };
  health = { ok: false };
  await assert.rejects(probe(origin, credentials));
});
test("deploy-unraid refuses a mismatched operation without probing", async () => {
  const child = spawn(process.execPath, ["-e", `console.log(JSON.stringify({kind:'Probe',operation:'wrong',candidate:'${"a".repeat(64)}'})); setTimeout(()=>{},10000);`], { stdio: ["pipe", "pipe", "pipe"] });
  await assert.rejects(exchange(child, { command: "apply", operation: randomUUID() }, null, () => assert.fail("must not probe")));
});

test("deploy-unraid public probes send no Authorization while basic probes retain it", async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/health" ? { ok: true } : { kind: "ready" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await probe(origin, { kind: "public" });
  assert.deepEqual(requests, ["/health", "/api/dashboard"].map(path => ({ path, authorization: undefined })));
  requests.length = 0;
  await probe(origin, { kind: "basic", username: "test", password: "synthetic-password" });
  assert.ok(requests.every(request => request.authorization === `Basic ${Buffer.from("test:synthetic-password").toString("base64")}`));
});

test("container-healthcheck follows the public/basic policy and fails closed on invalid credentials", async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, authorization: request.headers.authorization });
    response.writeHead(200).end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const credentialsFile = join(directory, "health-credentials.json");
  const configurationFile = join(directory, "health-aggregate.json");
  writeFileSync(configurationFile, JSON.stringify({ databasePath: join(directory, "unused.sqlite"), host: "127.0.0.1",
    port: server.address().port, publicOrigin: "http://192.0.2.12", credentialsFile, trustedHttp: true }));
  const ingest = [{ token: "a".repeat(48), sourceId: randomUUID(), machineId: "test" }];
  for (const dashboard of [{ kind: "public" }, { username: "test", password: "synthetic-password" }, undefined, { kind: "public", password: "invalid" }]) {
    requests.length = 0;
    writeFileSync(credentialsFile, JSON.stringify({ ingest, dashboard }));
    const child = spawn(process.execPath, [new URL("../scripts/container-healthcheck.mjs", import.meta.url).pathname, configurationFile], { stdio: "ignore" });
    const code = await new Promise(resolve => child.once("close", resolve));
    if (!dashboard || "password" in dashboard && dashboard.kind === "public") {
      assert.equal(code, 1);
      assert.deepEqual(requests, []);
    } else {
      assert.equal(code, 0);
      assert.deepEqual(requests, [{ host: "192.0.2.12", authorization: dashboard.kind === "public" ? undefined : `Basic ${Buffer.from("test:synthetic-password").toString("base64")}` }]);
    }
  }
});
