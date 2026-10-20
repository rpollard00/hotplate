import { lstatSync, opendirSync } from "node:fs";
import type { WorkBudget } from "./tool-reads.js";

const MAX_ENTRIES = 10_000;
const MAX_MATCHES = 128;
const ENTRY_COST = 100;

type Range = readonly [number, number];
type Token = { kind: "star" } | { kind: "any" } | { kind: "char"; code: number } | { kind: "class"; negated: boolean; ranges: readonly Range[] };
type SegmentMatcher = { kind: "literal"; name: string } | { kind: "pattern"; tokens: readonly Token[]; dot: boolean };

export function shellGlob(pattern: string, cwd: string, budget: WorkBudget): readonly string[] | null {
  if (pattern.endsWith("/")) return null;
  const matchers: SegmentMatcher[] = [];
  for (const segment of pattern.split("/").filter(segment => segment.length > 0)) {
    const matcher = segmentMatcher(segment);
    if (matcher === null) return null;
    matchers.push(matcher);
  }
  if (!matchers.some(matcher => matcher.kind === "pattern")) return null;
  let paths = [pattern.startsWith("/") ? "" : cwd.replace(/\/+$/u, "")];
  let scanned = 0;
  for (const matcher of matchers) {
    const next: string[] = [];
    for (const base of paths) {
      if (matcher.kind === "literal") { next.push(`${base}/${matcher.name}`); continue; }
      let directory;
      try { directory = opendirSync(base || "/"); } catch { continue; }
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          scanned += 1; budget.remaining -= ENTRY_COST;
          if (scanned > MAX_ENTRIES || budget.remaining < 0) return null;
          if ((!entry.name.startsWith(".") || matcher.dot) && matches(matcher.tokens, entry.name, budget)) next.push(`${base}/${entry.name}`);
          if (budget.remaining < 0) return null;
        }
      } catch { continue; } finally { directory.closeSync(); }
    }
    if (next.length > MAX_ENTRIES) return null;
    paths = next;
  }
  const found: string[] = [];
  for (const path of paths) {
    budget.remaining -= ENTRY_COST;
    if (budget.remaining < 0) return null;
    try { lstatSync(path); found.push(path); } catch { continue; }
  }
  return found.length > MAX_MATCHES ? null : found.sort();
}

function matches(tokens: readonly Token[], name: string, budget: WorkBudget): boolean {
  const codes = Array.from(name, character => character.codePointAt(0) ?? 0);
  let token = 0;
  let code = 0;
  let star = -1;
  let resume = 0;
  while (code < codes.length) {
    budget.remaining -= 1;
    const current = tokens[token];
    if (current?.kind === "star") { star = token; resume = code; token += 1; }
    else if (current !== undefined && accepts(current, codes[code] ?? 0)) { token += 1; code += 1; }
    else if (star >= 0) { token = star + 1; resume += 1; code = resume; }
    else return false;
  }
  while (tokens[token]?.kind === "star") token += 1;
  return token === tokens.length;
}

function accepts(token: Exclude<Token, { kind: "star" }>, code: number): boolean {
  switch (token.kind) {
    case "any": return true;
    case "char": return token.code === code;
    case "class": return token.ranges.some(([low, high]) => code >= low && code <= high) !== token.negated;
    default: { const exhaustive: never = token; return exhaustive; }
  }
}

function segmentMatcher(segment: string): SegmentMatcher | null {
  const characters = Array.from(segment);
  const tokens: Token[] = [];
  let name = "";
  let special = false;
  const literal = (character: string): void => { name += character; tokens.push({ kind: "char", code: character.codePointAt(0) ?? 0 }); };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\\") { literal(characters[index + 1] ?? "\\"); index += 1; }
    else if (character === "*") { special = true; if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" }); }
    else if (character === "?") { special = true; tokens.push({ kind: "any" }); }
    else if (character === "[") {
      const bracket = bracketExpression(characters, index);
      if (bracket === "unsupported") return null;
      if (bracket === null) { literal(character); continue; }
      special = true; tokens.push(bracket.token); index = bracket.end;
    } else literal(character);
  }
  return special ? { kind: "pattern", tokens, dot: segment.startsWith(".") || segment.startsWith("\\.") } : { kind: "literal", name };
}

function bracketExpression(characters: readonly string[], start: number): { token: Token; end: number } | null | "unsupported" {
  let index = start + 1;
  const negated = characters[index] === "!" || characters[index] === "^";
  if (negated) index += 1;
  const ranges: Range[] = [];
  for (let first = true; index < characters.length; index += 1, first = false) {
    const character = characters[index] ?? "";
    if (character === "]" && !first) return { token: { kind: "class", negated, ranges }, end: index };
    if (character === "[" && characters[index + 1] === ":") return "unsupported";
    const low = (character === "\\" ? characters[++index] ?? "\\" : character).codePointAt(0) ?? 0;
    const upper = characters[index + 2];
    if (characters[index + 1] === "-" && upper !== undefined && upper !== "]") {
      const high = upper.codePointAt(0) ?? 0;
      if (low > high) return "unsupported";
      ranges.push([low, high]); index += 2;
    } else ranges.push([low, low]);
  }
  return null;
}
