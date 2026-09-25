import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { SkillRef } from "../domain.js";

export type SkillCatalog = {
  byPath: ReadonlyMap<string, SkillRef>;
  skills: readonly SkillRef[];
};

export function buildSkillCatalog(commands: readonly SlashCommandInfo[]): SkillCatalog {
  const byPath = new Map<string, SkillRef>();

  for (const command of commands) {
    if (command.source !== "skill") {
      continue;
    }

    const canonicalPath = canonicalizePath(command.sourceInfo.path);
    const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
    const skill: SkillRef = {
      name,
      canonicalPath,
      version: null,
    };
    byPath.set(canonicalPath, skill);
  }

  return { byPath, skills: [...byPath.values()].sort(compareSkillRef) };
}

export function commandIntentSkillName(input: string): string | null {
  const match = input.match(/^\/skill:([^ ]+)(?: |$)/);
  return match?.[1] ?? null;
}

export function skillWrappersFromPrompt(prompt: string, cwd = process.cwd()): readonly SkillRef[] {
  const skills: SkillRef[] = [];
  const wrapperPattern = /<skill\s+name="([^"]+)"\s+location="([^"]+)"\s*>/g;
  for (const match of prompt.matchAll(wrapperPattern)) {
    const name = match[1];
    const location = match[2];
    if (!name || !location) {
      continue;
    }
    const canonicalPath = canonicalizePath(location, cwd);
    skills.push({ name, canonicalPath, version: null });
  }
  return skills;
}

export function skillFromReadPath(inputPath: string, cwd: string, catalog: SkillCatalog): SkillRef | null {
  const canonicalPath = canonicalizePath(inputPath, cwd);
  const cataloged = catalog.byPath.get(canonicalPath);
  if (cataloged) {
    return { ...cataloged, version: null };
  }

  if (basename(canonicalPath) !== "SKILL.md") {
    return null;
  }

  return {
    name: basename(dirname(canonicalPath)),
    canonicalPath,
    version: null,
  };
}

function canonicalizePath(path: string, cwd = process.cwd()): string {
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  const absolute = resolve(cwd, normalized);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function compareSkillRef(left: SkillRef, right: SkillRef): number {
  return left.name.localeCompare(right.name) || left.canonicalPath.localeCompare(right.canonicalPath);
}
