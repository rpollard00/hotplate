import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Evidence, ModelRef, Observation, ObservationScope } from "./domain.js";
import type { ProcessIdentity, ReadDelivery, ReadPortion, ResourceAccessEvidence, ToolCoverageEvidence, ToolReadMetadata } from "./resource-domain.js";
import { isReadDelivery, isReadPortion } from "./observation.js";
import { qualifyResource, type ResourceRoot } from "./resource-paths.js";

export type ToolOutcome = { kind: "succeeded" } | { kind: "failed" } | { kind: "unreported" };
export type ReadTool =
  | { kind: "file"; path: string; requested: ReadPortion; outcome: ToolOutcome; delivery: ReadDelivery }
  | { kind: "shell"; command: string; cwd: string | null; outcome: ToolOutcome }
  | { kind: "python"; code: string; cwd: string | null; outcome: ToolOutcome }
  | { kind: "opaque"; family: ToolCoverageEvidence["family"]; outcome: ToolOutcome; reason?: OpaqueReason };
export type ToolReadContext = {
  cwd: string;
  roots: readonly ResourceRoot[];
  model: ModelRef;
  process: ProcessIdentity | null;
  attribution: "session" | "harness";
};
type OpaqueReason = Extract<ToolCoverageEvidence["recognition"], { kind: "opaque" }>["reason"];
type Target = { path: string; requested: ReadPortion };
type Recognition = { kind: "recognized"; targets: readonly Target[] } | { kind: "opaque"; reason: OpaqueReason };
const MAX_INPUT = 32_768;
const MAX_TARGETS = 128;
const whole = { kind: "whole" } as const;

export function captureToolReads(input: {
  operationId: string; tool: ReadTool; context: ToolReadContext;
}): readonly (ResourceAccessEvidence | ToolCoverageEvidence)[] {
  const { tool, context, operationId } = input;
  const parsed = recognize(tool);
  const recognition: Recognition = parsed.kind === "recognized" && (tool.kind === "shell" || tool.kind === "python")
    && tool.cwd === null && parsed.targets.some(target => !isAbsolute(target.path))
    ? { kind: "opaque", reason: "missing-input" } : parsed;
  const family = tool.kind === "opaque" ? tool.family : tool.kind;
  const outcome = tool.outcome.kind === "succeeded" ? "success" : tool.outcome.kind === "failed" ? "error" : "unknown";
  const resources = new Map<string, ResourceAccessEvidence>();
  if (recognition.kind === "recognized") {
    const cwd = (tool.kind === "shell" || tool.kind === "python" ? tool.cwd : context.cwd) ?? context.cwd;
    for (const target of recognition.targets) {
      const path = tool.kind === "shell" || tool.kind === "python" ? resolve(cwd, target.path) : target.path;
      const resource = qualifyResource({ path, cwd, roots: context.roots });
      if (!resource) continue;
      const key = JSON.stringify([resource.filesystemId, resource.canonicalPath]);
      if (resources.has(key)) continue;
      const toolRead: ToolReadMetadata = {
        kind: tool.kind === "file" ? "structured-read" : "literal-command",
        requested: target.requested,
        delivery: tool.kind === "file" && outcome === "success" ? tool.delivery : { kind: "unknown" },
        revision: { kind: "unknown" },
      };
      const base = { kind: "resource-access", resource, operationId, mechanism: "host-tool",
        model: context.model, process: context.process, attribution: context.attribution, toolRead } as const;
      const evidence: ResourceAccessEvidence = tool.kind === "file" && outcome !== "unknown"
        ? { ...base, access: "read", outcome, toolRead: { ...toolRead, kind: "structured-read" } }
        : tool.kind !== "file" && outcome === "success" ? { ...base, access: "inferred-read", outcome: "success", toolRead: { ...toolRead, kind: "literal-command" } }
        : { ...base, access: "attempt", outcome: "unknown" };
      resources.set(key, evidence);
    }
  }
  return [...resources.values(), { kind: "tool-coverage", operationId, family, outcome, model: context.model,
    recognition: recognition.kind === "opaque" ? recognition : { kind: "recognized", resourceCount: resources.size } }];
}

type ToolIdentityEvidence = Extract<Evidence, { kind: "resource-access" | "tool-coverage" | "read-result" | "read-attempt" }>;
export function toolObservationIdentity(input: {
  host: "pi"; scope: ObservationScope; evidence: ToolIdentityEvidence;
}): Pick<Observation, "id" | "producerId" | "sequence"> {
  const { host, scope, evidence } = input;
  const operation = evidence.kind === "resource-access" || evidence.kind === "tool-coverage" ? evidence.operationId : evidence.toolCallId;
  const target = evidence.kind === "resource-access" ? [evidence.resource.filesystemId, evidence.resource.canonicalPath]
    : evidence.kind === "tool-coverage" ? [] : [evidence.skill.canonicalPath];
  const receipt = createHash("sha256").update(JSON.stringify([host, scope.sessionId ?? scope.segmentId, operation, evidence.kind, ...target])).digest("hex");
  return { id: `native:tool:${receipt}`, producerId: `native:tool:${receipt}`, sequence: 0 };
}

function recognize(tool: ReadTool): Recognition {
  switch (tool.kind) {
    case "file": return validPath(tool.path) && isReadPortion(tool.requested) && isReadDelivery(tool.delivery) ? { kind: "recognized", targets: [{ path: tool.path, requested: tool.requested }] }
      : { kind: "opaque", reason: "missing-input" };
    case "shell": return shellReads(tool.command);
    case "python": return pythonReads(tool.code);
    case "opaque": return { kind: "opaque", reason: tool.reason ?? "unsupported-tool" };
    default: { const exhaustive: never = tool; return exhaustive; }
  }
}

function shellReads(command: string): Recognition {
  if (command.length > MAX_INPUT) return { kind: "opaque", reason: "limit" };
  const tokens = shellWords(command);
  if (!tokens || tokens.length === 0) return { kind: "opaque", reason: "unsupported-syntax" };
  const [program, ...args] = tokens;
  let paths: readonly string[];
  let requested: ReadPortion = whole;
  let literalOptions = false;
  if (program === "python" || program === "python3") {
    return args.length === 2 && args[0] === "-c" && args[1] !== undefined
      ? pythonReads(args[1]) : { kind: "opaque", reason: "unsupported-syntax" };
  }
  if (program === "cat") {
    literalOptions = args[0] === "--";
    paths = literalOptions ? args.slice(1) : args;
  } else if (program === "sed" && args[0] === "-n") {
    const range = /^(\d+)(?:,(\d+))?p$/u.exec(args[1] ?? "");
    if (!range) return { kind: "opaque", reason: "unsupported-syntax" };
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return { kind: "opaque", reason: "unsupported-syntax" };
    requested = { kind: "lines", start, count: end - start + 1 };
    literalOptions = args[2] === "--";
    paths = args.slice(literalOptions ? 3 : 2);
    if (paths.length !== 1) return { kind: "opaque", reason: "unsupported-syntax" };
  } else if (program === "head") {
    let count = 10;
    let offset = 0;
    if (args[0] === "-n") {
      if (!/^\d+$/u.test(args[1] ?? "")) return { kind: "opaque", reason: "unsupported-syntax" };
      count = Number(args[1]); offset = 2;
    }
    if (!Number.isSafeInteger(count) || count < 1) return { kind: "opaque", reason: "unsupported-syntax" };
    requested = { kind: "lines", start: 1, count };
    literalOptions = args[offset] === "--";
    paths = args.slice(offset + (literalOptions ? 1 : 0));
  } else return { kind: "opaque", reason: "unsupported-syntax" };
  if (paths.length > MAX_TARGETS) return { kind: "opaque", reason: "limit" };
  if (paths.length === 0 || !paths.every(path => validPath(path) && path !== "-" && (literalOptions || !path.startsWith("-")))) {
    return { kind: "opaque", reason: "unsupported-syntax" };
  }
  return { kind: "recognized", targets: paths.map(path => ({ path, requested })) };
}

function shellWords(command: string): readonly string[] | null {
  if (/[\u0000-\u0008\u000a-\u001f]/u.test(command)) return null;
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) break;
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
    } else if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") return null;
      else if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined) return null;
        if (/[$`"\\]/u.test(next)) { word += next; index += 1; }
        else word += character;
      } else word += character;
    } else if (character === "'" || character === '"') { quote = character; started = true; }
    else if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) return null;
      word += next; started = true; index += 1;
    } else if (character === " " || character === "\t") {
      if (started) words.push(word);
      if (words.length > MAX_TARGETS + 8) return null;
      word = ""; started = false;
    } else {
      if (/[;&|<>(){}*?\[\]#!$`~]/u.test(character)) return null;
      word += character; started = true;
    }
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

type PythonToken = { kind: "name" | "punctuation"; value: string } | { kind: "string"; value: string };
function pythonReads(code: string): Recognition {
  const opaque = { kind: "opaque", reason: "unsupported-syntax" } as const;
  if (code.length > MAX_INPUT) return { kind: "opaque", reason: "limit" };
  const tokens = pythonTokens(code);
  if (!tokens) return opaque;
  let index = 0;
  const take = (kind: PythonToken["kind"], value: string): boolean => {
    const token = tokens[index];
    if (token?.kind !== kind || token.value !== value) return false;
    index += 1; return true;
  };
  let pathConstructor: "Path" | "pathlib" | null = null;
  if (take("name", "from")) {
    if (!take("name", "pathlib") || !take("name", "import") || !take("name", "Path") || !take("punctuation", ";")) return opaque;
    pathConstructor = "Path";
  } else if (take("name", "import")) {
    if (!take("name", "pathlib") || !take("punctuation", ";")) return opaque;
    pathConstructor = "pathlib";
  }
  const printed = take("name", "print");
  if (printed && !take("punctuation", "(")) return opaque;
  let method: "read" | "read_text";
  if (take("name", "open")) method = "read";
  else if (pathConstructor === "Path" && take("name", "Path")) method = "read_text";
  else if (pathConstructor === "pathlib" && take("name", "pathlib") && take("punctuation", ".") && take("name", "Path")) method = "read_text";
  else return opaque;
  if (!take("punctuation", "(")) return opaque;
  const path = tokens[index];
  if (path?.kind !== "string" || !validPath(path.value)) return opaque;
  index += 1;
  if (method === "read" && take("punctuation", ",")) {
    if (!take("string", "r")) return opaque;
  }
  if (!take("punctuation", ")") || !take("punctuation", ".") || !take("name", method)
    || !take("punctuation", "(") || !take("punctuation", ")") || (printed && !take("punctuation", ")")) || index !== tokens.length) return opaque;
  return { kind: "recognized", targets: [{ path: path.value, requested: whole }] };
}

function pythonTokens(code: string): readonly PythonToken[] | null {
  const tokens: PythonToken[] = [];
  for (let index = 0; index < code.length;) {
    const character = code[index];
    if (character === undefined) break;
    if (character === " " || character === "\t") { index += 1; continue; }
    if (/[\u0000-\u001f]/u.test(character)) return null;
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      let value = "";
      let closed = false;
      while (index < code.length) {
        const next = code[index];
        index += 1;
        if (next === quote) { closed = true; break; }
        if (next === "\\") {
          const escaped = code[index];
          if (escaped !== "\\" && escaped !== "'" && escaped !== '"') return null;
          value += escaped; index += 1;
        } else if (next !== undefined) value += next;
      }
      if (!closed) return null;
      tokens.push({ kind: "string", value });
    } else if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      while (index < code.length && /[A-Za-z_0-9]/u.test(code[index] ?? "")) index += 1;
      tokens.push({ kind: "name", value: code.slice(start, index) });
    } else if (/[().,;]/u.test(character)) { tokens.push({ kind: "punctuation", value: character }); index += 1; }
    else return null;
    if (tokens.length > 64) return null;
  }
  return tokens;
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\u0000-\u001f]/u.test(path);
}
