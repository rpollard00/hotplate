import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
      version: hashFile(canonicalPath),
    };
    byPath.set(canonicalPath, skill);
  }

  return { byPath, skills: [...byPath.values()].sort(compareSkillRef) };
}

export function commandIntentSkillName(input: string): string | null {
  const match = input.match(/^\s*\/skill:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s|$)/i);
  return match?.[1] ?? null;
}

export function skillWrappersFromPrompt(prompt: string, catalog: SkillCatalog): readonly SkillRef[] {
  const skills: SkillRef[] = [];
  const wrapperPattern = /<skill\s+name="([^"]+)"\s+location="([^"]+)"\s*>/g;
  for (const match of prompt.matchAll(wrapperPattern)) {
    const name = match[1];
    const location = match[2];
    if (!name || !location) {
      continue;
    }
    const canonicalPath = canonicalizePath(location);
    skills.push(catalog.byPath.get(canonicalPath) ?? { name, canonicalPath, version: hashFile(canonicalPath) });
  }
  return skills;
}

export function skillFromReadPath(inputPath: string, cwd: string, catalog: SkillCatalog): SkillRef | null {
  const canonicalPath = canonicalizePath(resolve(cwd, inputPath));
  const cataloged = catalog.byPath.get(canonicalPath);
  if (cataloged) {
    return cataloged;
  }

  if (basename(canonicalPath) !== "SKILL.md") {
    return null;
  }

  return {
    name: basename(dirname(canonicalPath)),
    canonicalPath,
    version: existsSync(canonicalPath) ? hashFile(canonicalPath) : null,
  };
}

function canonicalizePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function hashFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return null;
  }
}

function compareSkillRef(left: SkillRef, right: SkillRef): number {
  return left.name.localeCompare(right.name) || left.canonicalPath.localeCompare(right.canonicalPath);
}
