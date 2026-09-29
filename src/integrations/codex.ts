import type { CaptureFact } from "../capture.js";
import { hookContext, object, skillAtPath } from "./common.js";

export function parseCodexHook(input: unknown, observedAt = new Date().toISOString()): readonly CaptureFact[] {
  const hook = object(input);
  if (!hook || hook.hook_event_name !== "PostToolUse" || hook.tool_name !== "Bash") return [];
  const context = hookContext(hook, "codex", observedAt);
  const toolInput = object(hook.tool_input);
  if (!context || !toolInput || typeof hook.tool_response !== "string" || typeof toolInput.command !== "string") return [];
  const match = /^cat (?:-- )?(\/[A-Za-z0-9_./-]+\/SKILL\.md)$/u.exec(toolInput.command);
  if (match?.[0] !== toolInput.command) return [];
  if (!match) return [];
  const skill = skillAtPath(match[1], context.scope.projectCwd);
  if (!skill) return [];
  return [{ ...context, evidence: {
    kind: "read-attempt", skill, toolCallId: context.occurrenceId, model: null,
  } }];
}
