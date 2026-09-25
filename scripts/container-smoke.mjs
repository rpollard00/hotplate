import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const id = `hotplate-smoke-${randomUUID()}`;
const image = `${id}:test`;
const volume = `${id}-data`;
const dir = await mkdtemp(join(tmpdir(), "hotplate-container-"));
const secrets = join(dir, "secrets");
const root = resolve(import.meta.dirname, "..");
const checks = [];
let containerCreated = false;
let volumeCreated = false;
let imageCreated = false;
function docker(args, options = {}) { return execFileSync("docker", args, { cwd: root, encoding: "utf8", ...options }); }
async function port() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise(resolve => listener.close(resolve));
  return address.port;
}
async function until(check) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if (await check()) return; } catch {}
    await delay(500);
  }
  assert.fail("Container startup timed out");
}
try {
  await mkdir(secrets, { mode: 0o755 });
  const hostPort = await port();
  const origin = `http://127.0.0.1:${hostPort}`;
  const sourceIds = [randomUUID(), randomUUID()];
  const machines = ["smoke-a", "smoke-b"];
  const credentials = {
    ingest: sourceIds.map((sourceId, index) => ({ sourceId, machineId: machines[index], token: randomBytes(32).toString("hex") })),
    dashboard: { username: "smoke-reader", password: randomBytes(24).toString("hex") },
  };
  const configuration = { databasePath: "/data/aggregate.sqlite", host: "0.0.0.0", port: 7345,
    publicOrigin: origin, credentialsFile: "/run/secrets/hotplate-credentials.json", trustedHttp: true };
  for (const [name, value] of [["hotplate.json", configuration], ["hotplate-credentials.json", credentials]]) {
    const path = join(secrets, name);
    await writeFile(path, JSON.stringify(value));
    await chmod(path, 0o444);
  }
  docker(["build", "--tag", image, "."], { stdio: "inherit" });
  imageCreated = true;
  assert.throws(() => docker(["run", "--rm", "--network", "none", image], { stdio: "pipe" }), "Missing mounted configuration must refuse startup");
  checks.push("Missing configuration refuses startup");
  docker(["volume", "create", volume]);
  volumeCreated = true;
  function launch() {
    docker(["run", "--detach", "--name", id, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--stop-timeout", "15", "--publish", `127.0.0.1:${hostPort}:7345`, "--mount", `type=volume,source=${volume},target=/data`,
      "--mount", `type=bind,source=${secrets},target=/run/secrets,readonly`, image]);
    containerCreated = true;
  }
  const authorization = `Basic ${Buffer.from(`${credentials.dashboard.username}:${credentials.dashboard.password}`).toString("base64")}`;
  function get(path, auth = authorization) { return fetch(`${origin}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) }); }
  function ingest(index, observation) {
    return fetch(`${origin}/api/ingest`, { method: "POST", headers: { Authorization: `Bearer ${credentials.ingest[index].token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, sourceId: sourceIds[index], observations: [observation] }), signal: AbortSignal.timeout(5000) });
  }
  launch();
  await until(async () => (await get("/health")).status === 200);
  assert.equal(docker(["exec", id, "id", "-u"]).trim(), "1000");
  docker(["exec", id, "node", "scripts/container-healthcheck.mjs", "/run/secrets/hotplate.json"]);
  assert.equal((await get("/api/dashboard", "")).status, 401);
  assert.equal((await get("/api/dashboard", `Bearer ${credentials.ingest[0].token}`)).status, 401);
  assert.equal((await fetch(`${origin}/api/ingest`, { method: "POST", headers: { Authorization: authorization } })).status, 401);
  checks.push("Non-root startup, authenticated healthcheck, anonymous rejection, and read/ingest role separation");
  const observation = { id: "same-observation", producerId: "same-producer", sequence: 1, observedAt: "2026-01-01T00:00:00.000Z",
    scope: { projectCwd: "/synthetic", sessionId: "same-session", sessionFile: null, segmentId: "same-segment", segmentReason: "startup", runId: "same-run", turnId: "same-turn", leafId: null },
    evidence: { kind: "read-result", skill: { name: "<script>synthetic</script>", canonicalPath: "/synthetic/skill/SKILL.md", version: null },
      toolCallId: "same-tool", outcome: "success", model: { provider: "synthetic", id: "synthetic-model" } } };
  for (const index of [0, 1]) {
    const response = await ingest(index, observation);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, 1);
  }
  const duplicate = await ingest(0, observation);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, 1);
  let payload = await get("/api/dashboard").then(response => response.json());
  assert.equal(payload.overview.observationCount, 2);
  assert.deepEqual(payload.filterOptions.machines, machines);
  for (const machine of machines) {
    const filtered = await get(`/api/dashboard?machineId=${machine}`).then(response => response.json());
    assert.equal(filtered.overview.observationCount, 1);
    assert.equal(filtered.skills.rows[0].machineId, machine);
  }
  checks.push("Two credential-bound identities with colliding observation IDs, duplicate suppression, and machine-filtered queries");
  docker(["stop", id]);
  assert.equal(JSON.parse(docker(["inspect", id]))[0].State.ExitCode, 0);
  docker(["rm", id]);
  containerCreated = false;
  launch();
  await until(async () => (await get("/health")).status === 200);
  payload = await get("/api/dashboard").then(response => response.json());
  assert.equal(payload.overview.observationCount, 2);
  const replay = await ingest(1, observation);
  assert.equal((await replay.json()).duplicate, 1);
  await until(async () => JSON.parse(docker(["inspect", id]))[0].State.Health.Status === "healthy");
  checks.push("SIGTERM exit 0, container replacement on the named volume, persisted deduplication, and Docker healthy state");
  if (process.argv.includes("--browser")) {
    const browser = spawn(process.execPath, [join(root, "scripts/browser-smoke.mjs")], { stdio: ["pipe", "inherit", "inherit"] });
    const done = once(browser, "exit");
    browser.stdin.end(JSON.stringify({ url: origin, ...credentials.dashboard, machines, sourceIds }));
    assert.equal((await done)[0], 0);
    checks.push("Chromium rendered machine controls, switching, labels, reset, safe text, and empty browser storage");
  }
  const report = { kind: "passed", checks, imageBase: "node:24.19.0-bookworm-slim", syntheticOnly: true };
  if (process.env.HOTPLATE_SMOKE_REPORT) await writeFile(process.env.HOTPLATE_SMOKE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (containerCreated) { docker(["stop", id]); docker(["rm", id]); }
  if (volumeCreated) docker(["volume", "rm", volume]);
  if (imageCreated) docker(["image", "rm", image]);
  await rm(dir, { recursive: true, force: true });
}
