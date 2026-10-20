import { createHash } from "node:crypto";
import { homedir } from "node:os";
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
  home?: string;
};
type OpaqueReason = Extract<ToolCoverageEvidence["recognition"], { kind: "opaque" }>["reason"];
type Target = { path: string; requested: ReadPortion; outcome: ToolOutcome };
type Opaque = { kind: "opaque"; reason: OpaqueReason; targets: readonly Target[] };
type Recognition = { kind: "recognized"; targets: readonly Target[] } | Opaque;
const MAX_INPUT = 32_768;
const MAX_TARGETS = 128;
const MAX_STAGES = 64;
const whole = { kind: "whole" } as const;
const unreported = { kind: "unreported" } as const;
const opaque = (reason: OpaqueReason): Opaque => ({ kind: "opaque", reason, targets: [] });

export function captureToolReads(input: {
  operationId: string; tool: ReadTool; context: ToolReadContext;
}): readonly (ResourceAccessEvidence | ToolCoverageEvidence)[] {
  const { tool, context, operationId } = input;
  const recognition = recognize(tool, context.home ?? homedir());
  const family = tool.kind === "opaque" ? tool.family : tool.kind;
  const outcome = reportedOutcome(tool.outcome);
  const cwd = (tool.kind === "shell" || tool.kind === "python" ? tool.cwd : context.cwd) ?? context.cwd;
  const resources = new Map<string, ResourceAccessEvidence>();
  for (const target of recognition.targets) {
    const resource = qualifyResource({ path: target.path, cwd, roots: context.roots });
    if (!resource) continue;
    const key = JSON.stringify([resource.filesystemId, resource.canonicalPath]);
    if (resources.has(key)) continue;
    const result = reportedOutcome(target.outcome);
    const toolRead: ToolReadMetadata = {
      kind: tool.kind === "file" ? "structured-read" : "literal-command",
      requested: target.requested,
      delivery: tool.kind === "file" && result === "success" ? tool.delivery : { kind: "unknown" },
      revision: { kind: "unknown" },
    };
    const base = { kind: "resource-access", resource, operationId, mechanism: "host-tool",
      model: context.model, process: context.process, attribution: context.attribution, toolRead } as const;
    const evidence: ResourceAccessEvidence = tool.kind === "file" && result !== "unknown"
      ? { ...base, access: "read", outcome: result, toolRead: { ...toolRead, kind: "structured-read" } }
      : tool.kind !== "file" && result === "success" ? { ...base, access: "inferred-read", outcome: "success", toolRead: { ...toolRead, kind: "literal-command" } }
      : { ...base, access: "attempt", outcome: "unknown" };
    resources.set(key, evidence);
  }
  return [...resources.values(), { kind: "tool-coverage", operationId, family, outcome, model: context.model,
    recognition: recognition.kind === "opaque" ? { kind: "opaque", reason: recognition.reason } : { kind: "recognized", resourceCount: resources.size } }];
}

function reportedOutcome(outcome: ToolOutcome): ToolCoverageEvidence["outcome"] {
  return outcome.kind === "succeeded" ? "success" : outcome.kind === "failed" ? "error" : "unknown";
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

function recognize(tool: ReadTool, home: string): Recognition {
  switch (tool.kind) {
    case "file": return validPath(tool.path) && isReadPortion(tool.requested) && isReadDelivery(tool.delivery)
      ? { kind: "recognized", targets: [{ path: tool.path, requested: tool.requested, outcome: tool.outcome }] } : opaque("missing-input");
    case "shell": return tool.command.length > MAX_INPUT ? opaque("limit") : shellReads(tool.command, { cwd: knownCwd(tool.cwd), home, outcome: tool.outcome });
    case "python": return tool.code.length > MAX_INPUT ? opaque("limit")
      : interpret([{ connector: "start", pipeline: [{ words: ["python3", "-c", tool.code], redirects: [] }] }], { cwd: knownCwd(tool.cwd), home, outcome: tool.outcome });
    case "opaque": return opaque(tool.reason ?? "unsupported-tool");
    default: { const exhaustive: never = tool; return exhaustive; }
  }
}

type Redirect = { fd: number | null; op: ">" | ">>" | "<" | ">&" | "&>"; target: string };
type ShellToken = { kind: "word"; value: string; assignment: boolean } | { kind: "operator"; value: "&&" | "||" | ";" | "\n" | "|" } | ({ kind: "redirect" } & Redirect);
type SimpleCommand = { words: readonly string[]; redirects: readonly Redirect[] };
type ShellStep = { connector: "start" | "and" | "or" | "seq"; pipeline: readonly SimpleCommand[] };
type Cwd = { kind: "known"; path: string } | { kind: "unknown" };
type ShellState = { cwd: Cwd; home: string; outcome: ToolOutcome };
type ReaderRequest = { paths: readonly string[]; requested: ReadPortion };
const unknownCwd = { kind: "unknown" } as const;
const knownCwd = (path: string | null): Cwd => path === null ? unknownCwd : { kind: "known", path };

function shellReads(command: string, state: ShellState): Recognition {
  const tokens = shellTokens(command, state.home);
  if (!tokens) return opaque("unsupported-syntax");
  const parsed = shellSteps(tokens);
  return parsed.kind === "opaque" ? parsed : interpret(parsed.steps, state);
}

function shellTokens(command: string, home: string): readonly ShellToken[] | null {
  if (/[\u0000-\u0008\u000b-\u001f]/u.test(command)) return null;
  const tokens: ShellToken[] = [];
  let word = "";
  let started = false;
  let literalUntil: number | null = null;
  let quote: "'" | '"' | null = null;
  let pending: Omit<Redirect, "target"> | null = null;
  const flush = (): void => {
    if (!started) return;
    const assignment = /^[A-Za-z_]\w*=/u.test(word) && (literalUntil === null || literalUntil > word.indexOf("="));
    tokens.push(pending ? { kind: "redirect", ...pending, target: word } : { kind: "word", value: word, assignment });
    pending = null; word = ""; started = false; literalUntil = null;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (character === undefined) break;
    if (quote === "'") {
      if (character === "'") quote = null;
      else word += character;
    } else if (character === "$") {
      const length = command.startsWith("${HOME}", index) ? 7 : command.startsWith("$HOME", index) && !/\w/u.test(command[index + 5] ?? "") ? 5 : 0;
      if (length === 0) return null;
      literalUntil ??= word.length;
      word += home; started = true; index += length - 1;
    } else if (character === "`") return null;
    else if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") {
        if (next === undefined) return null;
        if (next === "\n") index += 1;
        else if (/[$`"\\]/u.test(next)) { word += next; index += 1; }
        else word += character;
      } else word += character;
    } else if (character === "'" || character === '"') { quote = character; started = true; literalUntil ??= word.length; }
    else if (character === "\\") {
      if (next === undefined) return null;
      if (next !== "\n") { literalUntil ??= word.length; word += next; started = true; }
      index += 1;
    } else if (character === " " || character === "\t") flush();
    else if (character === "#" && !started) { while (command[index + 1] !== undefined && command[index + 1] !== "\n") index += 1; }
    else if (character === "~" && !started) {
      if (next !== undefined && !/[\s/;&|<>]/u.test(next)) return null;
      literalUntil ??= word.length;
      word += home; started = true;
    } else if (character === "<" || character === ">") {
      const fd: number | null = pending === null && started && literalUntil === null && /^\d+$/u.test(word) ? Number(word) : null;
      if (fd === null) flush();
      else { word = ""; started = false; }
      if (pending !== null) return null;
      if (character === "<") {
        if (next === "<" || next === "(" || next === "&" || next === ">") return null;
        pending = { fd, op: "<" };
      } else if (next === ">" || next === "&") { pending = { fd, op: next === ">" ? ">>" : ">&" }; index += 1; }
      else if (next === "(" || next === "|") return null;
      else pending = { fd, op: ">" };
    } else if (character === "&" || character === "|" || character === ";" || character === "\n") {
      flush();
      if (pending !== null) return null;
      if (character === "&") {
        if (next === "&") tokens.push({ kind: "operator", value: "&&" });
        else if (next === ">" && command[index + 2] !== ">") pending = { fd: null, op: "&>" };
        else return null;
        index += 1;
      } else if (character === "|") {
        if (next === "&") return null;
        tokens.push({ kind: "operator", value: next === "|" ? "||" : "|" });
        if (next === "|") index += 1;
      } else if (character === ";" && (next === ";" || next === "&")) return null;
      else tokens.push({ kind: "operator", value: character });
    } else if (/[*?[\]~(){}]/u.test(character)) return null;
    else { word += character; started = true; }
  }
  if (quote !== null) return null;
  flush();
  return pending === null ? tokens : null;
}

const shellKeywords = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "time", "!", "[[", "]]", "{"]);
const unmodelled = new Set(["builtin", "command", "eval", ".", "source", "exec"]);
const connectors = { "&&": "and", "||": "or", ";": "seq", "\n": "seq" } as const;
function shellSteps(tokens: readonly ShellToken[]): { kind: "steps"; steps: readonly ShellStep[] } | Opaque {
  const steps: ShellStep[] = [];
  let connector: ShellStep["connector"] = "start";
  let pipeline: SimpleCommand[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let empty = true;
  let assigned = false;
  let stages = 0;
  for (const token of [...tokens, { kind: "operator", value: "\n" } as const]) {
    if (token.kind === "word") {
      if (words.length > 0 || !token.assignment) words.push(token.value);
      else if (/^(?:HOME|CDPATH)=/u.test(token.value)) return opaque("unsupported-syntax");
      else assigned = true;
      empty = false;
    } else if (token.kind === "redirect") { redirects.push({ fd: token.fd, op: token.op, target: token.target }); empty = false; }
    else if (empty) {
      if (token.value !== "\n") return opaque("unsupported-syntax");
    } else {
      const [program] = words;
      if (program === undefined ? assigned : shellKeywords.has(program) || unmodelled.has(program)) return opaque("unsupported-syntax");
      pipeline.push({ words, redirects });
      stages += 1;
      if (stages > MAX_STAGES) return opaque("limit");
      words = []; redirects = []; empty = true; assigned = false;
      if (token.value === "|") continue;
      steps.push({ connector, pipeline });
      pipeline = []; connector = connectors[token.value];
    }
  }
  return steps.length === 0 || pipeline.length > 0 || connector === "and" || connector === "or"
    ? opaque("unsupported-syntax") : { kind: "steps", steps };
}

const readers: Readonly<Record<string, (args: readonly string[]) => ReaderRequest | null>> = {
  cat: args => operands(args[0] === "-n" ? args.slice(1) : args, whole),
  nl: args => operands(args, whole),
  head: args => {
    const option = lineOption(args);
    if (!option || (option.value !== null && !/^\d+$/u.test(option.value))) return null;
    const count = option.value === null ? 10 : Number(option.value);
    return Number.isSafeInteger(count) && count >= 1 ? operands(option.rest, { kind: "lines", start: 1, count }) : null;
  },
  tail: args => {
    const option = args.length === 2 && /^\+\d+$/u.test(args[0] ?? "") ? { value: args[0] ?? null, rest: args.slice(1) } : lineOption(args);
    if (!option || option.rest.some(path => path.startsWith("+"))) return null;
    const from = /^\+(\d+)$/u.exec(option.value ?? "");
    const start = Number(from?.[1]);
    if (from) return Number.isSafeInteger(start) && start >= 1 ? operands(option.rest, { kind: "lines", start, count: null }) : null;
    return option.value === null || /^\d+$/u.test(option.value) ? operands(option.rest, { kind: "unknown" }) : null;
  },
  sed: args => {
    const range = args[0] === "-n" ? /^(\d+)(?:,(\d+|\$))?p$/u.exec(args[1] ?? "") : null;
    if (!range) return null;
    const start = Number(range[1]);
    const end = range[2] === "$" ? null : Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(start) || start < 1 || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
    const request = operands(args.slice(2), { kind: "lines", start, count: end === null ? null : end - start + 1 });
    return request && request.paths.length <= 1 ? request : null;
  },
  python: pythonCommand,
  python3: pythonCommand,
};
const filters: Readonly<Record<string, { programs: number; values: readonly string[] }>> = {
  head: { programs: 0, values: ["-n", "-c"] }, tail: { programs: 0, values: ["-n", "-c"] }, sed: { programs: 1, values: ["-e"] },
  grep: { programs: 1, values: ["-e", "-m", "-A", "-B", "-C"] }, rg: { programs: 1, values: ["-e", "-m", "-A", "-B", "-C", "-g", "-t"] },
  awk: { programs: 1, values: ["-F", "-v"] }, jq: { programs: 1, values: [] }, tr: { programs: 2, values: [] }, cut: { programs: 0, values: ["-d", "-f", "-c", "-b"] },
  sort: { programs: 0, values: ["-k", "-t"] }, wc: { programs: 0, values: [] }, uniq: { programs: 0, values: [] }, nl: { programs: 0, values: [] },
  cat: { programs: 0, values: [] }, less: { programs: 0, values: [] },
};
const effectFree = new Set(["echo", "printf", "true", "false", "pwd", "ls"]);

function operands(args: readonly string[], requested: ReadPortion): ReaderRequest | null {
  const literal = args[0] === "--";
  const paths = literal ? args.slice(1) : args;
  return paths.every(path => validPath(path) && path !== "-" && (literal || !path.startsWith("-"))) ? { paths, requested } : null;
}

function lineOption(args: readonly string[]): { value: string | null; rest: readonly string[] } | null {
  if (args[0] === "-n") return args[1] === undefined ? null : { value: args[1], rest: args.slice(2) };
  const attached = /^-(?:n|(?=\d))(\+?\d+)$/u.exec(args[0] ?? "");
  return attached ? { value: attached[1] ?? null, rest: args.slice(1) } : { value: null, rest: args };
}

function pythonCommand(args: readonly string[]): ReaderRequest | null {
  return args.length === 2 && args[0] === "-c" && args[1] !== undefined ? pythonReads(args[1]) : null;
}

function stdinFilter(program: string, args: readonly string[]): boolean {
  const filter = filters[program];
  if (!filter) return false;
  let programs = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") { programs += args.length - index - 1; break; }
    if (filter.values.includes(arg)) index += 1;
    else if (arg === "-" || !arg.startsWith("-")) programs += 1;
  }
  return programs <= filter.programs;
}

type Destination = "stdout" | "stderr" | "pipe" | "other";
function stdoutDestination(command: SimpleCommand, initial: Destination): Destination {
  let out = initial;
  let err: Destination = "stderr";
  for (const redirect of command.redirects) {
    if (redirect.op === "<") continue;
    if (redirect.op === "&>" || (redirect.op === ">&" && redirect.fd === null && !/^(?:\d+|-)$/u.test(redirect.target))) { out = "other"; err = "other"; continue; }
    const fd = redirect.fd ?? 1;
    const destination: Destination = redirect.op === ">&" ? redirect.target === "1" ? out : redirect.target === "2" ? err : "other"
      : redirect.target === "/dev/stdout" ? out : redirect.target === "/dev/stderr" ? err : "other";
    if (fd === 1) out = destination;
    else if (fd === 2) err = destination;
  }
  return out;
}

function reachesTerminal(pipeline: readonly SimpleCommand[], stage: number): boolean {
  for (const [index, command] of pipeline.entries()) {
    if (index < stage) continue;
    const [program, ...args] = command.words;
    if (index > stage && (program === undefined || !stdinFilter(program, args) || command.redirects.some(redirect => redirect.op === "<" && (redirect.fd ?? 0) === 0))) return false;
    const destination = stdoutDestination(command, index === pipeline.length - 1 ? "stdout" : "pipe");
    if (destination !== "pipe") return destination !== "other";
  }
  return false;
}

function isExit(step: ShellStep): boolean {
  const [command, ...rest] = step.pipeline;
  const [name, ...args] = command?.words ?? [];
  return rest.length === 0 && name === "exit" && (args.length === 0 || (args.length === 1 && /^\d+$/u.test(args[0] ?? "")));
}

function place(path: string, cwd: Cwd): string | null {
  return isAbsolute(path) ? resolve(path) : cwd.kind === "known" ? resolve(cwd.path, path) : null;
}

function changeDirectory(cwd: Cwd, args: readonly string[], home: string): Cwd {
  const literal = args[0] === "--";
  const paths = literal ? args.slice(1) : args;
  const [path] = paths;
  if (path === undefined) return { kind: "known", path: home };
  const target = paths.length === 1 && validPath(path) && path !== "-" && (literal || !path.startsWith("-")) ? place(path, cwd) : null;
  return target === null ? unknownCwd : { kind: "known", path: target };
}

function interpret(steps: readonly ShellStep[], state: ShellState): Recognition {
  const settled = steps.every(step => step.connector === "start" || step.connector === "and");
  const targets: Target[] = [];
  let reason: OpaqueReason | null = null;
  let cwd = state.cwd;
  const confirmed = { or: false, seq: false };
  let unconfirmed = confirmed;
  for (const [index, step] of steps.entries()) {
    const single = step.pipeline.length === 1;
    const broken = step.connector === "or" ? unconfirmed.or : step.connector === "seq" && unconfirmed.seq;
    if (broken) cwd = unknownCwd;
    if (broken || step.connector === "seq") unconfirmed = confirmed;
    for (const [stage, command] of step.pipeline.entries()) {
      const [program, ...args] = command.words;
      if (program === undefined) continue;
      if (program === "cd") {
        if (!single) continue;
        if (step.connector === "or") { cwd = unknownCwd; continue; }
        const fallback = steps[index + 1];
        const guarded = fallback?.connector === "or" && isExit(fallback);
        cwd = changeDirectory(cwd, args, state.home);
        unconfirmed = { or: unconfirmed.or || !guarded, seq: unconfirmed.seq || step.connector === "and" };
        continue;
      }
      if (program === "exit") {
        const guard = step.connector === "or" && steps[index - 1]?.pipeline.length === 1 && steps[index - 1]?.pipeline[0]?.words[0] === "cd";
        if (isExit(step) && (guard || index === steps.length - 1)) continue;
        return opaque("unsupported-syntax");
      }
      if (program === "pushd" || program === "popd") { cwd = unknownCwd; continue; }
      if (effectFree.has(program)) continue;
      const request = readers[program]?.(args) ?? null;
      const input = command.redirects.findLast(redirect => redirect.op === "<" && (redirect.fd === null || redirect.fd === 0));
      if (request && (request.paths.length > 0 || input)) {
        if (!reachesTerminal(step.pipeline, stage)) continue;
        for (const path of request.paths.length > 0 ? request.paths : [input?.target ?? ""]) {
          const resolved = validPath(path) && !path.split("/").includes("..") ? place(path, cwd) : null;
          if (resolved === null) reason ??= validPath(path) ? "missing-input" : "unsupported-syntax";
          else targets.push({ path: resolved, requested: request.requested, outcome: settled && single ? state.outcome : unreported });
        }
      } else if (input || stage === 0 || (request === null && !stdinFilter(program, args))) reason ??= "unsupported-syntax";
    }
  }
  if (targets.length > MAX_TARGETS) return opaque("limit");
  return reason === null ? { kind: "recognized", targets } : { kind: "opaque", reason, targets };
}
type PythonToken = { kind: "name" | "punctuation"; value: string } | { kind: "string"; value: string };
function pythonReads(code: string): ReaderRequest | null {
  const tokens = pythonTokens(code);
  if (!tokens) return null;
  let index = 0;
  const take = (kind: PythonToken["kind"], value: string): boolean => {
    const token = tokens[index];
    if (token?.kind !== kind || token.value !== value) return false;
    index += 1; return true;
  };
  let pathConstructor: "Path" | "pathlib" | null = null;
  if (take("name", "from")) {
    if (!take("name", "pathlib") || !take("name", "import") || !take("name", "Path") || !take("punctuation", ";")) return null;
    pathConstructor = "Path";
  } else if (take("name", "import")) {
    if (!take("name", "pathlib") || !take("punctuation", ";")) return null;
    pathConstructor = "pathlib";
  }
  const printed = take("name", "print");
  if (printed && !take("punctuation", "(")) return null;
  let method: "read" | "read_text";
  if (take("name", "open")) method = "read";
  else if (pathConstructor === "Path" && take("name", "Path")) method = "read_text";
  else if (pathConstructor === "pathlib" && take("name", "pathlib") && take("punctuation", ".") && take("name", "Path")) method = "read_text";
  else return null;
  if (!take("punctuation", "(")) return null;
  const path = tokens[index];
  if (path?.kind !== "string" || !validPath(path.value)) return null;
  index += 1;
  if (method === "read" && take("punctuation", ",")) {
    if (!take("string", "r")) return null;
  }
  if (!take("punctuation", ")") || !take("punctuation", ".") || !take("name", method)
    || !take("punctuation", "(") || !take("punctuation", ")") || (printed && !take("punctuation", ")")) || index !== tokens.length) return null;
  return { paths: [path.value], requested: whole };
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
