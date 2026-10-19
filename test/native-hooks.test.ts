import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseClaudeCodeHook } from "../src/integrations/claude-code.js";
import { parseCodexHook } from "../src/integrations/codex.js";

const base = { session_id: "session-1", cwd: "/tmp/probe", tool_use_id: "tool-1", hook_event_name: "PostToolUse" };
const time = "2026-09-28T00:00:00.000Z";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-native-hooks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project");
  const claude = join(cwd, ".claude", "skills", "probe", "SKILL.md");
  const codex = join(cwd, ".agents", "skills", "probe", "SKILL.md");
  for (const path of [claude, codex]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "body"); }
  return { cwd, claude, codex, env: { HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config") } };
}

test("Claude completion distinguishes invocation, file read, and failure without retaining content", (t) => {
  const data = fixture(t);
  const secret = "RAW_CONTENT_CANARY";
  const invocation = parseClaudeCodeHook({ ...base, tool_name: "Skill", tool_input: { skill: "probe", args: secret }, tool_response: { content: secret }, prompt: secret }, time);
  assert.equal(invocation[0]?.evidence.kind, "skill-invocation");
  assert.equal(JSON.stringify(invocation).includes(secret), false);
  assert.equal(invocation[0]?.scope.runId, null);
  const read = { ...base, cwd: data.cwd, tool_name: "Read", tool_input: { file_path: data.claude } };
  assert.equal(parseClaudeCodeHook(read, time, data.env)[0]?.evidence.kind, "read-result");
  assert.equal(parseClaudeCodeHook({ ...read, hook_event_name: "PreToolUse" }, time).length, 0);
  const failed = parseClaudeCodeHook({ ...read, hook_event_name: "PostToolUseFailure", error: secret }, time, data.env);
  assert.deepEqual(failed[0]?.evidence, { kind: "read-result", skill: { name: "probe", canonicalPath: data.claude, version: null }, toolCallId: "tool-1", outcome: "error", model: null });
  assert.equal(JSON.stringify(failed).includes(secret), false);
});

test("Codex records narrow shell read attempts without guessing success from response text", (t) => {
  const data = fixture(t);
  const hook = { ...base, cwd: data.cwd, turn_id: "turn-1", tool_name: "Bash", tool_input: { command: `cat ${data.codex}` }, tool_response: "OUTPUT_CANARY" };
  const facts = parseCodexHook(hook, time, data.env);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.evidence.kind, "read-attempt");
  assert.equal(facts[0]?.scope.runId, "turn-1");
  assert.equal(JSON.stringify(facts).includes("OUTPUT_CANARY"), false);
  for (const command of ["cat a/SKILL.md", "echo SKILL.md", "cat /a/SKILL.md; true", "cat /a/SKILL.md && true", "cat /a/SKILL.md\n", "cat $(pwd)/SKILL.md", "cat /a/SKILL.md > output"]) {
    assert.deepEqual(parseCodexHook({ ...hook, tool_input: { command } }, time, data.env), []);
  }
  assert.deepEqual(parseCodexHook({ ...hook, tool_response: { output: "exit code 0" } }, time), []);
  assert.deepEqual(parseCodexHook({ ...hook, tool_response: { exit_code: null, session_id: 42 } }, time), []);
  const failed = parseCodexHook({ ...hook, tool_response: "Process exited with code 1 ERROR_CANARY" }, time, data.env);
  assert.equal(failed[0]?.evidence.kind, "read-attempt");
  assert.equal(JSON.stringify(failed).includes("ERROR_CANARY"), false);
});

test("native parsers require identity and preserve actor isolation without reading transcripts", () => {
  const hook = { ...base, agent_id: "child-1", tool_name: "Skill", tool_input: { skill: "probe" }, transcript_path: "/private/transcript" };
  const fact = parseClaudeCodeHook(hook, time)[0];
  assert.equal(fact?.actorId, "child-1");
  assert.equal(fact?.scope.sessionFile, null);
  assert.deepEqual(parseClaudeCodeHook({ ...hook, tool_use_id: undefined }, time), []);
  assert.deepEqual(parseClaudeCodeHook({ ...hook, hook_event_name: "SubagentStop" }, time), []);
  for (const value of [null, [], "bad", {}, { ...hook, cwd: "relative" }]) assert.deepEqual(parseClaudeCodeHook(value, time), []);
});
