import type { CaptureFact } from "../capture.js";
import type { ReadDelivery } from "../resource-domain.js";
import { discoverResourceRoots } from "../resource-paths.js";
import type { ReadTool, ToolOutcome } from "../tool-reads.js";
import { hookContext, nonnegativeInteger, object, positiveInteger, requestedLines, skillAtResource, text, toolReadFacts } from "./common.js";

export function parseClaudeCodeHook(input: unknown, observedAt = new Date().toISOString(), env: NodeJS.ProcessEnv = process.env): readonly CaptureFact[] {
  const hook = object(input);
  if (!hook || (hook.hook_event_name !== "PostToolUse" && hook.hook_event_name !== "PostToolUseFailure")) return [];
  const context = hookContext(hook, "claude-code", observedAt);
  const toolInput = object(hook.tool_input);
  if (!context || !toolInput) return [];
  const outcome = hook.hook_event_name === "PostToolUse" ? "success" : "error";
  if (hook.tool_name === "Skill" && context.sessionId !== null) {
    const name = text(toolInput.skill);
    if (!name || !/^[\w:.-]+$/u.test(name)) return [];
    return [{ ...context, evidence: { kind: "skill-invocation", skill: { name, canonicalPath: null, version: null }, toolCallId: context.occurrenceId, outcome, model: null } }];
  }
  const tool = normalizeClaudeTool(hook, toolInput, context.scope.projectCwd);
  if (!tool) return [];
  const roots = discoverResourceRoots({ cwd: context.scope.projectCwd, env, project: { host: "claude-code", boundary: { kind: "infer" } } });
  const facts = toolReadFacts(context, tool, roots);
  const resource = facts.find((fact) => fact.evidence.kind === "resource-access")?.evidence;
  const skill = hook.tool_name === "Read" && resource?.kind === "resource-access" ? skillAtResource(resource.resource) : null;
  if (skill && context.sessionId !== null) facts.unshift({ ...context, evidence: { kind: "read-result", skill, toolCallId: context.occurrenceId, outcome, model: null } });
  return facts;
}

function normalizeClaudeTool(hook: Record<string, unknown>, input: Record<string, unknown>, cwd: string): ReadTool | null {
  const failed = hook.hook_event_name === "PostToolUseFailure";
  if (hook.tool_name === "Read") {
    const outcome: ToolOutcome = { kind: failed ? "failed" : "succeeded" };
    return typeof input.file_path === "string"
      ? { kind: "file", path: input.file_path, requested: requestedLines(input.offset, input.limit), outcome,
        delivery: failed ? { kind: "unknown" } : readDelivery(hook.tool_response) }
      : { kind: "opaque", family: "file", outcome, reason: "missing-input" };
  }
  if (hook.tool_name === "Bash") {
    const outcome: ToolOutcome = { kind: failed ? "failed" : "unreported" };
    return typeof input.command === "string"
      ? { kind: "shell", command: input.command, cwd, outcome }
      : { kind: "opaque", family: "shell", outcome, reason: "missing-input" };
  }
  if (hook.tool_name === "PowerShell") return { kind: "opaque", family: "shell", outcome: { kind: failed ? "failed" : "unreported" }, reason: "unsupported-syntax" };
  return null;
}

function readDelivery(response: unknown): ReadDelivery {
  const result = object(response);
  const file = object(result?.file);
  if (result?.type !== "text" || !file || !positiveInteger(file.startLine) || !nonnegativeInteger(file.numLines)
    || !nonnegativeInteger(file.totalLines) || file.numLines > file.totalLines
    || file.startLine - 1 + file.numLines > file.totalLines) return { kind: "unknown" };
  return { kind: "known", returned: { kind: "lines", start: file.startLine, count: file.numLines },
    truncated: file.truncatedByTokenCap === true };
}
