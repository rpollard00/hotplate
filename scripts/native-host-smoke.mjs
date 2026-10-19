import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const host = process.argv[2];
if (host !== "codex" && host !== "claude-code") throw new Error("Usage: node scripts/native-host-smoke.mjs codex|claude-code [build-directory]");
const build = resolve(process.argv[3] ?? "dist");
const { openHotplateStore } = await import(pathToFileURL(join(build, "src/store.js")).href);
const root = await mkdtemp(join(tmpdir(), `hotplate-${host}-smoke-`));
const project = join(root, "project");
const config = join(root, "config");
const databasePath = join(root, "capture.sqlite");
const skillPath = host === "codex" ? ".agents/skills/hotplate-probe/SKILL.md" : ".claude/skills/hotplate-probe/SKILL.md";
const referencePath = join(skillPath, "..", "references", "guide.md");
const missingPath = join(skillPath, "..", "..", "absent", "SKILL.md");
const outsidePath = "source/uninstalled/SKILL.md";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let child;
let requestCount = 0;
let providerFailure = false;
const requestPaths = [];
const server = createServer(async (request, response) => {
  try {
    requestPaths.push(request.url?.split("?")[0]);
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url?.startsWith(host === "codex" ? "/v1/responses" : "/v1/messages")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const input = JSON.parse(body);
    requestCount++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    let sequence = 0;
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    if (host === "codex") {
      const names = input.tools?.map(tool => tool.name) ?? [];
      const item = requestCount <= 4
        ? { type: "function_call", id: `fc_${requestCount}`, call_id: `call_${requestCount}`, name: "exec_command",
          arguments: JSON.stringify({ cmd: `cat ${join(project, requestCount === 1 ? skillPath : requestCount === 2 ? missingPath : requestCount === 3 ? referencePath : outsidePath)}`, workdir: project }) }
        : { type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Probe done.", annotations: [] }] };
      assert.ok(names.includes("exec_command"));
      const result = { id: `resp_${requestCount}`, object: "response", created_at: 1, status: "in_progress", model: "probe", output: [] };
      emit("response.created", { response: result });
      emit("response.output_item.added", { output_index: 0, item });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { ...result, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    } else {
      const tool = requestCount === 1 ? { name: "Skill", input: { skill: "hotplate-probe" } }
        : requestCount <= 5 ? { name: "Read", input: { file_path: join(project, requestCount === 2 ? skillPath : requestCount === 3 ? missingPath : requestCount === 4 ? referencePath : outsidePath) } } : null;
      const message = { id: `msg_${requestCount}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      emit("message_start", { message });
      if (tool) {
        emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: `tool_${requestCount}`, name: tool.name, input: {} } });
        emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
      } else {
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Probe done." } });
      }
      emit("content_block_stop", { index: 0 });
      emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      emit("message_stop", {});
    }
    response.end();
  } catch {
    providerFailure = true;
    response.end();
  }
});

try {
  await mkdir(config);
  await mkdir(join(project, referencePath, ".."), { recursive: true });
  await writeFile(join(project, skillPath), "---\nname: hotplate-probe\ndescription: Synthetic smoke fixture\n---\nHOTPLATE_SMOKE_CONTENT_CANARY\n");
  await writeFile(join(project, referencePath), "HOTPLATE_SMOKE_REFERENCE_CANARY\n");
  await mkdir(join(project, outsidePath, ".."), { recursive: true });
  await writeFile(join(project, outsidePath), "HOTPLATE_SMOKE_OUTSIDE_CANARY\n");
  await writeFile(join(root, "resources.json"), JSON.stringify({ version: 1, roots: [] }));
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hook = `${quote(process.execPath)} ${quote(join(build, "src/cli.js"))} capture ${host}`;
  const events = host === "codex" ? ["PostToolUse"] : ["PostToolUse", "PostToolUseFailure"];
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: "command", command: hook, timeout: 2 }] }]]));
  await writeFile(join(config, host === "codex" ? "hooks.json" : "settings.json"), JSON.stringify({ hooks }));
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
    CODEX_HOME: join(root, "codex-home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"), HOTPLATE_DB: databasePath,
    HOTPLATE_RESOURCES_CONFIG: join(root, "resources.json"), HOTPLATE_PROCESS_REGISTRY: join(root, "process-registry") };
  await mkdir(env.HOME, { mode: 0o700 });
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_DISABLED;
  delete env.HOTPLATE_RESOURCE_ROOTS;
  delete env.HOTPLATE_FILESYSTEM_ID;
  let args;
  if (host === "codex") {
    await writeFile(join(config, "config.toml"), `model='probe'\nmodel_provider='probe'\n[model_providers.probe]\nname='Probe'\nbase_url='${origin}/v1'\nwire_api='responses'\nrequires_openai_auth=false\n`);
    env.CODEX_HOME = config;
    args = ["exec", "--ephemeral", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "--ignore-rules", "-s", "read-only", "--json", "Run the synthetic read probe."];
  } else {
    env.CLAUDE_CONFIG_DIR = config;
    env.ANTHROPIC_BASE_URL = origin;
    env.ANTHROPIC_API_KEY = "synthetic-local-test-key";
    delete env.ANTHROPIC_AUTH_TOKEN;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    args = ["-p", "--no-session-persistence", "--setting-sources", "project", "--settings", join(config, "settings.json"), "--tools", "Read,Skill", "--allowedTools", "Read,Skill", "--permission-mode", "dontAsk", "--model", "claude-sonnet-4-6", "--output-format", "json", "Run the synthetic read probe."];
  }
  const started = performance.now();
  child = spawn(host === "codex" ? "codex" : "claude", args, { cwd: project, env, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 30_000);
  const exit = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); }).finally(() => clearTimeout(timer));
  assert.equal(providerFailure, false);
  assert.equal(exit.code, 0, "Native host did not finish the synthetic provider session");
  const store = openHotplateStore({ databasePath });
  let overview;
  let resources;
  let completeInventories = 0;
  try {
    overview = await store.queryOverview({ host });
    assert.ok(requestCount > 0, `No inference requests: ${JSON.stringify(requestPaths)}`);
    if (host === "codex") {
      assert.equal(overview.readAttemptCount, 2);
      assert.equal(overview.successfulReadCount, 0);
      assert.equal(overview.failedReadCount, 0);
    } else {
      assert.equal(overview.skillInvocationCount, 1, JSON.stringify({ requestCount, overview }));
      assert.equal(overview.successfulReadCount, 1);
      assert.equal(overview.failedReadCount, 1);
    }
    const deadline = Date.now() + 5000;
    do {
      resources = (await store.queryResources({ host })).rows;
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        completeInventories = Number(db.prepare("SELECT count(*) AS count FROM resource_events WHERE json_extract(payload, '$.host') = ? AND json_extract(payload, '$.evidence.phase') = 'complete'").get(host)?.count);
      } finally { db.close(); }
      if (completeInventories > 0 && resources.some(row => row.resource.canonicalPath === join(project, referencePath) && row.lastInventoriedAt !== null)) break;
      await delay(25);
    } while (Date.now() < deadline);
    const reference = resources.find(row => row.resource.canonicalPath === join(project, referencePath));
    const skill = resources.find(row => row.resource.canonicalPath === join(project, skillPath));
    const missing = resources.find(row => row.resource.canonicalPath === join(project, missingPath));
    assert.ok(reference, "The reference read did not produce resource evidence");
    assert.ok(skill, "The skill read did not produce resource evidence");
    assert.equal(reference.resource.kind, "reference");
    assert.equal(host === "codex" ? reference.attemptCount : reference.successfulReadCount, 1);
    assert.equal(host === "codex" ? skill.attemptCount : skill.successfulReadCount, 1);
    assert.ok(missing, "An in-scope missing skill did not produce resource evidence");
    assert.equal(host === "codex" ? missing.attemptCount : missing.failedReadCount, 1);
    assert.equal(resources.some(row => row.resource.canonicalPath === join(project, outsidePath)), false, "An out-of-scope read produced resource evidence");
    assert.notEqual(reference.lastInventoriedAt, null, "Reference was not inventoried");
    assert.notEqual(skill.lastInventoriedAt, null, "Skill was not inventoried");
    assert.ok(completeInventories > 0, "Session inventory did not complete");
    assert.ok(resources.every(row => row.resource.canonicalPath.startsWith(`${root}/`)), "Smoke captured a resource outside its temporary directory");
  } finally { await store.close(); }
  const persistedDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const persisted = JSON.stringify([persistedDb.prepare("SELECT * FROM observations").all(), persistedDb.prepare("SELECT * FROM resource_events").all()]);
    assert.equal(persisted.includes("HOTPLATE_SMOKE_CONTENT_CANARY"), false);
    assert.equal(persisted.includes("HOTPLATE_SMOKE_REFERENCE_CANARY"), false);
    assert.equal(persisted.includes(join(project, outsidePath)), false, "An out-of-scope read produced legacy evidence");
    assert.equal(persisted.includes("HOTPLATE_SMOKE_OUTSIDE_CANARY"), false);
  } finally { persistedDb.close(); }
  process.stdout.write(`${JSON.stringify({ host, provider: "deterministic-local", requestCount, elapsedMs: Math.round(performance.now() - started),
    legacy: { attempts: overview.readAttemptCount, successfulReads: overview.successfulReadCount, failedReads: overview.failedReadCount, invocations: overview.skillInvocationCount },
    resources: resources.filter(row => [join(project, skillPath), join(project, referencePath)].includes(row.resource.canonicalPath))
      .map(row => ({ kind: row.resource.kind, attempts: row.attemptCount, successfulReads: row.successfulReadCount, inventoried: row.lastInventoriedAt !== null })),
    inventoriedResources: resources.filter(row => row.lastInventoriedAt !== null).length, completeInventories, canaryAbsent: true })}\n`);
} finally {
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
