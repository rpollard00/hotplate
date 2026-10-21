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
  glob?: ShellGlob;
};
export type WorkBudget = { remaining: number };
export type ShellGlob = (pattern: string, cwd: string, budget: WorkBudget) => readonly string[] | null;
type OpaqueReason = Extract<ToolCoverageEvidence["recognition"], { kind: "opaque" }>["reason"];
type Use = { access: "read"; requested: ReadPortion } | { access: "execute" };
type Target = { path: string; outcome: ToolOutcome } & Use;
type Opaque = { kind: "opaque"; reason: OpaqueReason; targets: readonly Target[] };
type Recognition = { kind: "recognized"; targets: readonly Target[] } | Opaque;
const MAX_INPUT = 32_768;
const MAX_TARGETS = 128;
const MAX_STAGES = 64;
const MAX_NESTING = 32;
const WORK_BUDGET = 1_000_000;
const STEP_COST = 100;
const whole = { kind: "whole" } as const;
const unreported = { kind: "unreported" } as const;
const opaque = (reason: OpaqueReason): Opaque => ({ kind: "opaque", reason, targets: [] });

export function captureToolReads(input: {
  operationId: string; tool: ReadTool; context: ToolReadContext;
}): readonly (ResourceAccessEvidence | ToolCoverageEvidence)[] {
  const { tool, context, operationId } = input;
  const recognition = recognize(tool, { home: context.home ?? homedir(), outcome: tool.outcome, glob: context.glob ?? null, budget: { remaining: WORK_BUDGET } });
  const family = tool.kind === "opaque" ? tool.family : tool.kind;
  const outcome = reportedOutcome(tool.outcome);
  const cwd = (tool.kind === "shell" || tool.kind === "python" ? tool.cwd : context.cwd) ?? context.cwd;
  const resources = new Map<string, ResourceAccessEvidence>();
  let foreignExecution = false;
  for (const target of recognition.targets) {
    const resource = qualifyResource({ path: target.path, cwd, roots: context.roots });
    if (!resource) { foreignExecution ||= target.access === "execute"; continue; }
    const key = JSON.stringify([resource.filesystemId, resource.canonicalPath, target.access]);
    if (resources.has(key)) continue;
    const result = reportedOutcome(target.outcome);
    const identity = { kind: "resource-access", resource, operationId, mechanism: "host-tool",
      model: context.model, process: context.process, attribution: context.attribution } as const;
    if (target.access === "execute") { resources.set(key, { ...identity, access: "execute", outcome: result === "success" ? "success" : "unknown" }); continue; }
    const toolRead: ToolReadMetadata = {
      kind: tool.kind === "file" ? "structured-read" : "literal-command",
      requested: target.requested,
      delivery: tool.kind === "file" && result === "success" ? tool.delivery : { kind: "unknown" },
      revision: { kind: "unknown" },
    };
    const base = { ...identity, toolRead } as const;
    const evidence: ResourceAccessEvidence = tool.kind === "file" && result !== "unknown"
      ? { ...base, access: "read", outcome: result, toolRead: { ...toolRead, kind: "structured-read" } }
      : tool.kind !== "file" && result === "success" ? { ...base, access: "inferred-read", outcome: "success", toolRead: { ...toolRead, kind: "literal-command" } }
      : { ...base, access: "attempt", outcome: "unknown" };
    resources.set(key, evidence);
  }
  return [...resources.values(), { kind: "tool-coverage", operationId, family, outcome, model: context.model,
    recognition: recognition.kind === "opaque" ? { kind: "opaque", reason: recognition.reason }
      : foreignExecution ? { kind: "opaque", reason: "unsupported-syntax" } : { kind: "recognized", resourceCount: resources.size } }];
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
  const target = evidence.kind === "resource-access" ? [evidence.resource.filesystemId, evidence.resource.canonicalPath, ...evidence.access === "execute" ? [evidence.access] : []]
    : evidence.kind === "tool-coverage" ? [] : [evidence.skill.canonicalPath];
  const receipt = createHash("sha256").update(JSON.stringify([host, scope.sessionId ?? scope.segmentId, operation, evidence.kind, ...target])).digest("hex");
  return { id: `native:tool:${receipt}`, producerId: `native:tool:${receipt}`, sequence: 0 };
}

function recognize(tool: ReadTool, env: Omit<Env, "trace">): Recognition {
  switch (tool.kind) {
    case "file": return validPath(tool.path) && isReadPortion(tool.requested) && isReadDelivery(tool.delivery)
      ? { kind: "recognized", targets: [{ path: tool.path, access: "read", requested: tool.requested, outcome: tool.outcome }] } : opaque("missing-input");
    case "shell": return tool.command.length > MAX_INPUT ? opaque("limit") : shellReads(tool.command, knownCwd(tool.cwd), env);
    case "python": return tool.code.length > MAX_INPUT ? opaque("limit")
      : interpret([{ connector: "start", command: { kind: "pipeline", stages: [{ assignments: [], words: [literal("python3"), literal("-c"), literal(tool.code)], redirects: [] }] } }], knownCwd(tool.cwd), env);
    case "opaque": return opaque(tool.reason ?? "unsupported-tool");
    default: { const exhaustive: never = tool; return exhaustive; }
  }
}

type WordPart = { kind: "literal" | "bare"; value: string } | { kind: "variable"; name: string; quoted: boolean } | { kind: "opaque"; assigns: boolean };
type Word = readonly WordPart[];
type Operator = "&&" | "||" | ";" | "\n" | "|" | "&" | ";;" | "(" | ")" | "((";
type RedirectOp = ">" | ">>" | "<" | ">&" | "&>" | "<<";
type Redirect<Target> = { fd: number | null; op: RedirectOp; target: Target };
type ShellToken = { kind: "word"; word: Word } | { kind: "operator"; value: Operator } | ({ kind: "redirect" } & Redirect<Word>);
type Assignment = { name: string; value: Word | null; subscript: boolean };
type Stage = { assignments: readonly Assignment[]; words: readonly Word[]; redirects: readonly Redirect<Word>[] };
type Command =
  | { kind: "pipeline"; stages: readonly Stage[] }
  | { kind: "for"; name: string; items: readonly Word[]; body: readonly ShellStep[] }
  | { kind: "block"; scope: "subshell" | "shell"; body: readonly ShellStep[] }
  | { kind: "arithmetic" }
  | { kind: "function"; name: string; body: readonly ShellStep[] };
type Connector = "start" | "and" | "or" | "seq";
type ShellStep = { connector: Connector; command: Command };
type SimpleCommand = { words: readonly string[]; redirects: readonly Redirect<string>[] };
type Cwd = { kind: "known"; path: string } | { kind: "unknown" };
type Scope = { cwd: Cwd; vars: ReadonlyMap<string, string>; functions: ReadonlySet<string> };
type Trace = { targets: Target[]; reason: OpaqueReason | null; opaque: boolean };
type Env = { home: string; outcome: ToolOutcome; glob: ShellGlob | null; budget: WorkBudget; trace: Trace };
type Effect = { cwd: boolean; vars: boolean; halts: boolean; jumps: boolean; wild: boolean };
type Field = { text: string; unmatched: boolean };
type Resolved = { kind: "empty" } | { kind: "opaque"; effect: Effect; sourced: string | null }
  | { kind: "command"; program: string; role: Role; args: readonly string[]; redirects: readonly Redirect<string>[]; unmatched: ReadonlySet<string> };
type ReaderRequest = { paths: readonly string[]; requested: ReadPortion };
const unknownCwd = { kind: "unknown" } as const;
const knownCwd = (path: string | null): Cwd => path === null ? unknownCwd : { kind: "known", path };
const literal = (value: string): Word => [{ kind: "literal", value }];

function shellReads(command: string, cwd: Cwd, env: Omit<Env, "trace">): Recognition {
  if (/[\u0000-\u0008\u000b-\u001f]/u.test(command)) return opaque("unsupported-syntax");
  const lexed = shellTokens(command, 0, env.home, null, 0);
  if (!lexed) return opaque("unsupported-syntax");
  const parsed = shellSteps(lexed.tokens);
  return parsed.kind === "opaque" ? parsed : interpret(parsed.steps, cwd, env);
}

const commandOpeners = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "time"]);
function shellTokens(source: string, start: number, home: string, close: ")" | null, level: number): { tokens: readonly ShellToken[]; end: number } | null {
  if (level > MAX_NESTING) return null;
  const tokens: ShellToken[] = [];
  const heredocs: { delimiter: string; strip: boolean }[] = [];
  let parts: WordPart[] = [];
  let started = false;
  let pending: (Omit<Redirect<Word>, "target"> & { body: "word" | "heredoc" | "strip" | "opaque" }) | null = null;
  let depth = 0;
  let test = false;
  let commandStart = true;
  const add = (kind: "literal" | "bare", value: string): void => {
    const last = parts.at(-1);
    if (last?.kind === kind) parts[parts.length - 1] = { kind, value: last.value + value };
    else parts.push({ kind, value });
    started = true;
  };
  const part = (value: WordPart): void => { parts.push(value); started = true; };
  const operator = (value: Operator): void => { tokens.push({ kind: "operator", value }); commandStart = value !== ")"; };
  const flush = (): boolean => {
    if (!started) return true;
    const word = parts;
    parts = []; started = false;
    if (pending) {
      const { body, ...redirect } = pending;
      pending = null;
      if (body === "heredoc" || body === "strip") {
        const delimiter = literalText(word);
        if (delimiter === null) return false;
        heredocs.push({ delimiter, strip: body === "strip" });
        tokens.push({ kind: "redirect", ...redirect, target: [] });
      } else tokens.push({ kind: "redirect", ...redirect, target: body === "opaque" ? [{ kind: "opaque", assigns: false }] : word });
      return true;
    }
    const text = bareText(word);
    tokens.push({ kind: "word", word });
    if (commandStart && text === "[[") test = true;
    else if (test && text === "]]") test = false;
    commandStart = text !== null && commandOpeners.has(text);
    return true;
  };
  const nested = (from: number): number | null => shellTokens(source, from, home, ")", level + 1)?.end ?? null;
  const closing = (from: number, quote: string, escapes = true): number | null => {
    for (let index = from + 1; index < source.length; index += 1) {
      if (escapes && source[index] === "\\") index += 1;
      else if (source[index] === quote) return index;
    }
    return null;
  };
  const parenEnd = (from: number): number | null => {
    let open = 0;
    for (let index = from; index < source.length; index += 1) {
      if (source[index] === "(") open += 1;
      else if (source[index] === ")" && --open === 0) return index;
    }
    return null;
  };
  const bracketEnd = (from: number): number | null => {
    let open = 0;
    for (let index = from; index < source.length; index += 1) {
      if (source[index] === "[") open += 1;
      else if (source[index] === "]" && --open === 0) return index;
    }
    return null;
  };
  const braceEnd = (from: number): number | null => {
    let open = 1;
    for (let index = from; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") open += 1;
      else if (character === "}" && --open === 0) return index;
      const end = character === "\\" ? index + 1 : character === "'" ? closing(index, "'", false)
        : character === '"' ? closing(index, '"') : character === "$" && source[index + 1] === "(" ? nested(index + 2) : index;
      if (end === null) return null;
      index = end;
    }
    return null;
  };
  const dollar = (at: number, quoted: boolean): number | null => {
    const next = source[at + 1];
    const variable = next === "{" ? /\{([A-Za-z_]\w*)\}/uy : /([A-Za-z_]\w*)/uy;
    variable.lastIndex = at + 1;
    const match = variable.exec(source);
    if (match) { part({ kind: "variable", name: match[1] ?? "", quoted }); return at + match[0].length; }
    if (next === undefined || !/[({[0-9?#@*$!'-]/u.test(next) || (next === "'" && quoted)) {
      if (next !== '"' || quoted) add(quoted ? "literal" : "bare", "$");
      return at;
    }
    const arithmetic = next === "[" || (next === "(" && source[at + 2] === "(");
    const end = next === "(" ? arithmetic ? parenEnd(at + 1) : nested(at + 2) : next === "[" ? bracketEnd(at + 1)
      : next === "{" ? braceEnd(at + 2) : next === "'" ? closing(at + 1, "'") : at + 1;
    if (end === null) return null;
    part({ kind: "opaque", assigns: arithmetic || (next === "{" && /=|\+\+|--|\[/u.test(source.slice(at, end))) });
    return end;
  };
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === undefined) break;
    if (character === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return null;
      add("literal", source.slice(index + 1, end)); index = end;
    } else if (character === '"') {
      add("literal", "");
      let cursor = index + 1;
      for (; ; cursor += 1) {
        const inner = source[cursor];
        const escaped = source[cursor + 1];
        if (inner === undefined) return null;
        if (inner === '"') break;
        if (inner === "\\") {
          if (escaped === undefined) return null;
          if (escaped === "\n") cursor += 1;
          else if (/[$`"\\]/u.test(escaped)) { add("literal", escaped); cursor += 1; }
          else add("literal", inner);
        } else if (inner === "$" || inner === "`") {
          const end = inner === "$" ? dollar(cursor, true) : closing(cursor, "`");
          if (end === null) return null;
          if (inner === "`") part({ kind: "opaque", assigns: false });
          cursor = end;
        } else add("literal", inner);
      }
      index = cursor;
    } else if (character === "$" || character === "`") {
      const end = character === "$" ? dollar(index, false) : closing(index, "`");
      if (end === null) return null;
      if (character === "`") part({ kind: "opaque", assigns: false });
      index = end;
    } else if (character === "\\") {
      if (next === undefined) return null;
      if (next !== "\n") add("literal", next);
      index += 1;
    } else if (character === " " || character === "\t") { if (!flush()) return null; }
    else if (character === "#" && !started) { while (source[index + 1] !== undefined && source[index + 1] !== "\n") index += 1; }
    else if (character === "~" && (!started || (parts.length === 1 && parts[0]?.kind === "bare" && /^[A-Za-z_]\w*=(?:.*:)?$/su.test(parts[0].value)))) {
      const user = /[\w.+-]*/uy;
      user.lastIndex = index + 1;
      const name = user.exec(source)?.[0] ?? "";
      if (name === "" && (next === undefined || /[\s/:;&|<>)]/u.test(next))) part({ kind: "variable", name: "HOME", quoted: true });
      else { part({ kind: "opaque", assigns: false }); index += name.length; }
    } else if (test && /[()&|<>]/u.test(character)) {
      if (!flush()) return null;
      const length = (character === "&" || character === "|") && next === character ? 2 : 1;
      add("bare", source.slice(index, index + length)); index += length - 1;
      if (!flush()) return null;
    } else if (character === "(") {
      const text = bareText(parts);
      if (started && text !== null && /^[A-Za-z_][\w.:-]*$/u.test(text) && /^\(\s*\)/u.test(source.slice(index, index + 64))) { if (!flush()) return null; operator("("); depth += 1; }
      else if (started) {
        const end = nested(index + 1);
        if (end === null) return null;
        part({ kind: "opaque", assigns: false }); index = end;
      } else if (next === "(") {
        const end = parenEnd(index);
        if (end === null) return null;
        operator("(("); index = end;
      } else { operator("("); depth += 1; }
    } else if (character === ")") {
      if (!flush()) return null;
      if (close && depth === 0) return pending === null && heredocs.length === 0 ? { tokens, end: index } : null;
      depth -= 1;
      operator(")");
    } else if (character === "<" || character === ">") {
      const text = bareText(parts);
      const fd: number | null = pending === null && text !== null && /^\d+$/u.test(text) ? Number(text) : null;
      if (fd === null) { if (!flush()) return null; }
      else { parts = []; started = false; }
      if (pending !== null) return null;
      if (next === "(") {
        const end = nested(index + 2);
        if (end === null) return null;
        part({ kind: "opaque", assigns: false }); index = end;
      } else if (character === "<") {
        const third = source[index + 2];
        if (next === "<") { pending = { fd, op: "<<", body: third === "<" ? "word" : third === "-" ? "strip" : "heredoc" }; index += third === "<" || third === "-" ? 2 : 1; }
        else if (next === "&" || next === ">") { pending = { fd, op: "<", body: "opaque" }; index += 1; }
        else pending = { fd, op: "<", body: "word" };
      } else if (next === ">" || next === "&" || next === "|") { pending = { fd, op: next === ">" ? ">>" : next === "&" ? ">&" : ">", body: "word" }; index += 1; }
      else pending = { fd, op: ">", body: "word" };
    } else if (character === "&" || character === "|" || character === ";" || character === "\n") {
      if (!flush() || pending !== null) return null;
      if (character === "&") {
        if (next === "&") { operator("&&"); index += 1; }
        else if (next === ">") { pending = { fd: null, op: "&>", body: "word" }; index += source[index + 2] === ">" ? 2 : 1; }
        else operator("&");
      } else if (character === "|") {
        if (next === "|") { operator("||"); index += 1; }
        else {
          if (next === "&") { tokens.push({ kind: "redirect", fd: 2, op: ">&", target: [{ kind: "bare", value: "1" }] }); index += 1; }
          operator("|");
        }
      } else if (character === ";") {
        if (next === ";" || next === "&") { operator(";;"); index += next === ";" && source[index + 2] === "&" ? 2 : 1; }
        else operator(";");
      } else {
        operator("\n");
        let cursor = index + 1;
        for (const { delimiter, strip } of heredocs.splice(0)) {
          for (; ;) {
            if (cursor > source.length) return null;
            const end = source.indexOf("\n", cursor);
            const line = source.slice(cursor, end < 0 ? source.length : end);
            cursor = end < 0 ? source.length + 1 : end + 1;
            if ((strip ? line.replace(/^\t+/u, "") : line) === delimiter) break;
          }
        }
        index = cursor - 1;
      }
    } else add("bare", character);
  }
  if (close !== null || !flush() || pending !== null || heredocs.length > 0) return null;
  return { tokens, end: index };
}

function literalText(word: Word): string | null {
  let text = "";
  for (const part of word) {
    if (part.kind !== "literal" && part.kind !== "bare") return null;
    text += part.value;
  }
  return text;
}

function bareText(word: Word): string | null {
  const [part, ...rest] = word;
  return part?.kind === "bare" && rest.length === 0 ? part.value : null;
}

function assignmentOf(word: Word): Assignment | null {
  const [first, ...rest] = word;
  const match = first?.kind === "bare" ? /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?)=/u.exec(first.value) : null;
  if (!match || first?.kind !== "bare") return null;
  const value = first.value.slice(match[0].length);
  return { name: match[1] ?? "", value: match[2] || match[3] ? null : value ? [{ kind: "bare", value }, ...rest] : rest, subscript: match[2] !== undefined };
}

const closers = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "}"]);
const protectedNames = new Set(["HOME", "CDPATH", "PWD", "OLDPWD", "GLOBIGNORE", "FIGNORE", "GLOBSORT", "BASH_ENV", "ENV", "POSIXLY_CORRECT", "SHELLOPTS", "BASHOPTS"]);
const connectors = { "&&": "and", "||": "or", ";": "seq", "\n": "seq", "&": "seq" } as const;
function shellSteps(tokens: readonly ShellToken[]): { kind: "steps"; steps: readonly ShellStep[] } | Opaque {
  let index = 0;
  let stages = 0;
  let nesting = 0;
  const peek = (offset = 0): ShellToken | undefined => tokens[index + offset];
  const isOperator = (value: Operator, token = peek()): boolean => token?.kind === "operator" && token.value === value;
  const keywordOf = (token = peek()): string | null => token?.kind === "word" ? bareText(token.word) : null;
  const isKeyword = (names: string | ReadonlySet<string>, token = peek()): boolean => {
    const text = keywordOf(token);
    return text !== null && (typeof names === "string" ? text === names : names.has(text));
  };
  const expect = (name: string): boolean => {
    if (!isKeyword(name)) return false;
    index += 1; return true;
  };
  const newlines = (): void => { while (isOperator("\n")) index += 1; };
  const until = (names: string | ReadonlySet<string>) => list(token => isKeyword(names, token));
  const unsafe = (assignment: Assignment, persistent: boolean): boolean => protectedNames.has(assignment.name) || (persistent && assignment.name === "IFS");
  function list(stop: (token: ShellToken) => boolean): ShellStep[] | null {
    const steps: ShellStep[] = [];
    let connector: Connector = "start";
    for (; ;) {
      newlines();
      const token = peek();
      if (token === undefined || stop(token)) return connector === "and" || connector === "or" ? null : steps;
      const command = pipeline();
      if (!command) return null;
      const after = peek();
      const background = after?.kind === "operator" && after.value === "&";
      steps.push({ connector, command: background ? { kind: "block", scope: "subshell", body: [{ connector: "start", command }] } : command });
      if (after?.kind === "operator" && (after.value === "&&" || after.value === "||" || after.value === ";" || after.value === "\n" || after.value === "&")) {
        connector = connectors[after.value]; index += 1;
      } else if (after === undefined || stop(after)) return steps;
      else return null;
    }
  }
  function pipeline(): Command | null {
    let wrapped = false;
    for (; isKeyword("!") || isKeyword("time"); wrapped = true) {
      index += 1;
      if (isKeyword("-p")) index += 1;
    }
    const units: Command[] = [];
    for (; ;) {
      const unit = command();
      if (!unit) return null;
      units.push(unit);
      if (!isOperator("|")) break;
      index += 1; newlines();
    }
    const stages: Stage[] = [];
    let joined: Command = { kind: "pipeline", stages };
    for (const unit of units) {
      if (unit.kind !== "pipeline") { joined = units.length === 1 ? unit : { kind: "block", scope: "subshell", body: units.map(command => ({ connector: "start", command })) }; break; }
      stages.push(...unit.stages);
    }
    return wrapped ? { kind: "block", scope: "shell", body: [{ connector: "start", command: joined }] } : joined;
  }
  function compound(command: Command): Command {
    let redirected = false;
    while (peek()?.kind === "redirect") { index += 1; redirected = true; }
    return command.kind === "for" && redirected ? { kind: "block", scope: "shell", body: command.body } : command;
  }
  function definition(name: string): Command | null {
    newlines();
    const body = command();
    return body && { kind: "function", name, body: [{ connector: "start", command: body }] };
  }
  function command(): Command | null {
    if (nesting >= MAX_NESTING) { stages = MAX_STAGES + 1; return null; }
    nesting += 1;
    const parsed = commandAt();
    nesting -= 1;
    return parsed;
  }
  function commandAt(): Command | null {
    if (isOperator("(")) {
      index += 1;
      const body = list(token => isOperator(")", token));
      if (!body || !isOperator(")")) return null;
      index += 1;
      return compound({ kind: "block", scope: "subshell", body });
    }
    if (isOperator("((")) { index += 1; return compound({ kind: "arithmetic" }); }
    const keyword = keywordOf();
    if (keyword === "{") {
      index += 1;
      const body = until("}");
      return body && expect("}") ? compound({ kind: "block", scope: "shell", body }) : null;
    }
    if (keyword === "if") {
      index += 1;
      const body: ShellStep[] = [];
      const branch = (stop: string | ReadonlySet<string>): boolean => { const steps = until(stop); if (steps) body.push(...steps); return steps !== null; };
      const rest = new Set(["elif", "else", "fi"]);
      if (!branch("then") || !expect("then") || !branch(rest)) return null;
      while (isKeyword("elif")) { index += 1; if (!branch("then") || !expect("then") || !branch(rest)) return null; }
      if (isKeyword("else")) { index += 1; if (!branch("fi")) return null; }
      return expect("fi") ? compound({ kind: "block", scope: "shell", body }) : null;
    }
    if (keyword === "while" || keyword === "until") {
      index += 1;
      const condition = until("do");
      if (!condition || !expect("do")) return null;
      const body = until("done");
      return body && expect("done") ? compound({ kind: "block", scope: "shell", body: [...condition, ...body] }) : null;
    }
    if (keyword === "for" || keyword === "select") {
      index += 1;
      const arithmetic = isOperator("((");
      const name = keywordOf();
      if (!arithmetic && (name === null || !/^[A-Za-z_]\w*$/u.test(name) || protectedNames.has(name) || name === "IFS")) return null;
      index += 1;
      let items: Word[] | null = null;
      if (!arithmetic) newlines();
      if (!arithmetic && isKeyword("in")) {
        index += 1; items = [];
        for (let token = peek(); token?.kind === "word"; token = peek()) { items.push(token.word); index += 1; }
      }
      if (isOperator(";") || isOperator("\n")) index += 1;
      newlines();
      if (!expect("do")) return null;
      const body = until("done");
      if (!body || !expect("done")) return null;
      return compound(keyword === "for" && name !== null && items !== null ? { kind: "for", name, items, body }
        : { kind: "block", scope: "shell", body: arithmetic ? [{ connector: "start", command: { kind: "arithmetic" } }, ...body] : body });
    }
    if (keyword === "case") {
      index += 1;
      if (peek()?.kind !== "word") return null;
      index += 1; newlines();
      if (!expect("in")) return null;
      const body: ShellStep[] = [];
      for (newlines(); !isKeyword("esac"); newlines()) {
        if (isOperator("(")) index += 1;
        while (peek()?.kind === "word" || isOperator("|")) index += 1;
        if (!isOperator(")")) return null;
        index += 1;
        const steps = list(token => isOperator(";;", token) || isKeyword("esac", token));
        if (!steps) return null;
        body.push(...steps);
        if (isOperator(";;")) index += 1;
      }
      index += 1;
      return compound({ kind: "block", scope: "shell", body });
    }
    if (keyword === "function") {
      index += 1;
      const name = keywordOf();
      if (name === null || !/^[A-Za-z_][\w.:-]*$/u.test(name)) return null;
      index += 1;
      if (isOperator("(")) { if (!isOperator(")", peek(1))) return null; index += 2; }
      return definition(name);
    }
    if (keyword !== null && closers.has(keyword)) return null;
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirects: Redirect<Word>[] = [];
    for (let token = peek(); token !== undefined && token.kind !== "operator"; token = peek()) {
      index += 1;
      if (token.kind === "redirect") { redirects.push({ fd: token.fd, op: token.op, target: token.target }); continue; }
      const assignment = words.length === 0 ? assignmentOf(token.word) : null;
      if (assignment) assignments.push(assignment);
      else words.push(token.word);
    }
    const [head, ...args] = words;
    if (head === undefined && assignments.length === 0 && redirects.length === 0) return null;
    stages += 1;
    if (stages > MAX_STAGES) return null;
    if (head !== undefined && args.length === 0 && assignments.length === 0 && redirects.length === 0 && isOperator("(") && isOperator(")", peek(1))) {
      const name = bareText(head);
      if (name === null) return null;
      index += 2;
      return definition(name);
    }
    const program = head === undefined ? null : literalText(head);
    const exported = program === "export" ? args.flatMap(word => assignmentOf(word) ?? []) : [];
    if (assignments.some(assignment => unsafe(assignment, head === undefined))
      || exported.some(assignment => unsafe(assignment, true))) return null;
    return { kind: "pipeline", stages: [{ assignments, words, redirects }] };
  }
  const steps = list(() => false);
  if (stages > MAX_STAGES) return opaque("limit");
  return steps === null || steps.length === 0 || index !== tokens.length ? opaque("unsupported-syntax") : { kind: "steps", steps };
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

type Launch = { via: readonly string[]; options: RegExp | null; operand: "any" | "file" };
const shellLaunch: readonly Launch[] = [{ via: [], options: /^-[euxv]+$/u, operand: "any" }];
const pythonLaunch: readonly Launch[] = [{ via: [], options: /^-[IuBEsSO]+$/u, operand: "any" }];
const plainLaunch: readonly Launch[] = [{ via: [], options: null, operand: "any" }];
const fileLaunch: readonly Launch[] = [{ via: [], options: null, operand: "file" }];
const launches: Readonly<Record<string, readonly Launch[]>> = {
  bash: shellLaunch, sh: shellLaunch, zsh: shellLaunch, dash: shellLaunch, python: pythonLaunch, python3: pythonLaunch,
  node: fileLaunch, tsx: fileLaunch, ruby: plainLaunch, perl: plainLaunch,
  bun: [{ via: ["run"], options: null, operand: "file" }, { via: [], options: null, operand: "file" }],
  deno: [{ via: ["run"], options: null, operand: "file" }], npx: [{ via: ["tsx"], options: null, operand: "file" }], uv: [{ via: ["run"], options: null, operand: "file" }],
};

function scriptOf(program: string, args: readonly string[]): string | null {
  if (program.includes("/")) return program;
  const launch = (Object.hasOwn(launches, program) ? launches[program] : undefined)?.find(item => item.via.every((word, index) => args[index] === word));
  if (!launch) return null;
  const rest = args.slice(launch.via.length);
  const index = rest.findIndex(arg => arg === "--" || !/^[-+]/u.test(arg) || !launch.options?.test(arg));
  const operand = rest[index] === "--" ? rest[index + 1] : rest[index];
  return operand !== undefined && validPath(operand) && !/^[-+]/u.test(operand) && !/^[A-Za-z][\w+.-]*:/u.test(operand)
    && (launch.operand === "any" || /\/|\.(?:[cm]?[jt]s|[jt]sx|py)$/u.test(operand)) ? operand : null;
}

function sourceOperand(fields: readonly Field[]): string | null {
  const [first, second] = fields;
  const operand = first?.text === "--" ? second : first;
  return operand !== undefined && !operand.unmatched && operand.text.includes("/") && !operand.text.startsWith("-") ? operand.text : null;
}

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
  const filter = Object.hasOwn(filters, program) ? filters[program] : undefined;
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
    if (redirect.op === "<" || redirect.op === "<<") continue;
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
    if (index > stage && (program === undefined || !stdinFilter(program, args) || command.redirects.some(redirect => (redirect.op === "<" || redirect.op === "<<") && (redirect.fd ?? 0) === 0))) return false;
    const destination = stdoutDestination(command, index === pipeline.length - 1 ? "stdout" : "pipe");
    if (destination !== "pipe") return destination !== "other";
  }
  return false;
}

function isExit(step: ShellStep): boolean {
  const [stage, ...rest] = step.command.kind === "pipeline" ? step.command.stages : [];
  const [name, ...args] = stage?.words.map(literalText) ?? [];
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

const calm: Effect = { cwd: false, vars: false, halts: false, jumps: false, wild: false };
const chaos: Effect = { cwd: true, vars: true, halts: true, jumps: true, wild: true };
const builtins = new Set([".", ":", "[", "[[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "compopt", "continue", "coproc",
  "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
  "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test",
  "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait"]);
const modelled: Readonly<Record<string, Partial<Effect>>> = {
  cd: { cwd: true }, pushd: { cwd: true }, popd: { cwd: true }, export: { vars: true }, exit: { halts: true }, return: { halts: true },
  break: { jumps: true }, continue: { jumps: true }, echo: {}, printf: {}, true: {}, false: {}, ":": {}, test: {}, "[": {}, "[[": {}, pwd: {}, ls: {},
};
type Role = { kind: "modelled"; effect: Effect } | { kind: "unsafe" } | { kind: "external" };
function roleOf(program: string, args: readonly string[], functions: ReadonlySet<string>): Role {
  const effect = Object.hasOwn(modelled, program) ? modelled[program] : undefined;
  if (functions.has(program) || (program === "printf" && /^-v/u.test(args[0] ?? "")) || (effect === undefined && builtins.has(program))) return { kind: "unsafe" };
  if (effect === undefined) return { kind: "external" };
  return { kind: "modelled", effect: merge(calm, { ...effect, ...(program === "[[" && args.some(arg => /^-(?:eq|ne|lt|le|gt|ge)$/u.test(arg)) ? { vars: true } : {}) }) };
}
const effectOf = (role: Role): Effect => role.kind === "unsafe" ? chaos : role.kind === "modelled" ? role.effect : calm;
const interpreters = new Set(["python", "python3", "node", "bash", "sh", "zsh", "dash", "ruby", "perl", "php", "deno", "bun"]);
const merge = (effect: Effect, extra: Partial<Effect>): Effect => ({ cwd: effect.cwd || extra.cwd === true, vars: effect.vars || extra.vars === true,
  halts: effect.halts || extra.halts === true, jumps: effect.jumps || extra.jumps === true, wild: effect.wild || extra.wild === true });
const affect = (scope: Scope, effect: Effect): Scope => ({ ...scope, cwd: effect.cwd ? unknownCwd : scope.cwd, vars: effect.vars ? new Map() : scope.vars });
const assigns = (stage: Stage): boolean => stage.assignments.some(assignment => assignment.subscript)
  || [...stage.words, ...stage.assignments.map(assignment => assignment.value ?? []), ...stage.redirects.map(redirect => redirect.target)]
    .some(word => word.some(part => part.kind === "opaque" && part.assigns));
const obscure = (trace: Trace): void => { trace.opaque = true; trace.reason ??= "unsupported-syntax"; };
const spend = (budget: WorkBudget, units: number): boolean => (budget.remaining -= units) >= 0;

function walk(steps: readonly ShellStep[], functions: ReadonlySet<string>, budget: WorkBudget): { effect: Effect; functions: ReadonlySet<string> } {
  let effect = calm;
  let known = functions;
  for (const { command } of steps) {
    if (!spend(budget, STEP_COST)) return { effect: chaos, functions: known };
    switch (command.kind) {
      case "pipeline": {
        const [stage, ...rest] = command.stages;
        if (!stage || rest.length > 0) break;
        const [head, ...args] = stage.words;
        const program = head === undefined ? null : literalText(head);
        effect = merge(effect, head === undefined ? { vars: true } : program === null ? chaos
          : merge(effectOf(roleOf(program, args.map(word => literalText(word) ?? ""), known)), { vars: assigns(stage) }));
        break;
      }
      case "for": case "block": {
        if (command.kind === "block" && command.scope === "subshell") break;
        const inner = walk(command.body, known, budget);
        known = inner.functions;
        effect = merge(effect, command.kind === "for" ? { ...inner.effect, vars: true, jumps: false } : inner.effect);
        break;
      }
      case "arithmetic": effect = merge(effect, { vars: true }); break;
      case "function": spend(budget, known.size); known = new Set([...known, command.name]); effect = merge(effect, { cwd: true }); break;
      default: { const exhaustive: never = command; return exhaustive; }
    }
  }
  return { effect, functions: known };
}

function expand(word: Word, scope: Scope, env: Env, mode: "files" | "fixed" | "inert"): readonly Field[] | null {
  let text = "";
  let pattern = "";
  let bare = "";
  for (const part of word) {
    switch (part.kind) {
      case "literal": text += part.value; pattern += part.value.replace(/[*?[\]\\]/gu, "\\$&"); break;
      case "bare": text += part.value; pattern += part.value; bare += part.value; break;
      case "variable": {
        const value = part.name === "HOME" ? env.home : scope.vars.get(part.name);
        if (value === undefined || (!part.quoted && mode !== "inert" && part.name !== "HOME" && (value === "" ? word.length === 1 : /[\s*?[\]]/u.test(value)))) return null;
        text += value; pattern += value.replace(/[*?[\]\\]/gu, "\\$&"); break;
      }
      case "opaque": return null;
      default: { const exhaustive: never = part; return exhaustive; }
    }
  }
  if (mode === "inert") return [{ text, unmatched: false }];
  if (/[{}]/u.test(bare) && text !== "{}") return null;
  if (!/[*?]/u.test(bare) && !(bare.includes("[") && text.includes("]"))) return [{ text, unmatched: false }];
  const base = text.startsWith("/") ? "/" : scope.cwd.kind === "known" ? scope.cwd.path : null;
  if (mode === "fixed" || env.glob === null || base === null || bare.includes("**")) return null;
  const matches = env.glob(pattern, base, env.budget);
  return matches === null || env.budget.remaining < 0 ? null
    : matches.length === 0 ? [{ text, unmatched: true }] : matches.map(match => ({ text: match, unmatched: false }));
}

function resolveStage(stage: Stage, scope: Scope, env: Env): Resolved {
  const [head, ...rest] = stage.words;
  const values = stage.assignments.every(assignment => assignment.value === null || expand(assignment.value, scope, env, "inert") !== null);
  if (head === undefined) return values && !stage.redirects.some(redirect => redirect.target.some(part => part.kind === "opaque")) ? { kind: "empty" } : { kind: "opaque", effect: merge(calm, { vars: assigns(stage) }), sourced: null };
  const [command, ...extra] = expand(head, scope, env, "fixed") ?? [];
  if (command === undefined || extra.length > 0) return { kind: "opaque", effect: chaos, sourced: null };
  const program = command.text;
  const mode = program === "cd" || program === "pushd" ? "fixed" : program === "[[" ? "inert" : "files";
  const fields: Field[] = [];
  let resolved = values;
  for (const word of rest) {
    const expanded = expand(word, scope, env, mode);
    if (expanded === null) resolved = false;
    else fields.push(...expanded);
  }
  const redirects: Redirect<string>[] = [];
  for (const { fd, op, target } of stage.redirects) {
    const [field, ...more] = expand(target, scope, env, op === "<<" ? "inert" : "fixed") ?? [];
    if (field === undefined || more.length > 0) resolved = false;
    else redirects.push({ fd, op, target: field.text });
  }
  const args = fields.map(field => field.text);
  const role = roleOf(program, args, scope.functions);
  const effect = merge(effectOf(role), { vars: assigns(stage) });
  const scripted = interpreters.has(program) && redirects.findLast(redirect => (redirect.op === "<" || redirect.op === "<<") && (redirect.fd ?? 0) === 0)?.op === "<<";
  const sourced = resolved && role.kind === "unsafe" && (program === "source" || program === ".") && !scope.functions.has(program) ? sourceOperand(fields) : null;
  return !resolved || role.kind === "unsafe" || scripted ? { kind: "opaque", effect, sourced }
    : { kind: "command", program, role, args, redirects, unmatched: new Set(fields.filter(field => field.unmatched).map(field => field.text)) };
}

function assign(scope: Scope, assignments: readonly Assignment[], connector: Connector, env: Env): Scope {
  let current = scope;
  for (const { name, value, subscript } of assignments) {
    spend(env.budget, current.vars.size + 1);
    if (subscript) { current = { ...current, vars: new Map() }; continue; }
    const [field] = value !== null && connector !== "or" ? expand(value, current, env, "inert") ?? [] : [];
    const vars = new Map(current.vars);
    if (field === undefined) vars.delete(name);
    else vars.set(name, field.text);
    current = { ...current, vars };
  }
  return current;
}

type Outcome = { scope: Scope; effect: Effect };
function block(body: readonly ShellStep[], scope: Scope, env: Env, extra: Partial<Effect>): Outcome {
  obscure(env.trace);
  const walked = walk(body, scope.functions, env.budget);
  const effect = merge(walked.effect, extra);
  return { scope: { ...affect(scope, effect), functions: walked.functions }, effect };
}

function loop(command: Extract<Command, { kind: "for" }>, scope: Scope, env: Env): Outcome {
  const items: string[] = [];
  for (const word of command.items) {
    const fields = expand(word, scope, env, "files");
    if (fields === null || fields.some(field => field.unmatched)) return block(command.body, scope, env, { vars: true });
    items.push(...fields.map(field => field.text));
  }
  const { effect } = walk(command.body, scope.functions, env.budget);
  if (items.length > MAX_TARGETS || effect.cwd || effect.jumps) return block(command.body, scope, env, { vars: true });
  let current = scope;
  for (const item of items) {
    if (!spend(env.budget, STEP_COST + current.vars.size)) return { scope: current, effect: chaos };
    const iteration = run(command.body, { ...current, cwd: scope.cwd, vars: new Map([...current.vars, [command.name, item]]) }, env, false);
    current = iteration.scope;
    if (!iteration.alive) return { scope: current, effect: merge(calm, { halts: true }) };
  }
  return { scope: { ...current, cwd: scope.cwd }, effect: calm };
}

function interpret(steps: readonly ShellStep[], cwd: Cwd, context: Omit<Env, "trace">): Recognition {
  const trace: Trace = { targets: [], reason: null, opaque: false };
  run(steps, { cwd, vars: new Map(), functions: new Set() }, { ...context, trace }, steps.every(step => step.connector === "start" || step.connector === "and"));
  const targets = trace.opaque ? trace.targets.map(target => ({ ...target, outcome: unreported })) : trace.targets;
  if (context.budget.remaining < 0 || targets.length > MAX_TARGETS) return opaque("limit");
  return trace.reason === null ? { kind: "recognized", targets } : { kind: "opaque", reason: trace.reason, targets };
}

function run(steps: readonly ShellStep[], initial: Scope, env: Env, settled: boolean): { scope: Scope; alive: boolean } {
  let scope = initial;
  let reach = { ok: true, fail: false };
  const confirmed = { or: false, seq: false };
  let unconfirmed = confirmed;
  const unbound: { or: ReadonlySet<string>; seq: ReadonlySet<string> } = { or: new Set(), seq: new Set() };
  let conditional = unbound;
  for (const [index, { connector, command }] of steps.entries()) {
    if (!spend(env.budget, STEP_COST)) return { scope: forget(scope, conditional.seq), alive: false };
    if (!(connector === "and" ? reach.ok : connector === "or" ? reach.fail : reach.ok || reach.fail)) { env.trace.reason ??= "unsupported-syntax"; continue; }
    const broken = connector === "or" ? unconfirmed.or : connector === "seq" && unconfirmed.seq;
    if (broken) scope = { ...scope, cwd: unknownCwd };
    if (broken || connector === "seq") unconfirmed = confirmed;
    const forgotten = connector === "or" ? conditional.or : connector === "seq" ? conditional.seq : unbound.or;
    scope = forget(scope, forgotten);
    if (forgotten.size > 0 || connector === "seq") conditional = unbound;
    const track = (from: Scope, names: readonly string[]): Scope => {
      if (connector === "or") return forget(from, new Set(names));
      conditional = { or: new Set([...conditional.or, ...names]), seq: connector === "and" ? new Set([...conditional.seq, ...names]) : conditional.seq };
      return from;
    };
    const bind = (from: Scope, assignments: readonly Assignment[]): Scope => track(assign(from, assignments, connector, env), assignments.map(assignment => assignment.name));
    let effect = calm;
    switch (command.kind) {
      case "pipeline": {
        const single = command.stages.length === 1 ? command.stages[0] : undefined;
        if (single && single.words.length === 0 && single.assignments.length > 0) {
          if (resolveStage(single, scope, env).kind === "opaque") obscure(env.trace);
          scope = bind(assigns(single) ? affect(scope, merge(calm, { vars: true })) : scope, single.assignments);
          break;
        }
        const resolved = command.stages.map(stage => resolveStage(stage, scope, env));
        const aim = (path: string, use: Use): void => {
          const target = validPath(path) && !path.split("/").includes("..") ? place(path, scope.cwd) : null;
          if (target === null) env.trace.reason ??= validPath(path) ? "missing-input" : "unsupported-syntax";
          else env.trace.targets.push({ path: target, outcome: settled && single ? env.outcome : unreported, ...use });
        };
        const blocked = resolved.find(item => item.kind === "opaque");
        if (blocked?.kind === "opaque") {
          for (const item of resolved) if (item.kind === "opaque" && item.sourced !== null) aim(item.sourced, { access: "execute" });
          obscure(env.trace);
          if (single) { scope = affect(scope, blocked.effect); effect = blocked.effect; }
          break;
        }
        const commands: SimpleCommand[] = resolved.map(item => item.kind === "command" ? { words: [item.program, ...item.args], redirects: item.redirects } : { words: [], redirects: [] });
        for (const [stage, item] of resolved.entries()) {
          if (item.kind !== "command") continue;
          const { program, args } = item;
          if (single && program === "cd") {
            if (connector === "or") { scope = { ...scope, cwd: unknownCwd }; continue; }
            const fallback = steps[index + 1];
            const guarded = fallback?.connector === "or" && isExit(fallback);
            scope = { ...scope, cwd: changeDirectory(scope.cwd, args, env.home) };
            unconfirmed = { or: unconfirmed.or || !guarded, seq: unconfirmed.seq || connector === "and" };
            continue;
          }
          if (single) {
            effect = effectOf(item.role);
            scope = program === "export" ? bind(scope, args.flatMap(arg => assignmentOf([{ kind: "bare", value: arg }]) ?? [])) : affect(scope, effect);
          }
          if (item.role.kind === "modelled") continue;
          const request = Object.hasOwn(readers, program) ? readers[program]?.(args) ?? null : null;
          const script = request === null ? scriptOf(program, args) : null;
          if (script !== null) {
            if (!item.unmatched.has(script)) aim(script, { access: "execute" });
            continue;
          }
          const input = item.redirects.findLast(redirect => (redirect.op === "<" || redirect.op === "<<") && (redirect.fd ?? 0) === 0);
          if (request && request.paths.length === 0 && input?.op === "<<") continue;
          if (request && (request.paths.length > 0 || input)) {
            if (!reachesTerminal(commands, stage)) continue;
            for (const path of request.paths.length > 0 ? request.paths : [input?.target ?? ""]) {
              if (!item.unmatched.has(path)) aim(path, { access: "read", requested: request.requested });
            }
          } else if (input || stage === 0 || (request === null && !stdinFilter(program, args))) env.trace.reason ??= "unsupported-syntax";
        }
        break;
      }
      case "for": {
        const before = scope.vars;
        ({ scope, effect } = loop(command, scope, env));
        scope = track(scope, [...scope.vars].flatMap(([name, value]) => before.get(name) === value ? [] : [name]));
        break;
      }
      case "block": if (command.scope === "subshell") obscure(env.trace); else ({ scope, effect } = block(command.body, scope, env, {})); break;
      case "arithmetic": obscure(env.trace); scope = affect(scope, merge(calm, { vars: true })); break;
      case "function":
        obscure(env.trace);
        spend(env.budget, scope.functions.size);
        scope = { ...scope, cwd: unknownCwd, functions: new Set([...scope.functions, command.name]) };
        break;
      default: { const exhaustive: never = command; return exhaustive; }
    }
    const skipped = { ok: connector === "or" && reach.ok, fail: connector === "and" && reach.fail };
    reach = effect.wild ? { ok: false, fail: false } : effect.halts ? skipped : { ok: true, fail: true };
  }
  return { scope: forget(scope, conditional.seq), alive: reach.ok || reach.fail };
}
function forget(scope: Scope, names: ReadonlySet<string>): Scope {
  return names.size === 0 ? scope : { ...scope, vars: new Map([...scope.vars].filter(([name]) => !names.has(name))) };
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
