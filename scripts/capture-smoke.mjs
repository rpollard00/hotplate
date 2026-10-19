import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openHotplateStore } from "../dist/src/store.js";

const root = await mkdtemp(join(tmpdir(), "hotplate-capture-smoke-"));
const databasePath = join(root, "capture.sqlite");
const skillPath = join(root, "skills/smoke/SKILL.md");
const referencePath = join(root, "skills/smoke/reference.md");
const outsidePath = join(root, "source/uninstalled/SKILL.md");
const elapsed = [];
const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  HOTPLATE_DB: databasePath, HOTPLATE_NODE_BIN: process.execPath, HOTPLATE_PROCESS_REGISTRY: join(root, "processes"),
  HOTPLATE_RESOURCE_ROOTS: join(root, "skills") };

async function capture(id) {
  const started = performance.now();
  const child = spawn(process.execPath, [resolve("dist/src/cli.js"), "capture", "claude-code"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.end(JSON.stringify({
    hook_event_name: "PostToolUse", session_id: "synthetic-capture-session", cwd: root, tool_use_id: `read-${id}`,
    tool_name: "Read", tool_input: { file_path: id === "reference" ? referencePath : id === "outside" ? outsidePath : skillPath },
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
  await mkdir(join(root, "skills/smoke"), { recursive: true });
  for (const path of [skillPath, referencePath]) await writeFile(path, "HOTPLATE_CAPTURE_SMOKE_OUTPUT_CANARY");
  await mkdir(join(outsidePath, ".."), { recursive: true });
  await writeFile(outsidePath, "HOTPLATE_CAPTURE_SMOKE_OUTSIDE_CANARY");
  for (let id = 0; id < 20; id++) elapsed.push(await capture(id));
  const burst = await Promise.all(Array.from({ length: 8 }, (_, index) => capture(index + 20)));
  await capture(0);
  await capture("reference");
  await capture("outside");
  const store = openHotplateStore({ databasePath });
  try {
    const overview = await store.queryOverview({ host: "claude-code" });
    assert.equal(overview.successfulReadCount, 28);
    const resources = (await store.queryResources({ host: "claude-code" })).rows;
    assert.equal(resources.length, 2);
    assert.equal(resources.find(row => row.resource.canonicalPath === skillPath)?.successfulReadCount, 28);
    assert.equal(resources.find(row => row.resource.canonicalPath === referencePath)?.successfulReadCount, 1);
    assert.ok(resources.every(row => row.presence === "present"));
  } finally { await store.close(); }
  assert.equal((await readFile(databasePath)).includes(Buffer.from("HOTPLATE_CAPTURE_SMOKE_OUTPUT_CANARY")), false);
  assert.equal((await readFile(databasePath)).includes(Buffer.from(outsidePath)), false);
  const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const result = { sequentialP95Ms: percentile(elapsed), burstP95Ms: percentile(burst), captures: 29, duplicateRetries: 1, inventoriedFiles: 2, privacyCanaryAbsent: true };
  assert.ok(result.sequentialP95Ms < 250, "Sequential capture exceeded the 250ms target");
  assert.ok(result.burstP95Ms < 750, "Concurrent capture exceeded the 750ms target");
  if (process.env.HOTPLATE_SMOKE_REPORT) await writeFile(process.env.HOTPLATE_SMOKE_REPORT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
