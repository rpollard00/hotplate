import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { SkillRef } from "../domain.js";
import type { ResourceLocation } from "../resource-domain.js";
import { qualifyResource, type ResourceAdvertisement, type ResourceRoot } from "../resource-paths.js";

export type SkillCatalog = {
  byPath: ReadonlyMap<string, SkillRef>;
  skills: readonly SkillRef[];
};

export function skillCatalogAdvertisements(commands: readonly SlashCommandInfo[], cwd: string, sessionId: string | null): readonly ResourceAdvertisement[] {
  return commands.flatMap((command) => {
    if (command.source !== "skill") return [];
    const path = normalizePath(command.sourceInfo.path, cwd);
    return path ? [{ kind: "package", path: basename(path) === "SKILL.md" ? dirname(path) : path, host: "pi", sessionId } satisfies ResourceAdvertisement] : [];
  });
}

export function buildSkillCatalog(commands: readonly SlashCommandInfo[], cwd: string, roots: readonly ResourceRoot[]): SkillCatalog {
  const byPath = new Map<string, SkillRef>();

  for (const command of commands) {
    if (command.source !== "skill") {
      continue;
    }

    const resource = resourceFromReadPath(command.sourceInfo.path, cwd, roots);
    if (!resource) continue;
    const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
    const skill: SkillRef = {
      name,
      canonicalPath: resource.canonicalPath,
      version: null,
    };
    byPath.set(resource.canonicalPath, skill);
  }

  return { byPath, skills: [...byPath.values()].sort(compareSkillRef) };
}

export function commandIntentSkillName(input: string): string | null {
  const match = input.match(/^\/skill:([^ ]+)(?: |$)/);
  return match?.[1] ?? null;
}

export function skillWrappersFromPrompt(prompt: string, cwd: string, roots: readonly ResourceRoot[]): readonly SkillRef[] {
  const skills: SkillRef[] = [];
  const wrapperPattern = /<skill\s+name="([^"]+)"\s+location="([^"]+)"\s*>/g;
  for (const match of prompt.matchAll(wrapperPattern)) {
    const name = match[1];
    const location = match[2];
    if (!name || !location) {
      continue;
    }
    const resource = resourceFromReadPath(location, cwd, roots);
    if (resource) skills.push({ name, canonicalPath: resource.canonicalPath, version: null });
  }
  return skills;
}

export function skillFromReadPath(inputPath: string, cwd: string, catalog: SkillCatalog, roots: readonly ResourceRoot[]): SkillRef | null {
  return skillFromResource(resourceFromReadPath(inputPath, cwd, roots), catalog);
}

export function skillFromResource(resource: ResourceLocation | null, catalog: SkillCatalog): SkillRef | null {
  if (!resource) return null;
  const cataloged = catalog.byPath.get(resource.canonicalPath);
  if (cataloged) {
    return { ...cataloged, version: null };
  }

  if (basename(resource.observedPath) !== "SKILL.md") {
    return null;
  }

  return {
    name: basename(dirname(resource.canonicalPath)),
    canonicalPath: resource.canonicalPath,
    version: null,
  };
}

export function resourceFromReadPath(inputPath: string, cwd: string, roots: readonly ResourceRoot[]): ResourceLocation | null {
  const path = normalizePath(inputPath, cwd);
  return path ? qualifyResource({ path, cwd, roots }) : null;
}

function normalizePath(path: string, cwd: string): string | null {
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  try {
    if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
    return resolve(cwd, normalized);
  } catch {
    return null;
  }
}

function compareSkillRef(left: SkillRef, right: SkillRef): number {
  return left.name.localeCompare(right.name) || left.canonicalPath.localeCompare(right.canonicalPath);
}
