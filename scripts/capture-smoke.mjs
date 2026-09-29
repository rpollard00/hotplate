import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openHotplateStore } from "../dist/src/store.js";

const root = await mkdtemp(join(tmpdir(), "hotplate-capture-smoke-"));
const databasePath = join(root, "capture.sqlite");
const elapsed = [];
const env = { ...process.env, HOTPLATE_DB: databasePath };
delete env.HOTPLATE_CONFIG;
delete env.HOTPLATE_DISABLED;

async function capture(id) {
  const started = performance.now();
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "capture", "claude-code"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.end(JSON.stringify({
    hook_event_name: "PostToolUse", session_id: "synthetic-capture-session", cwd: "/synthetic/project", tool_use_id: `read-${id}`,
    tool_name: "Read", tool_input: { file_path: "/synthetic/skills/smoke/SKILL.md" },
    tool_response: "HOTPLATE_CAPTURE_SMOKE_OUTPUT_CANARY",
  }));
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0);
  assert.equal(output, "");
  assert.equal(error, "");
  return Math.round(performance.now() - started);
}

try {
  for (let id = 0; id < 20; id++) elapsed.push(await capture(id));
  const burst = await Promise.all(Array.from({ length: 8 }, (_, index) => capture(index + 20)));
  await capture(0);
  const store = openHotplateStore({ databasePath });
  try {
    const overview = await store.queryOverview({ host: "claude-code" });
    assert.equal(overview.successfulReadCount, 28);
    assert.equal(overview.observationCount, 28);
  } finally { await store.close(); }
  assert.equal((await readFile(databasePath)).includes(Buffer.from("HOTPLATE_CAPTURE_SMOKE_OUTPUT_CANARY")), false);
  const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const result = { sequentialP95Ms: percentile(elapsed), burstP95Ms: percentile(burst), captures: 28, duplicateRetries: 1, privacyCanaryAbsent: true };
  assert.ok(result.sequentialP95Ms < 250, "Sequential capture exceeded the 250ms target");
  assert.ok(result.burstP95Ms < 750, "Concurrent capture exceeded the 750ms target");
  if (process.env.HOTPLATE_SMOKE_REPORT) await writeFile(process.env.HOTPLATE_SMOKE_REPORT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
