import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { MessageEndEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { captureFact, type CaptureFact } from "../src/capture.js";
import { HotplateCollector } from "../src/collector/collector.js";
import { parseClaudeCodeHook } from "../src/integrations/claude-code.js";
import { parseCodexHook } from "../src/integrations/codex.js";
import { extractOpenCodeV1Facts } from "../src/integrations/opencode/v1.js";
import { extractOpenCodeV2Facts } from "../src/integrations/opencode/v2.js";
import { normalizePiTool } from "../src/integrations/pi.js";
import { openHotplateStore } from "../src/store.js";

const observedAt = "2026-10-19T00:00:00.000Z";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-tool-adapters-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "resources");
  const reference = join(root, "references", "guide with spaces.md");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, "PRIVATE_CONTENT_CANARY\nsecond\nthird\nfourth\n");
  const databasePath = join(directory, "capture.sqlite");
  const env = { HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"),
    HOTPLATE_DB: databasePath, HOTPLATE_RESOURCE_ROOTS: root, HOTPLATE_PROCESS_REGISTRY: join(directory, "processes"),
    HOTPLATE_RESOURCE_REGISTRY: join(directory, "registry"), HOTPLATE_FILESYSTEM_ID: "tool-adapters" };
  return { directory, root, reference, databasePath, env };
}

function resourceFacts(facts: readonly CaptureFact[]) {
  return facts.flatMap((fact) => fact.evidence.kind === "resource-access" ? [fact.evidence] : []);
}

test("native shell adapters preserve targets, outcome strength, ranges, and opaque coverage through storage", async (t) => {
  const data = fixture(t);
  for (const host of ["claude-code", "codex", "opencode-v1", "opencode-v2"] as const) {
    const path = host === "codex" ? data.reference : relative(data.directory, data.reference);
    const commands = [`cat '${path}'`, `sed -n '2,3p' '${path}'`, `python3 -c "print(open('${path}').read())"`, "python3 PRIVATE_SCRIPT_CANARY.py"];
    const facts: CaptureFact[] = [];
    for (const [index, command] of commands.entries()) {
      const id = `tool-${index}`;
      const hook = { hook_event_name: "PostToolUse", session_id: host, cwd: data.directory, tool_use_id: id,
        tool_name: "Bash", tool_input: { command }, tool_response: "PRIVATE_OUTPUT_CANARY" };
      const inputV1 = { tool: "bash", sessionID: host, callID: id, args: { command, workdir: data.directory } };
      const resultV1 = { output: "PRIVATE_OUTPUT_CANARY", metadata: { exit: 0, truncated: false } };
      const inputV2 = { tool: "shell", sessionID: host, id, input: { command, workdir: data.directory }, status: "completed",
        result: { output: { output: "PRIVATE_OUTPUT_CANARY", exit: 0, truncated: false, status: "completed" } } };
      const before = JSON.stringify([hook, inputV1, resultV1, inputV2]);
      const context = { projectCwd: data.directory, observedAt, env: data.env };
      const parsed = host === "claude-code" ? parseClaudeCodeHook(hook, observedAt, data.env)
        : host === "codex" ? parseCodexHook(hook, observedAt, data.env)
        : host === "opencode-v1" ? extractOpenCodeV1Facts(inputV1, resultV1, context) : extractOpenCodeV2Facts(inputV2, context);
      assert.equal(JSON.stringify([hook, inputV1, resultV1, inputV2]), before);
      facts.push(...parsed);
      const resources = resourceFacts(parsed);
      if (index < 3) {
        assert.equal(resources.length, 1, host);
        assert.equal(resources[0]?.resource.canonicalPath, data.reference);
        assert.equal(resources[0]?.access, host.startsWith("opencode") ? "inferred-read" : "attempt");
      } else {
        assert.equal(resources.length, 0, host);
        const coverage = parsed[0]?.evidence;
        assert.equal(coverage?.kind, "tool-coverage");
        if (coverage?.kind === "tool-coverage") assert.deepEqual(coverage.recognition, { kind: "opaque", reason: "unsupported-syntax" });
      }
      for (const fact of parsed) {
        assert.equal((await captureFact({ fact, env: data.env })).kind, "recorded");
        const retry = await captureFact({ fact: { ...fact, observedAt: "2026-10-19T00:00:01.000Z" }, env: data.env });
        assert.ok(retry.kind === "recorded" && retry.duplicate === 1);
      }
    }
    assert.deepEqual(resourceFacts(facts)[1]?.toolRead?.requested, { kind: "lines", start: 2, count: 2 });
    assert.equal(JSON.stringify(facts).includes("CANARY"), false);
  }
  const store = openHotplateStore({ databasePath: data.databasePath });
  try {
    for (const host of ["claude-code", "codex", "opencode-v1", "opencode-v2"] as const) {
      const rows = (await store.queryResources({ host })).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.successfulReadCount, 0);
      assert.equal(rows[0]?.inferredReadCount, host.startsWith("opencode") ? 3 : 0);
      assert.equal(rows[0]?.attemptCount, host.startsWith("opencode") ? 0 : 3);
      assert.equal((await store.queryOverview({ host })).successfulReadCount, 0);
    }
  } finally { await store.close(); }
  const db = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM observations WHERE evidence_kind = 'tool-coverage'").get()?.n, 16);
  } finally { db.close(); }
  assert.equal(readFileSync(data.databasePath).includes(Buffer.from("CANARY")), false);
});

test("Codex session cwd cannot identify a relative command target", (t) => {
  const data = fixture(t);
  const facts = parseCodexHook({ hook_event_name: "PostToolUse", session_id: "codex", cwd: data.directory,
    tool_use_id: "relative-read", tool_name: "Bash", tool_input: { command: `cat '${relative(data.directory, data.reference)}'` },
    tool_response: "PRIVATE_OUTPUT_CANARY" }, observedAt, data.env);
  assert.equal(resourceFacts(facts).length, 0);
  assert.deepEqual(facts.map(fact => fact.evidence), [{ kind: "tool-coverage", operationId: "relative-read",
    family: "shell", outcome: "unknown", model: null, recognition: { kind: "opaque", reason: "missing-input" } }]);
});

test("shell failures and background results never become per-file successes", (t) => {
  const data = fixture(t);
  const command = `cat '${data.reference}' '${join(data.root, "missing.md")}'`;
  const context = { projectCwd: data.directory, observedAt, env: data.env };
  const v1 = { tool: "bash", sessionID: "v1", callID: "call", args: { command } };
  const v2 = { tool: "shell", sessionID: "v2", id: "call", input: { command }, status: "completed" };
  for (const facts of [
    extractOpenCodeV1Facts(v1, { output: "PRIVATE_ERROR_CANARY", metadata: { exit: 1 } }, context),
    extractOpenCodeV1Facts(v1, { output: "PRIVATE_ERROR_CANARY", metadata: { exit: null } }, context),
    extractOpenCodeV2Facts({ ...v2, result: { output: { exit: 1 } } }, context),
    extractOpenCodeV2Facts({ ...v2, result: { output: { exit: 0, status: "running" } } }, context),
    extractOpenCodeV2Facts({ ...v2, result: { output: { exit: 0, timeout: true } } }, context),
    extractOpenCodeV2Facts({ ...v2, status: "error", error: { message: "PRIVATE_ERROR_CANARY" } }, context),
    parseClaudeCodeHook({ hook_event_name: "PostToolUseFailure", session_id: "claude", tool_use_id: "call", cwd: data.directory,
      tool_name: "Bash", tool_input: { command }, error: "PRIVATE_ERROR_CANARY" }, observedAt, data.env),
    parseCodexHook({ hook_event_name: "PostToolUse", session_id: "codex", tool_use_id: "call", cwd: data.directory,
      tool_name: "Bash", tool_input: { command }, tool_response: "Process exited with code 0 PRIVATE_ERROR_CANARY" }, observedAt, data.env),
  ]) {
    assert.equal(resourceFacts(facts).length, 2);
    assert.ok(resourceFacts(facts).every((evidence) => evidence.access === "attempt" && evidence.outcome === "unknown"));
    assert.equal(JSON.stringify(facts).includes("CANARY"), false);
  }
});

test("native partial reads retain requested and available returned metadata without body content", (t) => {
  const data = fixture(t);
  const hook = { hook_event_name: "PostToolUse", session_id: "claude", tool_use_id: "read", cwd: data.directory, tool_name: "Read",
    tool_input: { file_path: data.reference, offset: 2, limit: 2 },
    tool_response: { type: "text", file: { startLine: 2, numLines: 2, totalLines: 4, content: "PRIVATE_OUTPUT_CANARY" } } };
  const read = resourceFacts(parseClaudeCodeHook(hook, observedAt, data.env))[0];
  assert.deepEqual(read?.toolRead, { kind: "structured-read", requested: { kind: "lines", start: 2, count: 2 },
    delivery: { kind: "known", returned: { kind: "lines", start: 2, count: 2 }, truncated: false }, revision: { kind: "unknown" } });
  const failed = resourceFacts(parseClaudeCodeHook({ ...hook, hook_event_name: "PostToolUseFailure", error: "PRIVATE_ERROR_CANARY" }, observedAt, data.env))[0];
  assert.equal(failed?.outcome, "error");
  assert.deepEqual(failed?.toolRead?.delivery, { kind: "unknown" });
  const v2 = extractOpenCodeV2Facts({ tool: "read", sessionID: "v2", id: "read", input: { path: data.reference, offset: 2, limit: 2 },
    status: "completed", result: { output: { type: "text-page", offset: 2, next: 4, truncated: true, content: "PRIVATE_OUTPUT_CANARY" } } },
    { projectCwd: data.directory, observedAt, env: data.env });
  assert.deepEqual(resourceFacts(v2)[0]?.toolRead?.delivery, { kind: "known", returned: { kind: "lines", start: 2, count: 2 }, truncated: true });
  const pi = normalizePiTool({ type: "tool_result", toolName: "read", toolCallId: "pi-read", input: { path: data.reference, offset: 2, limit: 2 },
    content: [{ type: "text", text: "PRIVATE_OUTPUT_CANARY" }], isError: false,
    details: { truncation: { truncated: true, outputLines: 1, lastLinePartial: false, content: "PRIVATE_OUTPUT_CANARY" } } }, data.directory);
  assert.ok(pi?.kind === "file");
  assert.deepEqual(pi.delivery, { kind: "known", returned: { kind: "lines", start: 2, count: 1 }, truncated: true });
  assert.equal(JSON.stringify([read, failed, v2, pi]).includes("CANARY"), false);
});

test("OpenCode v2 file and final-page metadata do not prove completeness after its line cap", (t) => {
  const data = fixture(t);
  const content = "PRIVATE_OUTPUT_CANARY".padEnd(2000, "x") + "... (line truncated to 2000 chars)";
  const outputs = [
    { type: "file", uri: `file://${data.reference}`, name: "guide with spaces.md", content, encoding: "utf8", mime: "text/markdown" },
    { type: "text-page", content, mime: "text/markdown", offset: 1, truncated: false },
    { type: "text-page", content, mime: "text/markdown", offset: 1, truncated: true },
    { type: "text-page", content, mime: "text/markdown", offset: 1, truncated: true, next: 1 },
  ];
  for (const output of outputs) {
    const facts = extractOpenCodeV2Facts({ tool: "read", sessionID: "v2", id: "read", input: { path: data.reference },
      status: "completed", result: { output } }, { projectCwd: data.directory, observedAt, env: data.env });
    assert.deepEqual(resourceFacts(facts)[0]?.toolRead?.delivery, { kind: "unknown" });
    assert.equal(JSON.stringify(facts).includes("CANARY"), false);
  }
});

test("Pi attributes parallel general tool calls to their message models and records repeated callbacks once", async (t) => {
  const data = fixture(t);
  const collector = new HotplateCollector({ env: data.env, now: () => new Date(observedAt),
    openStore: () => openHotplateStore({ databasePath: data.databasePath }) });
  const context = { cwd: data.directory, sessionManager: { getLeafId: () => "leaf", getSessionId: () => "pi-session", getSessionFile: () => undefined }, ui: { setStatus() {} } };
  await collector.sessionStart({ type: "session_start", reason: "startup" }, context, () => []);
  collector.beforeAgentStart("read references", context);
  const message = (id: string, model: string, name: string): MessageEndEvent => ({
    type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }],
      provider: "fixture", model, api: "pi-messages", stopReason: "toolUse", timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  });
  collector.messageEnd(message("shell", "shell-model", "bash"));
  collector.messageEnd(message("python", "python-model", "python"));
  collector.messageEnd(message("parent", "nested-model", "codemode"));
  const shell = { type: "tool_result", toolName: "bash", toolCallId: "shell", input: { command: `cat '${data.reference}'` },
    content: [], details: undefined, isError: false } satisfies ToolResultEvent;
  collector.toolResult({ type: "tool_result", toolName: "python", toolCallId: "python", input: { code: `print(open('${data.reference}').read())` },
    content: [], details: undefined, isError: false }, context);
  collector.toolResult(shell, context);
  collector.toolResult(shell, context);
  const nested = { ...shell, toolCallId: "nested", parentToolCallId: "parent",
    structuredContent: { exit_code: 0, output: "PRIVATE_OUTPUT_CANARY", truncated: false } };
  collector.toolResult(nested, context);
  collector.agentEnd();
  collector.toolResult(shell, context);
  collector.toolResult({ ...shell, toolCallId: "unknown-model" }, context);
  await collector.shutdown("quit", context);
  const db = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT payload FROM resource_events WHERE json_extract(payload, '$.evidence.kind') = 'resource-access' ORDER BY json_extract(payload, '$.evidence.operationId')").all();
    const evidence = rows.map((row) => JSON.parse(String(row.payload)).evidence);
    assert.equal(evidence.length, 4);
    assert.deepEqual(evidence.map((entry) => [entry.operationId, entry.model?.id ?? null, entry.access]), [
      ["nested", "nested-model", "inferred-read"],
      ["python", "python-model", "attempt"], ["shell", "shell-model", "inferred-read"], ["unknown-model", null, "inferred-read"],
    ]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM observations WHERE evidence_kind = 'tool-coverage'").get()?.n, 4);
  } finally { db.close(); }
});
