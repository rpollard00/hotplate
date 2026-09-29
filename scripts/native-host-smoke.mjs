import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openHotplateStore } from "../dist/src/store.js";

const host = process.argv[2];
if (host !== "codex" && host !== "claude-code") throw new Error("Usage: node scripts/native-host-smoke.mjs codex|claude-code");
const root = await mkdtemp(join(tmpdir(), `hotplate-${host}-smoke-`));
const project = join(root, "project");
const config = join(root, "config");
const databasePath = join(root, "capture.sqlite");
const skillPath = host === "codex" ? ".agents/skills/hotplate-probe/SKILL.md" : ".claude/skills/hotplate-probe/SKILL.md";
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
      const item = requestCount <= 2
        ? { type: "function_call", id: `fc_${requestCount}`, call_id: `call_${requestCount}`, name: "exec_command",
          arguments: JSON.stringify({ cmd: `cat ${join(project, requestCount === 1 ? skillPath : "absent/SKILL.md")}`, workdir: project }) }
        : { type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Probe done.", annotations: [] }] };
      assert.ok(names.includes("exec_command"));
      const result = { id: `resp_${requestCount}`, object: "response", created_at: 1, status: "in_progress", model: "probe", output: [] };
      emit("response.created", { response: result });
      emit("response.output_item.added", { output_index: 0, item });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { ...result, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    } else {
      const tool = requestCount === 1 ? { name: "Skill", input: { skill: "hotplate-probe" } }
        : requestCount <= 3 ? { name: "Read", input: { file_path: join(project, requestCount === 2 ? skillPath : "absent/SKILL.md") } } : null;
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
  await mkdir(join(project, skillPath, ".."), { recursive: true });
  await writeFile(join(project, skillPath), "---\nname: hotplate-probe\ndescription: Synthetic smoke fixture\n---\nHOTPLATE_SMOKE_CONTENT_CANARY\n");
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hook = `${quote(process.execPath)} ${quote(resolve("dist/src/cli.js"))} capture ${host}`;
  const events = host === "codex" ? ["PostToolUse"] : ["PostToolUse", "PostToolUseFailure"];
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: "command", command: hook, timeout: 2 }] }]]));
  await writeFile(join(config, host === "codex" ? "hooks.json" : "settings.json"), JSON.stringify({ hooks }));
  const env = { ...process.env, HOTPLATE_DB: databasePath };
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_DISABLED;
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
  } finally { await store.close(); }
  assert.equal((await readFile(databasePath)).includes(Buffer.from("HOTPLATE_SMOKE_CONTENT_CANARY")), false);
  process.stdout.write(`${JSON.stringify({ host, provider: "deterministic-local", requestCount, elapsedMs: Math.round(performance.now() - started), overview })}\n`);
} finally {
  if (child?.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true });
}
