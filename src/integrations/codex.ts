import type { CaptureFact } from "../capture.js";
import { discoverResourceRoots } from "../resource-paths.js";
import { hookContext, object, resourceFact, skillAtResource } from "./common.js";

export function parseCodexHook(input: unknown, observedAt = new Date().toISOString(), env: NodeJS.ProcessEnv = process.env): readonly CaptureFact[] {
  const hook = object(input);
  if (!hook || hook.hook_event_name !== "PostToolUse" || hook.tool_name !== "Bash") return [];
  const context = hookContext(hook, "codex", observedAt);
  const toolInput = object(hook.tool_input);
  if (!context || !toolInput || typeof hook.tool_response !== "string" || typeof toolInput.command !== "string") return [];
  const match = /^cat (?:-- )?(\/[A-Za-z0-9_./-]+\/SKILL\.md)$/u.exec(toolInput.command);
  const facts: CaptureFact[] = [];
  const paths = literalReadPaths(toolInput.command);
  if (!paths.length) return facts;
  const roots = discoverResourceRoots({ cwd: context.scope.projectCwd, env, project: { host: "codex", boundary: { kind: "infer" } } });
  for (const path of paths) {
    const resource = resourceFact(context, path, { access: "attempt", outcome: "unknown", roots });
    if (!resource) continue;
    const skill = match?.[0] === toolInput.command && match[1] === path ? skillAtResource(resource.evidence.resource) : null;
    if (skill && context.sessionId !== null) facts.push({ ...context, evidence: { kind: "read-attempt", skill, toolCallId: context.occurrenceId, model: null } });
    facts.push(resource);
  }
  return facts;
}

function literalReadPaths(command: string): readonly string[] {
  if (command.length > 32768 || /[\u0000-\u001f$`\\]/u.test(command)) return [];
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; }
    else if (character === " ") {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      if (/[;&|<>(){}*?\[\]#!]/u.test(character)) return [];
      token += character;
      started = true;
    }
  }
  if (quote !== null) return [];
  if (started) tokens.push(token);
  let paths: string[];
  if (tokens[0] === "cat") paths = tokens[1] === "--" ? tokens.slice(2) : tokens.slice(1);
  else if (tokens[0] === "sed" && tokens[1] === "-n" && /^\d+(?:,\d+)?p$/u.test(tokens[2] ?? "")) paths = tokens[3] === "--" ? tokens.slice(4) : tokens.slice(3);
  else return [];
  return paths.length <= 128 && paths.every((path) => path.length > 0 && !path.startsWith("-")) ? [...new Set(paths)] : [];
}
