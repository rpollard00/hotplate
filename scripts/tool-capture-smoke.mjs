import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const build = resolve(process.argv[2] ?? "dist");
const { openHotplateStore } = await import(pathToFileURL(join(build, "src/store.js")).href);
const { extractOpenCodeV1Facts } = await import(pathToFileURL(join(build, "src/integrations/opencode/v1.js")).href);
const { extractOpenCodeV2Facts } = await import(pathToFileURL(join(build, "src/integrations/opencode/v2.js")).href);
const root = await mkdtemp(join(tmpdir(), "hotplate-tool-capture-smoke-"));
const databasePath = join(root, "capture.sqlite");
const reference = join(root, "resources", "references", "guide with spaces.md");
const canary = "HOTPLATE_TOOL_CAPTURE_PRIVATE_CANARY";
const env = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  HOTPLATE_DB: databasePath, HOTPLATE_NODE_BIN: process.execPath, HOTPLATE_PROCESS_REGISTRY: join(root, "processes"),
  HOTPLATE_RESOURCE_REGISTRY: join(root, "registry"), HOTPLATE_RESOURCE_ROOTS: join(root, "resources"), NODE_NO_WARNINGS: "1" };
const elapsed = [];

async function capture(host, value) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(build, "src/cli.js"), "capture", host], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(value));
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  elapsed.push(Math.round(performance.now() - started));
}

try {
  await mkdir(join(reference, ".."), { recursive: true });
  await writeFile(reference, `${canary}\nsecond\nthird\nfourth\n`);
  const commands = [
    `sed -n '2,3p' '${reference}'`,
    `python3 -c "print(open('${reference}').read())"`,
    `python3 ${canary}.py`,
  ];
  for (const host of ["claude-code", "codex", "opencode-v1", "opencode-v2"]) {
    for (const [index, command] of commands.entries()) {
      const operationId = `shell-${index}`;
      const context = { projectCwd: root, env };
      const value = host === "opencode-v1"
        ? extractOpenCodeV1Facts({ tool: "bash", sessionID: host, callID: operationId, args: { command, workdir: root } },
          { output: canary, metadata: { exit: 0, truncated: false } }, context)
        : host === "opencode-v2"
          ? extractOpenCodeV2Facts({ tool: "shell", sessionID: host, id: operationId, input: { command, workdir: root }, status: "completed",
            result: { output: { exit: 0, output: canary, truncated: false, status: "completed" } } }, context)
          : { hook_event_name: "PostToolUse", session_id: host, cwd: root, tool_use_id: operationId,
            tool_name: "Bash", tool_input: { command }, tool_response: canary };
      await capture(host, value);
      if (index === 0) await capture(host, value);
    }
  }
  await capture("claude-code", {
    hook_event_name: "PostToolUse", session_id: "claude-code", cwd: root, tool_use_id: "native-partial", tool_name: "Read",
    tool_input: { file_path: reference, offset: 2, limit: 2 },
    tool_response: { type: "text", file: { filePath: reference, content: canary, startLine: 2, numLines: 2, totalLines: 4 } },
  });
  const store = openHotplateStore({ databasePath });
  try {
    const report = await store.queryContentAnalytics({ filter: {}, content: "resources", measure: "toolActivity", split: "item", selection: { kind: "all" } });
    assert.equal(report.overall.count, 9);
    assert.equal(report.overall.counts.successfulReads, 1);
    assert.equal(report.overall.counts.inferredReads, 4);
    assert.equal(report.overall.counts.readAttempts, 4);
    assert.equal(report.coverage.overall.observedOperations, 13);
    assert.equal(report.coverage.overall.opaqueOperations, 4);
    assert.equal(report.selection.rows.length, 1);
    assert.ok(report.selection.rows[0].readDetails.groups.some(group => group.requested.kind === "lines"
      && group.requested.start === 2 && group.requested.count === 2));
    assert.ok(report.selection.rows[0].readDetails.groups.some(group => group.delivery.kind === "known"
      && group.delivery.returned.kind === "lines" && group.delivery.returned.start === 2 && group.delivery.returned.count === 2));
    assert.equal((await store.queryOverview({})).successfulReadCount, 0);
    assert.equal(JSON.stringify(report).includes(canary), false);
  } finally { await store.close(); }
  assert.equal((await readFile(databasePath)).includes(Buffer.from(canary)), false);
  const result = { captures: elapsed.length, referenceReads: 9, opaqueExecutions: 4, duplicateRetries: 4,
    requestedAndReturnedRanges: true, privacyCanaryAbsent: true, maxCaptureMs: Math.max(...elapsed) };
  if (process.env.HOTPLATE_SMOKE_REPORT) await writeFile(process.env.HOTPLATE_SMOKE_REPORT, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
