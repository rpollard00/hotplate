import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHotplateReadStore } from "../src/store.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("capture CLI commits once, retains no content, and handles malformed input silently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-capture-cli-"));
  const databasePath = join(directory, "capture.sqlite");
  const env: NodeJS.ProcessEnv = { ...process.env, HOTPLATE_DB: databasePath, NODE_NO_WARNINGS: "1" };
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_DISABLED;
  try {
    const hook = { hook_event_name: "PostToolUse", session_id: "test-session", tool_use_id: "test-tool", cwd: directory, tool_name: "Read", tool_input: { file_path: join(directory, "skill/SKILL.md") }, tool_response: "PRIVATE_OUTPUT_CANARY", prompt: "PRIVATE_PROMPT_CANARY", error: "PRIVATE_ERROR_CANARY" };
    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync(process.execPath, [cli, "capture", "claude-code"], { env, input: JSON.stringify(hook), encoding: "utf8", timeout: 3000 });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const conflict = spawnSync(process.execPath, [cli, "capture", "claude-code"], {
      env, input: JSON.stringify({ ...hook, tool_input: { file_path: join(directory, "other/SKILL.md") } }), encoding: "utf8", timeout: 3000,
    });
    assert.equal(conflict.status, 0);
    assert.equal(conflict.stdout, "");
    assert.equal(conflict.stderr, "Hotplate capture unavailable.\n");
    const opened = openHotplateReadStore({ databasePath });
    assert.equal(opened.kind, "ready");
    if (opened.kind !== "ready") return;
    try {
      const overview = await opened.store.queryOverview({});
      assert.equal(overview.readResultCount, 1);
      assert.equal(overview.successfulReadCount, 1);
      assert.equal(JSON.stringify(await opened.store.querySkillChain({})).includes("CANARY"), false);
    } finally { await opened.store.close(); }
    for (const input of ['{"invalid":"PRIVATE_CANARY"', "x".repeat(1024 * 1024 + 1)]) {
      const result = spawnSync(process.execPath, [cli, "capture", "claude-code"], { env, input, encoding: "utf8", timeout: 3000 });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Hotplate capture unavailable.\n");
    }
    const disabledPath = join(directory, "disabled.sqlite");
    const disabled = spawnSync(process.execPath, [cli, "capture", "claude-code"], { env: { ...env, HOTPLATE_DB: disabledPath, HOTPLATE_DISABLED: "1" }, input: JSON.stringify(hook), encoding: "utf8", timeout: 3000 });
    assert.equal(disabled.status, 0);
    assert.equal(existsSync(disabledPath), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("capture CLI deadline includes an unfinished stdin stream", async () => {
  const started = performance.now();
  const child = spawn(process.execPath, [cli, "capture", "claude-code"], { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const code = await new Promise<number | null>((done) => child.once("close", done));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "Hotplate capture unavailable.\n");
    assert.ok(performance.now() - started < 2000);
  } finally { clearTimeout(watchdog); child.stdin.destroy(); }
});
