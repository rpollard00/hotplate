#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exchange } from "./deploy-unraid";

const root = resolve(import.meta.dirname, "..");
const id = randomUUID();
const prefix = `hotplate-deploy-smoke-${id}`;
const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
const network = `${prefix}-net`;
const controllerImage = `${prefix}:controller`;
const imageTag = `hotplate-release:${id}`;
const checks = [];
process.stdout.write(`${JSON.stringify({ kind: "smoke-start", run: id, directory, network, imageTag, controllerImage })}\n`);
const hash = buffer => createHash("sha256").update(buffer).digest("hex");
const docker = (args, options = {}) => execFileSync("docker", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 600_000, ...options });
const socket = JSON.parse(docker(["context", "inspect"]))[0].Endpoints.docker.Host;
assert.ok(socket.startsWith("unix://"), "Smoke requires a local Unix Docker socket");
const dockerRoot = docker(["info", "--format", "{{.DockerRootDir}}"]).trim();
const locks = join(directory, "locks");
mkdirSync(locks, { mode: 0o700 });
const controllerPath = join(directory, "controller.sh");
const controllerSource = readFileSync(join(root, "scripts/unraid-controller.sh"), "utf8");
writeFileSync(controllerPath, controllerSource, { mode: 0o600 });
const legacyControllerPath = join(directory, "legacy-controller.sh");
const legacyController = controllerSource.replace('candidate_name=${appdata##*/}', 'candidate_name=hotplate-$installation-$(jq -r .operation <<< "$request")').replace('  docker rm "$id" >/dev/null', '  :');
assert.notEqual(legacyController, controllerSource);
writeFileSync(legacyControllerPath, legacyController, { mode: 0o600 });
const controllerFile = join(directory, "Dockerfile");
writeFileSync(controllerFile, `FROM node:24.19.0-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends docker.io jq util-linux && rm -rf /var/lib/apt/lists/*\nCOPY docker-wrapper /usr/local/bin/docker\nCOPY tar-wrapper /usr/local/bin/tar\nCOPY cp-wrapper /usr/local/bin/cp\nRUN chmod 755 /usr/local/bin/docker /usr/local/bin/tar /usr/local/bin/cp\n`);
writeFileSync(join(directory, "docker-wrapper"), `#!/bin/bash
set -e
if [[ $1 == ps ]]; then
  if [[ \${HOTPLATE_TEST_FAILURE:-} == retirement-spec && -f $HOTPLATE_TEST_APPDATA/journal.json && $(jq -r .state "$HOTPLATE_TEST_APPDATA/journal.json") == StartIntent ]]; then
    /usr/bin/docker update --cpu-shares 512 "$(jq -r .previous.id "$HOTPLATE_TEST_APPDATA/journal.json")" >/dev/null
  fi
  if [[ \${HOTPLATE_TEST_FAILURE:-} == listing || ( \${HOTPLATE_TEST_FAILURE:-} == listing-recovery && -e ${directory}/listing-failed ) ]]; then exit 42; fi
  ids=$(/usr/bin/docker "$@")
  for container in $ids; do
    label=$(/usr/bin/docker inspect --format '{{index .Config.Labels "io.hotplate.smoke-controller"}}' "$container")
    if [[ $label != ${id} ]]; then echo "$container"; fi
  done
  exit 0
fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == mount-order* && $1 == image && $2 == load ]]; then
  /usr/bin/docker "$@"; touch "${directory}/$HOTPLATE_TEST_OPERATION.mount-order"; exit 0
fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == mount-order* && $1 == inspect && -e ${directory}/$HOTPLATE_TEST_OPERATION.mount-order ]]; then
  /usr/bin/docker "$@" | jq 'map(.Mounts |= reverse)'; exit 0
fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == retirement-remove && $1 == rm ]]; then
  printf '%s\\n' "$*" > ${directory}/retirement-remove.txt; exit 42
fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == disconnect && $1 == network && $2 == disconnect ]]; then /usr/bin/docker "$@"; exit 1; fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == listing-recovery && $1 == network && $2 == disconnect ]]; then /usr/bin/docker "$@"; touch ${directory}/listing-failed; exit 1; fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == stop-intent && $1 == update && $2 == --restart && $3 == no ]]; then /usr/bin/docker "$@"; /usr/bin/docker kill "$HOTPLATE_TEST_CONTROLLER"; exit 1; fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == start-intent && $1 == create ]]; then /usr/bin/docker kill "$HOTPLATE_TEST_CONTROLLER"; exit 1; fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == sysctl && $1 == create ]]; then exec /usr/bin/docker create --sysctl "net.ipv4.ip_local_port_range=1024 65000" "\${@:2}"; fi
if [[ \${HOTPLATE_TEST_FAILURE:-} == legacy && $1 == create ]]; then
  args=(); while (( $# )); do
    if [[ $1 == --sysctl ]]; then shift 2; else args+=("$1"); shift; fi
  done
  exec /usr/bin/docker "\${args[@]}"
fi
exec /usr/bin/docker "$@"
`);
writeFileSync(join(directory, "tar-wrapper"), `#!/bin/bash
if [[ ( \${HOTPLATE_TEST_FAILURE:-} == backup || \${HOTPLATE_TEST_FAILURE:-} == mount-order-backup ) && $1 == -C ]]; then exit 1; fi
exec /usr/bin/tar "$@"
`);
writeFileSync(join(directory, "cp-wrapper"), `#!/bin/bash
if [[ \${HOTPLATE_TEST_FAILURE:-} == evidence && $2 == */failure.json ]]; then exit 42; fi
exec /usr/bin/cp "$@"
`);
const probeDirectory = join(directory, "probe");
mkdirSync(join(probeDirectory, "scripts"), { recursive: true });
for (const name of ["deploy-unraid", "unraid-controller.sh"]) {
  writeFileSync(join(probeDirectory, "scripts", name), readFileSync(join(root, "scripts", name)));
}
let controllerBuilt = false;
let imageBuilt = false;
let networkCreated = false;
let unhealthyTag;
const installations = new Set();
function controller(request, failure = "") {
  return spawn("docker", ["run", "--rm", "-i", "--hostname", "deploy-smoke", "--name", `${prefix}-controller-${request.operation}`, "--label", `io.hotplate.smoke=${id}`, "--label", `io.hotplate.smoke-controller=${id}`,
    "--mount", `type=bind,source=${directory},target=${directory}`,
    "--mount", `type=bind,source=${locks},target=/run/hotplate-deploy`,
    "--mount", `type=bind,source=${socket.slice(7)},target=/var/run/docker.sock`,
    "--env", `HOTPLATE_TEST_APPDATA=${request.target.appdata}`, "--env", `HOTPLATE_TEST_FAILURE=${failure}`, "--env", `HOTPLATE_TEST_CONTROLLER=${prefix}-controller-${request.operation}`, "--env", `HOTPLATE_TEST_OPERATION=${request.operation}`,
    controllerImage, "bash", "-c", 'mkdir -p "$1"; exec bash -c "$(cat "$2")"', "smoke", dockerRoot, failure === "legacy" ? legacyControllerPath : controllerPath], { stdio: ["pipe", "pipe", "pipe"] });
}
function helper(command, args = []) {
  return docker(["run", "--rm", "--mount", `type=bind,source=${directory},target=${directory}`, controllerImage, command, ...args]);
}
function journal(target) { return JSON.parse(helper("cat", [join(target.appdata, "journal.json")])); }
function inspect(id) { return JSON.parse(docker(["inspect", id]))[0]; }
let release;
let archive;
const managed = { sourceId: randomUUID(), token: randomBytes(32).toString("hex") };
const enrollmentPolicies = new Map();
const credentials = { ingest: [{ sourceId: randomUUID(), machineId: "deployment-smoke", token: randomBytes(32).toString("hex") }], dashboard: { username: "smoke-reader", password: randomBytes(32).toString("hex") } };
function target(suffix, address) {
  const installation = randomUUID(); installations.add(installation);
  return { version: 1, installation, hostName: "deploy-smoke", network, networkDriver: "bridge", address, origin: `http://${address}:7345`, appdata: join(directory, `${prefix}-${suffix}`) };
}
function dashboardPolicy(target) { return new URL(target.origin).port ? { kind: "basic", ...credentials.dashboard } : { kind: "public" }; }
function request(target, command = "apply") {
  const aggregate = { databasePath: "/data/aggregate.sqlite", host: "0.0.0.0", port: Number(new URL(target.origin).port || 80), publicOrigin: target.origin, credentialsFile: "/run/secrets/hotplate-credentials.json", trustedHttp: true, openEnrollment: enrollmentPolicies.get(target.installation) ?? false };
  return { command, target, operation: randomUUID(), release: command === "status" ? null : release, secrets: command === "status" ? null : { aggregate: Buffer.from(JSON.stringify(aggregate)).toString("base64"), credentials: Buffer.from(JSON.stringify({ ...credentials, dashboard: new URL(target.origin).port ? credentials.dashboard : { kind: "public" } })).toString("base64") } };
}
async function bridge(target, code) {
  const child = spawn("docker", ["run", "--rm", "-i", "--network", network, "--label", `io.hotplate.smoke=${id}`,
    "--mount", `type=bind,source=${probeDirectory},target=/probe,readonly`, controllerImage, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {createServer,request} from 'node:http';
    import {probe} from '/probe/scripts/deploy-unraid';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const {origin,dashboard,ingest,managed}=JSON.parse(input);
    ${code}
  `], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ origin: target.origin, dashboard: dashboardPolicy(target), ingest: credentials.ingest[0], managed }));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  try { await new Promise((resolve, reject) => child.once("close", code => code === 0 ? resolve() : reject(new Error(`Local bridge check failed: ${stderr}`)))); }
  finally { clearTimeout(timer); }
}
async function probe(target) {
  await bridge(target, `
    await probe(origin,dashboard);
    if (dashboard.kind === 'public') {
      let requests=0;
      const proxy=createServer(async (request,response) => {
        assert.equal(request.headers.authorization,undefined);
        requests++;
        const upstream=await fetch(origin+request.url,{signal:AbortSignal.timeout(5000)});
        response.writeHead(upstream.status,{'content-type':'application/json'});
        response.end(await upstream.text());
      });
      await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
      try { await probe('http://127.0.0.1:'+proxy.address().port,dashboard); assert.equal(requests,2); }
      finally { proxy.closeAllConnections(); await new Promise(resolve=>proxy.close(resolve)); }
    }
  `);
}
async function apply(target, failure = "", acknowledge = () => probe(target), override = null) {
  const value = override ?? request(target);
  if (failure === "legacy") value.release = { ...value.release, controllerSha256: hash(legacyController) };
  await exchange(controller(value, failure), value, archive, acknowledge);
  return value;
}
function replacementEvidence(target) {
  const current = journal(target);
  const containers = docker(["ps", "-aq", "--filter", `label=io.hotplate.installation=${target.installation}`]).trim().split(/\s+/).filter(Boolean).map(inspect);
  const actual = { count: containers.length, name: inspect(current.candidate).Name };
  const expected = { count: 1, name: `/${basename(target.appdata)}` };
  console.log(JSON.stringify({ kind: "replacement-evidence", actual, expected }));
  assert.deepEqual(actual, expected);
}
async function refusal(target, command = "plan") {
  const value = request(target, command);
  await assert.rejects(exchange(controller(value), value, null, () => assert.fail()));
}
try {
  docker(["build", "--tag", controllerImage, directory], { stdio: "inherit" }); controllerBuilt = true;
  docker(["build", "--platform", "linux/amd64", "--tag", imageTag, "."], { stdio: "inherit" }); imageBuilt = true;
  docker(["network", "create", "--label", `io.hotplate.smoke=${id}`, network]); networkCreated = true;
  const subnet = JSON.parse(docker(["network", "inspect", network]))[0].IPAM.Config[0].Subnet;
  const octets = subnet.split("/")[0].split(".");
  const ip = number => [...octets.slice(0, 3), String(number)].join(".");
  archive = join(directory, "image.tar");
  docker(["save", "--output", archive, imageTag]);
  release = { version: 1, revision: "a".repeat(40), tag: imageTag, imageId: JSON.parse(docker(["image", "inspect", imageTag]))[0].Id, platform: "linux/amd64", archiveSha256: hash(readFileSync(archive)), archiveBytes: statSync(archive).size, controllerSha256: hash(readFileSync(controllerPath)) };
  if (process.argv.includes("--regressions")) {
    const failures = [];
    async function expectRejection(label, operation) {
      try { await operation(); failures.push(`${label}: command incorrectly succeeded`); } catch {}
    }
    const legacy = target("retirement-legacy", ip(26));
    await apply(legacy, "legacy");
    const historical = journal(legacy);
    await apply(legacy, "legacy");
    const predecessor = journal(legacy);
    assert.equal(inspect(historical.candidate).State.Running, false);
    assert.equal(inspect(historical.candidate).HostConfig.RestartPolicy.Name, "no");
    const assertUntouched = async () => {
      for (const command of ["plan", "apply"]) await refusal(legacy, command);
      assert.deepEqual(journal(legacy), predecessor);
      assert.equal(inspect(predecessor.candidate).State.Running, true);
    };
    const collision = docker(["create", "--name", basename(legacy.appdata), "--label", `io.hotplate.smoke=${id}`, "--network", "none", controllerImage, "true"]).trim();
    await assertUntouched();
    assert.equal(inspect(collision).State.Status, "created");
    docker(["rm", collision]);
    const bootstrapCollision = target("name.collision", ip(27));
    const similarName = docker(["create", "--name", basename(bootstrapCollision.appdata).replace(".", "_"), "--label", `io.hotplate.smoke=${id}`, "--network", "none", controllerImage, "true"]).trim();
    const availableName = request(bootstrapCollision, "plan");
    await exchange(controller(availableName), availableName, null, () => assert.fail());
    docker(["rm", similarName]);
    const occupied = docker(["create", "--name", basename(bootstrapCollision.appdata), "--label", `io.hotplate.smoke=${id}`, "--network", "none", controllerImage, "true"]).trim();
    for (const command of ["plan", "apply"]) await refusal(bootstrapCollision, command);
    assert.throws(() => statSync(bootstrapCollision.appdata));
    docker(["rm", occupied]);
    for (const basename of ["_invalid", "-invalid"]) {
      const invalidName = { ...target("invalid-name", ip(28)), appdata: join(directory, basename) };
      for (const command of ["plan", "apply"]) await refusal(invalidName, command);
      assert.throws(() => statSync(invalidName.appdata));
    }
    console.log(JSON.stringify({ kind: "retirement-refusal", checks: ["occupied name on bootstrap and legacy update", "invalid Docker name"], currentUnchanged: true }));
    const labelOnly = docker(["create", "--label", `io.hotplate.smoke=${id}`, "--label", `io.hotplate.installation=${legacy.installation}`, "--network", "none", controllerImage, "true"]).trim();
    await assertUntouched();
    assert.equal(inspect(labelOnly).State.Status, "created");
    docker(["rm", labelOnly]);
    const unowned = docker(["create", "--label", `io.hotplate.smoke=${id}`, "--network", "none", "--mount", `type=bind,source=${legacy.appdata}/data,target=/foreign`, controllerImage, "sleep", "300"]).trim();
    await assertUntouched();
    docker(["start", unowned]);
    await assertUntouched();
    assert.equal(inspect(unowned).State.Running, true);
    docker(["stop", "--time", "1", unowned]);
    docker(["rm", unowned]);
    docker(["update", "--restart", "always", historical.candidate]);
    await assertUntouched();
    docker(["update", "--restart", "no", historical.candidate]);
    docker(["start", historical.candidate]);
    await assertUntouched();
    assert.equal(inspect(historical.candidate).State.Running, true);
    docker(["stop", "--time", "15", historical.candidate]);
    const unrecorded = docker(["create", "--label", `io.hotplate.smoke=${id}`, "--label", `io.hotplate.installation=${legacy.installation}`,
      "--label", `io.hotplate.operation=${historical.operation}`, "--label", `io.hotplate.image=${historical.runtimeImageId}`,
      "--restart", "no", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--network", network,
      "--mount", `type=bind,source=${legacy.appdata}/data,target=/data`,
      "--mount", `type=bind,source=${legacy.appdata}/operations/${historical.operation}/aggregate.json,target=/run/secrets/hotplate.json,readonly`,
      "--mount", `type=bind,source=${legacy.appdata}/operations/${historical.operation}/credentials.json,target=/run/secrets/hotplate-credentials.json,readonly`,
      historical.runtimeImageId]).trim();
    docker(["start", unrecorded]);
    docker(["stop", "--time", "15", unrecorded]);
    docker(["network", "disconnect", network, unrecorded]);
    await assertUntouched();
    assert.equal(inspect(unrecorded).State.Status, "exited");
    docker(["rm", unrecorded]);
    const historicalRelease = join(legacy.appdata, "operations", historical.operation, "release.json");
    helper("chmod", ["644", historicalRelease]);
    await assertUntouched();
    helper("chmod", ["600", historicalRelease]);
    console.log(JSON.stringify({ kind: "retirement-refusal", checks: ["label-only container", "matching labels and mounts without historical journal binding", "unowned stopped/running data mount", "historical restart policy", "running historical container", "nonprivate historical evidence"], currentUnchanged: true }));
    await apply(legacy);
    replacementEvidence(legacy);
    const cleaned = journal(legacy);
    const retirement = JSON.parse(helper("cat", [cleaned.retirement.path]));
    assert.deepEqual(retirement.map(entry => entry.spec.Id).sort(), [historical.candidate, predecessor.candidate].sort());
    assert.equal(helper("sha256sum", [cleaned.retirement.path]).split(" ")[0], cleaned.retirement.sha256);
    for (const retained of [historical, predecessor]) {
      assert.equal(helper("sha256sum", [retained.backup.path]).split(" ")[0], retained.backup.sha256);
      assert.equal(inspect(cleaned.candidate).Image, retained.runtimeImageId);
    }
    await apply(legacy);
    replacementEvidence(legacy);
    console.log(JSON.stringify({ kind: "retirement-cleanup", removed: retirement.map(entry => entry.spec.Id), evidence: cleaned.retirement, retainedBackups: [historical.backup.path, predecessor.backup.path] }));
    const changedSpec = target("retirement-changed-spec", ip(30));
    await apply(changedSpec, "legacy");
    const changedHistorical = journal(changedSpec);
    await apply(changedSpec, "legacy");
    const unchangedCurrent = journal(changedSpec);
    docker(["update", "--cpu-shares", "512", changedHistorical.candidate]);
    for (const command of ["plan", "apply"]) await refusal(changedSpec, command);
    assert.deepEqual(journal(changedSpec), unchangedCurrent);
    assert.equal(inspect(unchangedCurrent.candidate).State.Running, true);
    assert.equal(inspect(changedHistorical.candidate).HostConfig.CpuShares, 512);
    console.log(JSON.stringify({ kind: "retirement-refusal", checks: ["changed historical full specification"], currentUnchanged: true }));
    const refusedRemoval = target("retirement-remove", ip(29));
    await apply(refusedRemoval);
    const old = journal(refusedRemoval);
    await assert.rejects(apply(refusedRemoval, "retirement-remove"));
    const failedRemoval = journal(refusedRemoval);
    assert.equal(failedRemoval.state, "RecoveryRequired");
    assert.equal(failedRemoval.evidence.state, "StartIntent");
    assert.equal(failedRemoval.evidence.candidate, undefined);
    assert.equal(inspect(old.candidate).State.Running, false);
    assert.equal(inspect(old.candidate).HostConfig.RestartPolicy.Name, "no");
    assert.deepEqual(inspect(old.candidate).NetworkSettings.Networks, {});
    assert.equal(helper("cat", [join(directory, "retirement-remove.txt")]).trim(), `rm ${old.candidate}`);
    assert.equal(helper("sha256sum", [failedRemoval.evidence.backup.path]).split(" ")[0], failedRemoval.evidence.backup.sha256);
    await refusal(refusedRemoval);
    console.log(JSON.stringify({ kind: "retirement-remove-refused", state: failedRemoval.state, predecessor: old.candidate, restart: "no", running: false, automaticRollback: false }));
    const changedAfterIntent = target("retirement-spec", ip(31));
    await apply(changedAfterIntent);
    const beforeIntent = journal(changedAfterIntent);
    await assert.rejects(apply(changedAfterIntent, "retirement-spec"));
    const afterIntent = journal(changedAfterIntent);
    assert.equal(afterIntent.state, "RecoveryRequired");
    assert.equal(afterIntent.evidence.state, "StartIntent");
    assert.equal(afterIntent.evidence.candidate, undefined);
    assert.equal(inspect(beforeIntent.candidate).State.Running, false);
    assert.equal(inspect(beforeIntent.candidate).HostConfig.CpuShares, 512);
    console.log(JSON.stringify({ kind: "retirement-refusal", checks: ["full specification changed after StartIntent"], removed: false, automaticRollback: false }));
    const sysctl = target("sysctl-regression", ip(24));
    await expectRejection("sysctl", () => apply(sysctl, "sysctl"));
    const sysctlJournal = journal(sysctl);
    assert.equal(sysctlJournal.state, "RecoveryRequired");
    assert.equal(inspect(sysctlJournal.evidence.candidate).State.Running, false);
    const mutable = target("v2-origin-regression", ip(25));
    await apply(mutable);
    const marker = helper("cat", [join(mutable.appdata, "installation.json")]);
    assert.equal(JSON.parse(marker).version, 2);
    mutable.origin = `http://${mutable.address}`;
    await apply(mutable);
    assert.equal(helper("cat", [join(mutable.appdata, "installation.json")]), marker);
    const ownership = target("ownership-regression", ip(20));
    await expectRejection("ownership", () => apply(ownership, "", async candidate => {
      const operation = inspect(candidate).Config.Labels["io.hotplate.operation"];
      helper("chmod", ["644", join(ownership.appdata, "operations", operation, "credentials.json")]);
    }));
    const ownershipJournal = journal(ownership);
    if (ownershipJournal.state === "Healthy") failures.push("ownership: recorded Healthy after ownership rejection");
    const ownershipCandidate = ownershipJournal.candidate ?? ownershipJournal.evidence?.candidate;
    if (inspect(ownershipCandidate).HostConfig.RestartPolicy.Name !== "no") failures.push("ownership: enabled candidate restart");
    const listing = target("listing-regression", ip(21));
    const listingRequest = request(listing, "plan");
    await expectRejection("listing", () => exchange(controller(listingRequest, "listing"), listingRequest, null, () => assert.fail()));
    const recovery = target("listing-recovery-regression", ip(22));
    await apply(recovery);
    const previous = journal(recovery).candidate;
    await expectRejection("listing recovery", () => apply(recovery, "listing-recovery"));
    if (inspect(previous).State.Running) failures.push("listing recovery: restarted old container without enumerating writers");
    if (journal(recovery).state !== "RecoveryRequired") failures.push("listing recovery: cleared recovery requirement");
    const evidence = target("evidence-regression", ip(23));
    await expectRejection("evidence", () => apply(evidence, "evidence", () => { throw new Error("Probe unavailable"); }));
    const evidenceJournal = journal(evidence);
    const evidenceCandidate = evidenceJournal.candidate ?? evidenceJournal.evidence?.candidate;
    if (inspect(evidenceCandidate).State.Running) failures.push("evidence: write failure skipped candidate shutdown");
    if (inspect(evidenceCandidate).HostConfig.RestartPolicy.Name !== "no") failures.push("evidence: retained restart policy");
    process.stdout.write(`${JSON.stringify({ kind: failures.length ? "failed" : "passed", regressions: failures })}\n`);
    assert.deepEqual(failures, []);
  } else {
  docker(["run", "--rm", "--network", "none", "--label", `io.hotplate.smoke=${id}`, "--read-only", "--user", "0",
    "--tmpfs", "/tmp:rw,nosuid,nodev", "--entrypoint", "node", imageTag, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {mkdirSync,existsSync} from 'node:fs';
    import {SessionConnection} from '/app/dist/src/connection.js';
    mkdirSync('/tmp/account',{mode:0o755}); mkdirSync('/tmp/account/hotplate',{mode:0o700});
    process.setgid(1000); process.setuid(1000);
    const connection=new SessionConnection(()=>[],{XDG_DATA_HOME:'/tmp/account',HOTPLATE_DB:'/tmp/local.sqlite'});
    await connection.start({type:'session_start',reason:'startup'},{ui:{setStatus(){}}});
    assert.equal((await connection.status()).mode,'unavailable');
    assert.equal(existsSync('/tmp/local.sqlite'),false);
    await connection.close();
  `]);
  checks.push("UID1000 managed client refuses a foreign-owned private account directory without local fallback");
  const primary = target("primary", ip(12));
  const plan = request(primary, "plan");
  await exchange(controller(plan), plan, null, () => assert.fail());
  assert.throws(() => statSync(primary.appdata));
  checks.push("Plan does not create appdata");
  await apply(primary, "legacy");
  let current = journal(primary);
  assert.equal(current.state, "Healthy");
  const first = current.candidate;
  assert.equal(inspect(first).HostConfig.RestartPolicy.Name, "unless-stopped");
  assert.ok(inspect(first).HostConfig.Sysctls == null || Object.keys(inspect(first).HostConfig.Sysctls).length === 0);
  const markerPath = join(primary.appdata, "installation.json");
  const v2Marker = JSON.parse(helper("cat", [markerPath]));
  assert.equal(v2Marker.version, 2);
  const { origin: legacyOrigin, ...ownershipTarget } = primary;
  const canonical = value => JSON.stringify(value, Object.keys(value).sort());
  assert.equal(v2Marker.targetSha256, hash(canonical(ownershipTarget)));
  const legacyMarker = { ...v2Marker, version: 1, targetSha256: hash(canonical(primary)) };
  const setMarker = marker => helper("node", ["-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2]+'\\n')", markerPath, JSON.stringify(marker)]);
  setMarker(legacyMarker);
  const oldOperation = current.operation;
  const oldAggregate = helper("cat", [join(primary.appdata, "operations", oldOperation, "aggregate.json")]);
  const oldCredentials = helper("cat", [join(primary.appdata, "operations", oldOperation, "credentials.json")]);
  await bridge(primary, `
    const authorization='Basic '+Buffer.from(dashboard.username+':'+dashboard.password).toString('base64');
    assert.equal((await fetch(origin+'/api/dashboard')).status,401);
    const observation={id:'persistence-observation',producerId:'smoke',sequence:1,observedAt:'2026-02-03T04:05:06.000Z',
      scope:{projectCwd:'/smoke',sessionId:'session',sessionFile:'/session.jsonl',segmentId:'segment',segmentReason:'startup',runId:'run',turnId:'turn',leafId:null},
      evidence:{kind:'command-intent',skillName:'alpha',source:'interactive'}};
    const response=await fetch(origin+'/api/ingest',{method:'POST',headers:{authorization:'Bearer '+ingest.token,'content-type':'application/json'},
      body:JSON.stringify({version:1,sourceId:ingest.sourceId,observations:[observation]})});
    assert.equal(response.status,200);
    const data=await fetch(origin+'/api/dashboard',{headers:{authorization}}).then(response=>response.json());
    assert.equal(data.overview.observationCount,1);
  `);
  await bridge(primary, `
    assert.equal((await fetch(origin+'/api/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,...managed})})).status,403);
  `);
  primary.origin = `http://${primary.address}`;
  for (const mutation of [{ installation: randomUUID() }, { appdata: `${primary.appdata}-other` }, { networkId: "f".repeat(64) },
    { targetSha256: hash(canonical(primary)) }, { version: 3 }, { unexpected: true }]) {
    setMarker({ ...legacyMarker, ...mutation });
    await refusal(primary);
  }
  setMarker(legacyMarker);
  for (const mutation of [{ hostName: "other" }, { address: ip(19), origin: `http://${ip(19)}` }]) await refusal({ ...primary, ...mutation });
  const healthyBeforeInvalidPolicy = journal(primary);
  const startedBeforeInvalidPolicy = inspect(first).State.StartedAt;
  for (const dashboard of [undefined, null, {}, { kind: "public", password: "invalid" }, { kind: "unknown" },
    { username: "reader", password: "short" }, { username: "reader", password: credentials.ingest[0].token }]) {
    for (const command of ["plan", "apply"]) {
      const invalid = request(primary, command);
      invalid.secrets.credentials = Buffer.from(JSON.stringify({ ...credentials, dashboard })).toString("base64");
      await assert.rejects(exchange(controller(invalid), invalid, null, () => assert.fail()));
      assert.deepEqual(journal(primary), healthyBeforeInvalidPolicy);
      assert.equal(inspect(first).State.Running, true);
      assert.equal(inspect(first).State.StartedAt, startedBeforeInvalidPolicy);
      assert.equal(helper("cat", [join(primary.appdata, "operations", oldOperation, "credentials.json")]), oldCredentials);
    }
  }
  for (const openEnrollment of [null, 1, "true", {}, []]) {
    for (const command of ["plan", "apply"]) {
      const invalid = request(primary, command);
      const aggregate = JSON.parse(Buffer.from(invalid.secrets.aggregate, "base64").toString());
      invalid.secrets.aggregate = Buffer.from(JSON.stringify({ ...aggregate, openEnrollment })).toString("base64");
      await assert.rejects(exchange(controller(invalid), invalid, null, () => assert.fail()));
      assert.deepEqual(journal(primary), healthyBeforeInvalidPolicy);
      assert.equal(inspect(first).State.StartedAt, startedBeforeInvalidPolicy);
    }
  }
  checks.push("Malformed enrollment policies refuse plan/apply without changing the healthy service");
  checks.push("Malformed dashboard policies refuse direct-controller plan and apply without changing the healthy service or journal");
  for (const field of ["ingest", "aggregate"]) {
    const changed = request(primary, "plan");
    const key = field === "ingest" ? "credentials" : "aggregate";
    const value = JSON.parse(Buffer.from(changed.secrets[key], "base64").toString());
    if (field === "ingest") value.ingest[0].token = randomBytes(32).toString("hex");
    else value.databasePath = "/data/other.sqlite";
    changed.secrets[key] = Buffer.from(JSON.stringify(value)).toString("base64");
    await assert.rejects(exchange(controller(changed), changed, null, () => assert.fail()));
  }
  await assert.rejects(apply(primary, "mount-order-backup"));
  assert.equal(journal(primary).candidate, first);
  await probe({ ...primary, origin: legacyOrigin });
  checks.push("Legacy marker tampering and immutable configuration changes refused; pre-start recovery retains Basic port7345");
  docker(["exec", first, "node", "-e", "require('node:fs').writeFileSync('/data/persistence-proof','retained')"]);
  enrollmentPolicies.set(primary.installation, true);
  await apply(primary, "mount-order");
  current = journal(primary);
  assert.notEqual(current.candidate, first);
  replacementEvidence(primary);
  assert.throws(() => inspect(first));
  assert.equal(docker(["exec", current.candidate, "cat", "/data/persistence-proof"]).trim(), "retained");
  assert.match(helper("tar", ["-tf", current.backup.path]), /aggregate.sqlite/);
  assert.match(helper("tar", ["-tf", current.backup.path]), /persistence-proof/);
  assert.equal(helper("sha256sum", [current.backup.path]).split(" ")[0], current.backup.sha256);
  assert.equal(helper("cat", [join(primary.appdata, "operations", oldOperation, "aggregate.json")]), oldAggregate);
  assert.equal(helper("cat", [join(primary.appdata, "operations", oldOperation, "credentials.json")]), oldCredentials);
  assert.deepEqual(JSON.parse(helper("cat", [markerPath])), legacyMarker);
  assert.equal(docker(["exec", current.candidate, "id", "-u"]).trim(), "1000");
  assert.equal(inspect(current.candidate).State.Health.Status, "healthy");
  assert.deepEqual(inspect(current.candidate).HostConfig.Sysctls, { "net.ipv4.ip_unprivileged_port_start": "0" });
  await bridge(primary, `
    for (const path of ['/','/health','/assets/app.js','/api/dashboard']) {
      assert.equal((await fetch(origin+path)).status,200);
      const wrongHost=await new Promise((resolve,reject)=>{
        const req=request(origin+path,{headers:{host:'wrong.invalid'},timeout:5000},response=>{
          response.resume(); response.on('end',()=>resolve(response.statusCode));
        });
        req.on('error',reject); req.on('timeout',()=>req.destroy(new Error('Host probe timeout'))); req.end();
      });
      assert.equal(wrongHost,403);
      assert.equal((await fetch(origin+path,{headers:{origin:'http://wrong.invalid'}})).status,403);
      assert.equal((await fetch(origin+path,{method:'POST'})).status,405);
    }
    assert.equal((await fetch(origin+'/api/ingest',{method:'POST',body:'not json'})).status,401);
    const data=await fetch(origin+'/api/dashboard').then(response=>response.json());
    assert.equal(data.overview.observationCount,1);
    assert.deepEqual(data.filterOptions.machines,['deployment-smoke']);
  `);
  const backupDirectory = join(primary.appdata, "backup-verification");
  helper("mkdir", ["-m", "700", backupDirectory]);
  helper("tar", ["-xf", current.backup.path, "-C", backupDirectory]);
  helper("node", ["-e", "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); if(db.prepare('SELECT count(*) AS count FROM observations').get().count!==1)process.exit(1); db.close();", join(backupDirectory, "aggregate.sqlite")]);
  checks.push("Legacy Basic7345/absent-sysctl upgrades to public80 as UID1000; production probe sends no Authorization; health, read-only/Host/Origin/ingest guards and database backup verified");
  const managedCheck = (register, sequence) => `
    const registration=await fetch(origin+'/api/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,...managed}),signal:AbortSignal.timeout(5000)});
    assert.equal(registration.status,200);
    assert.deepEqual(await registration.json(),{version:1,sourceId:managed.sourceId,machineId:'managed-'+managed.sourceId});
    const observation={id:'managed-'+${sequence},producerId:'managed-smoke',sequence:${sequence},observedAt:'2026-02-03T04:05:06.000Z',
      scope:{projectCwd:'/managed-smoke',sessionId:null,sessionFile:null,segmentId:'live',segmentReason:'startup',runId:null,turnId:null,leafId:null},
      evidence:{kind:'command-intent',skillName:'managed',source:'interactive'}};
    const response=await fetch(origin+'/api/ingest',{method:'POST',headers:{authorization:'Bearer '+managed.token,'content-type':'application/json'},
      body:JSON.stringify({version:1,sourceId:managed.sourceId,observations:[observation]}),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200); assert.equal((await response.json()).${register ? "accepted" : "duplicate"},1);
    const data=await fetch(origin+'/api/dashboard').then(response=>response.json());
    assert.equal(data.overview.observationCount,${sequence + 1});
  `;
  await bridge(primary, managedCheck(true, 1));
  docker(["restart", "--time", "15", current.candidate]);
  await bridge(primary, `
    for(let i=0;;i++){try{await probe(origin,dashboard);break;}catch(error){if(i===59)throw error;await new Promise(resolve=>setTimeout(resolve,200));}}
    ${managedCheck(false, 1)}
  `);
  await bridge(primary, managedCheck(true, 2));
  for (let attempt = 0; inspect(current.candidate).State.Health.Status !== "healthy"; attempt++) {
    assert.ok(attempt < 60, "Restarted managed collector did not become Docker healthy");
    await delay(500);
  }
  enrollmentPolicies.set(primary.installation, false);
  await apply(primary);
  current = journal(primary);
  replacementEvidence(primary);
  await bridge(primary, `
    ${managedCheck(false, 2)}
    const refused=await fetch(origin+'/api/enroll',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({version:1,sourceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',token:'x'.repeat(64)})});
    assert.equal(refused.status,403);
  `);
  assert.equal(helper("cat", [join(primary.appdata, "operations", oldOperation, "credentials.json")]), oldCredentials);
  checks.push("Public80 open enrollment assigns a scoped identity; UID1000/read-only container restart preserves dynamic ingest, deduplication and data; closed replacement permits exact retry but refuses new registration without changing static credentials");
  const wrong = { ...primary, installation: randomUUID() };
  await refusal(wrong);
  const unmarked = target("unmarked", ip(13));
  mkdirSync(unmarked.appdata, { mode: 0o700 });
  await refusal(unmarked);
  checks.push("Foreign marker and unmarked appdata are refused");
  const foreignName = `${prefix}-foreign`;
  docker(["run", "-d", "--name", foreignName, "--label", `io.hotplate.smoke=${id}`, "--network", network, "--mount", `type=bind,source=${primary.appdata}/data,target=/foreign`, "--entrypoint", "sleep", controllerImage, "300"]);
  await refusal(primary);
  docker(["rm", "-f", foreignName]);
  checks.push("Unexpected data writer is refused without mutation");
  const corrupt = request(primary);
  corrupt.release = { ...release, archiveSha256: "0".repeat(64) };
  await assert.rejects(apply(primary, "", undefined, corrupt));
  assert.equal(journal(primary).state, "Healthy");
  assert.equal(inspect(current.candidate).HostConfig.RestartPolicy.Name, "unless-stopped");
  checks.push("Corrupt upload refuses load and preserves old availability");
  for (const failure of ["backup", "disconnect"]) {
    await assert.rejects(apply(primary, failure));
    assert.equal(journal(primary).state, "Healthy");
    assert.equal(inspect(current.candidate).State.Running, true);
    assert.equal(inspect(current.candidate).HostConfig.RestartPolicy.Name, "unless-stopped");
    await probe(primary);
  }
  checks.push("Backup/disconnect failures restore exact old network and restart policy before candidate intent");
  let releaseProbe;
  let entered;
  const held = new Promise(resolve => { releaseProbe = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const active = apply(primary, "", async () => { entered(); await held; await probe(primary); });
  await reached;
  const competing = request(primary);
  await assert.rejects(exchange(controller(competing), competing, null, () => assert.fail()));
  releaseProbe();
  await active;
  replacementEvidence(primary);
  checks.push("Competing controller is refused while acknowledgment retains the lock");
  await assert.rejects(apply(primary, "", () => { throw new Error("Probe unavailable"); }));
  current = journal(primary);
  assert.equal(current.state, "RecoveryRequired");
  assert.equal(inspect(current.evidence.candidate).State.Running, false);
  assert.equal(inspect(current.evidence.candidate).HostConfig.RestartPolicy.Name, "no");
  assert.ok(statSync(primary.appdata));
  await refusal(primary);
  checks.push("Missing acknowledgment stops candidate, preserves backup, and blocks later apply");
  const health = target("health", ip(14));
  unhealthyTag = `hotplate-release:${randomUUID()}`;
  docker(["build", "--tag", unhealthyTag, "-"], { input: `FROM ${imageTag}\nHEALTHCHECK --interval=1s --start-period=1s --timeout=1s --retries=1 CMD ["node", "-e", "process.exit(1)"]\n` });
  const healthyArchive = archive;
  archive = join(directory, "unhealthy.tar");
  docker(["save", "--output", archive, unhealthyTag]);
  const unhealthy = request(health);
  unhealthy.release = { ...release, tag: unhealthyTag, imageId: JSON.parse(docker(["image", "inspect", unhealthyTag]))[0].Id, archiveSha256: hash(readFileSync(archive)), archiveBytes: statSync(archive).size };
  await assert.rejects(apply(health, "", undefined, unhealthy));
  archive = healthyArchive;
  const healthJournal = journal(health);
  assert.equal(healthJournal.state, "RecoveryRequired");
  assert.equal(inspect(healthJournal.evidence.candidate).State.Running, false);
  checks.push("Failed Docker health stops owned candidate without restoring data");
  const timeout = target("ack-timeout", ip(17));
  await assert.rejects(apply(timeout, "", () => delay(35_000)));
  const timedOut = journal(timeout);
  assert.equal(timedOut.state, "RecoveryRequired");
  assert.equal(inspect(timedOut.evidence.candidate).State.Running, false);
  checks.push("Acknowledgment timeout stops candidate and preserves recovery evidence");
  const status = request(timeout, "status");
  await exchange(controller(status), status, null, () => assert.fail());
  const interrupted = target("interrupted", ip(15));
  await apply(interrupted);
  await assert.rejects(apply(interrupted, "stop-intent"));
  assert.equal(journal(interrupted).state, "StopIntent");
  await refusal(interrupted);
  const start = target("start-interrupted", ip(16));
  await assert.rejects(apply(start, "start-intent"));
  assert.equal(journal(start).state, "StartIntent");
  await refusal(start);
  checks.push("SIGKILL at stop/start intent retains incomplete journal and blocks apply");
  console.log(JSON.stringify({ kind: "passed", checks, limitation: "Local rootless bridge probes do not prove Unraid macvlan workstation reachability." }, null, 2));
  }
} finally {
  for (const installation of installations) {
    const ids = docker(["ps", "-aq", "--filter", `label=io.hotplate.installation=${installation}`]).trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      console.log(JSON.stringify({ kind: "smoke-cleanup-inventory", installation, containers: ids.map(id => { const spec = inspect(id); return { id: spec.Id, name: spec.Name, running: spec.State.Running, restart: spec.HostConfig.RestartPolicy.Name }; }) }));
      docker(["rm", "-f", ...ids]);
    }
  }
  const helpers = docker(["ps", "-aq", "--filter", `label=io.hotplate.smoke=${id}`]).trim().split(/\s+/).filter(Boolean);
  if (helpers.length) docker(["rm", "-f", ...helpers]);
  if (networkCreated) docker(["network", "rm", network]);
  if (controllerBuilt) helper("sh", ["-c", 'find "$1" -mindepth 1 -delete', "cleanup", directory]);
  if (unhealthyTag) docker(["image", "rm", unhealthyTag]);
  if (imageBuilt) docker(["image", "rm", imageTag]);
  if (controllerBuilt) docker(["image", "rm", controllerImage]);
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ kind: "smoke-cleaned", run: id, installations: [...installations], directory, network })}\n`);
}
