import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeCodeHook } from "../src/integrations/claude-code.js";
import { parseCodexHook } from "../src/integrations/codex.js";

const base = { session_id: "session-1", cwd: "/tmp/probe", tool_use_id: "tool-1", hook_event_name: "PostToolUse" };
const time = "2026-09-28T00:00:00.000Z";

test("Claude completion distinguishes invocation, file read, and failure without retaining content", () => {
  const secret = "RAW_CONTENT_CANARY";
  const invocation = parseClaudeCodeHook({ ...base, tool_name: "Skill", tool_input: { skill: "probe", args: secret }, tool_response: { content: secret }, prompt: secret }, time);
  assert.equal(invocation[0]?.evidence.kind, "skill-invocation");
  assert.equal(JSON.stringify(invocation).includes(secret), false);
  assert.equal(invocation[0]?.scope.runId, null);
  const read = { ...base, tool_name: "Read", tool_input: { file_path: "/tmp/probe/skills/probe/SKILL.md" } };
  assert.equal(parseClaudeCodeHook(read, time)[0]?.evidence.kind, "read-result");
  assert.equal(parseClaudeCodeHook({ ...read, hook_event_name: "PreToolUse" }, time).length, 0);
  const failed = parseClaudeCodeHook({ ...read, hook_event_name: "PostToolUseFailure", error: secret }, time);
  assert.deepEqual(failed[0]?.evidence, { kind: "read-result", skill: { name: "probe", canonicalPath: "/tmp/probe/skills/probe/SKILL.md", version: null }, toolCallId: "tool-1", outcome: "error", model: null });
  assert.equal(JSON.stringify(failed).includes(secret), false);
});

test("Codex records narrow shell read attempts without guessing success from response text", () => {
  const hook = { ...base, turn_id: "turn-1", tool_name: "Bash", tool_input: { command: "cat /tmp/probe/.agents/skills/probe/SKILL.md" }, tool_response: "OUTPUT_CANARY" };
  const facts = parseCodexHook(hook, time);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.evidence.kind, "read-attempt");
  assert.equal(facts[0]?.scope.runId, "turn-1");
  assert.equal(JSON.stringify(facts).includes("OUTPUT_CANARY"), false);
  for (const command of ["cat a/SKILL.md", "echo SKILL.md", "cat /a/SKILL.md; true", "cat /a/SKILL.md && true", "cat /a/SKILL.md\n", "cat $(pwd)/SKILL.md", "cat /a/SKILL.md > output"]) {
    assert.deepEqual(parseCodexHook({ ...hook, tool_input: { command } }, time), []);
  }
  assert.deepEqual(parseCodexHook({ ...hook, tool_response: { output: "exit code 0" } }, time), []);
  assert.deepEqual(parseCodexHook({ ...hook, tool_response: { exit_code: null, session_id: 42 } }, time), []);
  const failed = parseCodexHook({ ...hook, tool_response: "Process exited with code 1 ERROR_CANARY" }, time);
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
