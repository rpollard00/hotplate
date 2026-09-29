import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const major = process.argv[2];
if (!["1", "2"].includes(major) || !process.argv[3]) throw new Error("Usage: node scripts/probe-opencode.mjs <1|2> <binary> [build-directory]");
const binary = resolve(process.argv[3]);
const build = resolve(process.argv[4] ?? "dist");
const root = await mkdtemp(join(tmpdir(), `hotplate-opencode-${major}-`));
const project = join(root, "project");
const skillPath = join(project, ".opencode/skills/hotplate-probe/SKILL.md");
const database = join(root, "hotplate.sqlite");
const canary = "HOTPLATE_SYNTHETIC_CONTENT_CANARY";
let output = "";
let modelRequests = 0;
let emittedTools = false;
let host;
let runner;
let modelServer;
let timedOut = false;
const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), HOTPLATE_DB: database, HOTPLATE_NODE_BIN: process.execPath, HOTPLATE_PROBE_KEY: "probe", OPENCODE_SERVER_PASSWORD: "hotplate-probe-only", OPENCODE_DISABLE_AUTOUPDATE: "true" };
for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "HOTPLATE_CONFIG", "HOTPLATE_DISABLED"]) delete env[key];
function start(args) {
  const child = spawn(binary, args, { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-100_000); });
  return child;
}
function stop(child) {
  if (child && child.exitCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch {}
}
function exit(child) {
  return new Promise((done, reject) => { child.once("error", reject); child.once("close", (code) => done(code)); });
}
const deadline = setTimeout(() => { timedOut = true; stop(runner); stop(host); }, 45_000);
try {
  for (const path of [join(project, ".opencode/skills/hotplate-probe"), join(root, "config/opencode"), env.HOME]) await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  await writeFile(skillPath, `---\nname: hotplate-probe\ndescription: Synthetic capability probe\n---\n${canary}\n`);
  modelServer = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests++;
    const hasTools = body.tools?.some((tool) => tool.function?.name === "read");
    const readArgs = (path) => major === "1" ? { filePath: path } : { path };
    const calls = hasTools && !emittedTools ? [
      { name: "read", args: readArgs(skillPath) },
      { name: "read", args: readArgs(skillPath) },
      { name: "read", args: readArgs(join(project, "missing/SKILL.md")) },
      { name: "skill", args: major === "1" ? { name: "hotplate-probe" } : { id: "hotplate-probe" } },
    ] : [];
    if (hasTools) emittedTools = true;
    const delta = calls.length
      ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `probe-call-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
      : { role: "assistant", content: "Synthetic probe complete" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [part, finish] of [[delta, null], [{}, calls.length ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "probe-response", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => modelServer.listen(0, "127.0.0.1", done));
  const baseURL = `http://127.0.0.1:${modelServer.address().port}/v1`;
  const config = major === "1" ? {
    model: "hotplate/probe", permission: { read: "allow", external_directory: "allow", skill: "allow" },
    skills: { paths: [join(project, ".opencode/skills")] },
    provider: { hotplate: { npm: "@ai-sdk/openai-compatible", options: { baseURL, apiKey: "probe" }, models: { probe: { name: "Probe", limit: { context: 32000, output: 2000 } } } } },
  } : {
    model: "hotplate/probe", skills: [join(project, ".opencode/skills")],
    permissions: ["read", "external_directory", "skill"].map((action) => ({ action, resource: "*", effect: "allow" })),
    providers: { hotplate: { env: ["HOTPLATE_PROBE_KEY"], package: "@opencode/ai/providers/openai-compatible", settings: { baseURL }, models: { probe: { name: "Probe" } } } },
  };
  await writeFile(join(project, "opencode.json"), JSON.stringify(config));
  await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify(config));
  execFileSync(process.execPath, [join(build, "src/cli.js"), "integration", "install", `opencode-v${major}`, "--binary", binary], { cwd: project, env, stdio: "pipe" });
  const runArgs = ["run", "--format", "json", "--model", "hotplate/probe", "Run the synthetic skill and file-read probe."];
  let code;
  if (major === "1") {
    runner = start([...runArgs,"--dir",project]);
    code = await exit(runner);
  } else {
    host = start(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    let serverURL;
    for (let attempt = 0; attempt < 100 && !serverURL && !timedOut; attempt++) {
      serverURL = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (!serverURL) await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(serverURL, "OpenCode server did not start");
    const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:hotplate-probe-only").toString("base64")}` };
    const query = `?location[directory]=${encodeURIComponent(project)}`;
    let active = false;
    for (let attempt = 0; attempt < 50 && !active; attempt++) {
      const plugins = await fetch(`${serverURL}/api/plugin${query}`, { headers }).then((response) => response.json());
      active = plugins.data.some((plugin) => plugin.id === "hotplate" && plugin.state.status === "active");
      if (!active) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(active, "Installed OpenCode plugin did not become active");
    const created = await fetch(`${serverURL}/api/session`, { method: "POST", headers, body: JSON.stringify({ location: { directory: project }, title: "Synthetic probe" }) }).then((response) => response.json());
    assert.equal(created.data.location.directory, project);
    runner = start([...runArgs, "--auto", "--server", serverURL, "--session", created.data.id]);
    code = await exit(runner);
  }
  assert.equal(timedOut, false, "OpenCode probe timed out");
  assert.equal(code, 0, "OpenCode synthetic session failed");
  assert.ok(modelRequests > 0, "OpenCode did not call the local provider");
  assert.ok(existsSync(database), `No capture database; bridgeUnavailable=${output.includes("Hotplate capture unavailable")}; completed=${(output.match(/"status":"completed"/g)??[]).length}; toolEvents=${(output.match(/"type":"tool_use"/g)??[]).length}`);
  const db = new DatabaseSync(database, { readOnly: true });
  const rows = db.prepare("SELECT host,evidence_kind,outcome,skill_path,project_cwd FROM observations ORDER BY evidence_kind,outcome").all();
  const serialized = JSON.stringify(db.prepare("SELECT * FROM observations").all());
  db.close();
  assert.equal(serialized.includes(canary), false, "Raw skill content leaked into capture");
  assert.equal(rows.length, major === "1" ? 3 : 4, "Unexpected capture count");
  assert.equal(rows.filter((row) => row.evidence_kind === "read-result" && row.outcome === "success").length, 2);
  assert.equal(rows.filter((row) => row.evidence_kind === "read-result" && row.outcome === "error").length, major === "1" ? 0 : 1);
  assert.equal(rows.filter((row) => row.evidence_kind === "skill-invocation" && row.outcome === "success").length, 1);
  for (const row of rows) { assert.equal(row.host, `opencode-v${major}`); assert.equal(row.project_cwd, project); }
  const report = { host: `opencode-v${major}`, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), installedPlugin: true, modelRequests, observations: rows.map(({ host, evidence_kind, outcome, skill_path }) => ({ host, kind: evidence_kind, outcome, hasPath: skill_path !== null })), canaryAbsent: true };
  await mkdir(".audit/probe-opencode", { recursive: true });
  await writeFile(`.audit/probe-opencode/verified-v${major}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(deadline);
  stop(runner); stop(host);
  if (modelServer) { modelServer.closeAllConnections(); await new Promise((done) => modelServer.close(done)); }
  await rm(root, { recursive: true, force: true });
}
