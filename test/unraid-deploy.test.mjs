import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { exchange, probe, readConfiguration, validateRelease } from "../scripts/deploy-unraid";

const directory = mkdtempSync(join(tmpdir(), "hotplate-deploy-unit-"));
const configuration = {
  version: 1, installation: randomUUID(), sshTarget: "root@media.media", hostName: "media",
  network: "br0", networkDriver: "macvlan", address: "192.168.88.12", origin: "http://192.168.88.12:7345",
  appdata: "/mnt/user/appdata/hotplate", aggregateFile: join(directory, "aggregate.json"),
  credentialsFile: join(directory, "credentials.json"), releaseDirectory: join(directory, "releases"),
};
const path = join(directory, "deploy.json");
test.after(() => rmSync(directory, { recursive: true, force: true }));
function config(value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return readConfiguration(path); }

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
    port: server.address().port, publicOrigin: "http://192.168.88.12", credentialsFile, trustedHttp: true }));
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
      assert.deepEqual(requests, [{ host: "192.168.88.12", authorization: dashboard.kind === "public" ? undefined : `Basic ${Buffer.from("test:synthetic-password").toString("base64")}` }]);
    }
  }
});
