import type { CaptureFact } from "../capture.js";
import { hookContext, object, resourceFact, skillAtPath, text } from "./common.js";

export function parseClaudeCodeHook(input: unknown, observedAt = new Date().toISOString(), env: NodeJS.ProcessEnv = process.env): readonly CaptureFact[] {
  const hook = object(input);
  if (!hook || (hook.hook_event_name !== "PostToolUse" && hook.hook_event_name !== "PostToolUseFailure")) return [];
  const context = hookContext(hook, "claude-code", observedAt);
  const toolInput = object(hook.tool_input);
  if (!context || !toolInput) return [];
  const outcome = hook.hook_event_name === "PostToolUse" ? "success" : "error";
  if (hook.tool_name === "Read") {
    const skill = skillAtPath(toolInput.file_path, context.scope.projectCwd);
    const facts: CaptureFact[] = skill && context.sessionId !== null ? [{ ...context, evidence: { kind: "read-result", skill, toolCallId: context.occurrenceId, outcome, model: null } }] : [];
    const resource = resourceFact(context, toolInput.file_path, { access: "read", outcome, env });
    if (resource) facts.push(resource);
    return facts;
  }
  if (hook.tool_name === "Skill" && context.sessionId !== null) {
    const name = text(toolInput.skill);
    if (!name || !/^[\w:.-]+$/u.test(name)) return [];
    return [{ ...context, evidence: { kind: "skill-invocation", skill: { name, canonicalPath: null, version: null }, toolCallId: context.occurrenceId, outcome, model: null } }];
  }
  return [];
}
