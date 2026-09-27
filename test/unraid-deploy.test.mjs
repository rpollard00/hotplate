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
});
test("deploy-unraid refuses shell syntax, unknown keys, noncanonical addresses and paths", () => {
  for (const mutation of [
    { sshTarget: "root@host;touch /tmp/unwanted" }, { network: "br0$(id)" }, { hostName: "$(id)" },
    { address: "192.168.088.12" }, { address: "300.1.1.1" }, { origin: "http://other:7345" },
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
  const credentials = { username: "test", password: "synthetic-password" };
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
