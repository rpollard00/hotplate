import type { CaptureFact } from "../capture.js";
import { discoverResourceRoots } from "../resource-paths.js";
import { hookContext, object, skillAtResource, toolReadFacts } from "./common.js";

export function parseCodexHook(input: unknown, observedAt = new Date().toISOString(), env: NodeJS.ProcessEnv = process.env): readonly CaptureFact[] {
  const hook = object(input);
  if (!hook || hook.hook_event_name !== "PostToolUse" || hook.tool_name !== "Bash") return [];
  const context = hookContext(hook, "codex", observedAt);
  const toolInput = object(hook.tool_input);
  if (!context || !toolInput || typeof hook.tool_response !== "string" || typeof toolInput.command !== "string") return [];
  const match = /^cat (?:-- )?(\/[A-Za-z0-9_./-]+\/SKILL\.md)$/u.exec(toolInput.command);
  const roots = discoverResourceRoots({ cwd: context.scope.projectCwd, env, project: { host: "codex", boundary: { kind: "infer" } } });
  const facts = toolReadFacts(context, { kind: "shell", command: toolInput.command, cwd: null, outcome: { kind: "unreported" } }, roots);
  const resource = facts.find((fact) => fact.evidence.kind === "resource-access")?.evidence;
  if (resource?.kind === "resource-access" && match?.[1] === resource.resource.observedPath) {
    const skill = skillAtResource(resource.resource);
    if (skill && context.sessionId !== null) facts.unshift({ ...context, evidence: { kind: "read-attempt", skill, toolCallId: context.occurrenceId, model: null } });
  }
  return facts;
}
