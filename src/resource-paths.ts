import { randomUUID } from "node:crypto";
import { mkdirSync, opendirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { InventoryOrigin, InventoryScope, ResourceLocation } from "./resource-domain.js";
import { readRegisteredRoots } from "./resource-root-registry.js";

export type ResourceRoot = {
  path: string;
  canonicalPath: string;
  filesystemId: string;
  origin: InventoryOrigin;
  scope: InventoryScope;
};

export function readResourceConfiguration(env: NodeJS.ProcessEnv = process.env): { path: string; roots: readonly string[] } {
  const path = resourceConfigurationPath(env);
  try {
    if (statSync(path).size > 65536) throw new Error();
    return { path, roots: parseConfiguredRoots(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if (env.HOTPLATE_RESOURCES_CONFIG === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { path, roots: [] };
    }
    throw new Error("Invalid Hotplate resource configuration.");
  }
}

export function saveResourceRoots(roots: readonly string[], env: NodeJS.ProcessEnv = process.env): { path: string; roots: readonly string[] } {
  const path = resourceConfigurationPath(env);
  const normalized = parseConfiguredRoots({ version: 1, roots });
  const body = `${JSON.stringify({ version: 1, roots: normalized }, null, 2)}\n`;
  if (Buffer.byteLength(body) > 65536) throw new Error("Hotplate resource configuration is too large.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, roots: normalized };
}

export function resourceFilesystemId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HOTPLATE_FILESYSTEM_ID;
  if (configured && validPathText(configured)) return configured;
  try {
    return `${platform()}:${readlinkSync("/proc/self/ns/mnt")}`;
  } catch {
    return `${platform()}:${hostname()}`;
  }
}

export function discoverResourceRoots(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  roots?: readonly string[];
  advertisedRoots?: readonly string[];
  filesystemId?: string;
}): readonly ResourceRoot[] {
  const env = options.env ?? process.env;
  const home = env.HOME || homedir();
  const filesystemId = options.filesystemId ?? resourceFilesystemId(env);
  const roots = new Map<string, ResourceRoot>();
  const add = (value: string, origin: InventoryOrigin, scope: InventoryScope): void => {
    const path = absoluteResourcePath(value, options.cwd, home);
    if (!path) return;
    const existing = roots.get(path);
    if (existing && (scope === "unassigned" || (existing.scope !== "unassigned" && originPriority(existing.origin) >= originPriority(origin)))) return;
    if (origin === "conventional" && !isDirectory(path)) return;
    roots.set(path, { path, canonicalPath: canonicalResourcePath(path), filesystemId, origin, scope });
  };

  for (const path of [...readResourceConfiguration(env).roots, ...(options.roots ?? []), ...(env.HOTPLATE_RESOURCE_ROOTS?.split(delimiter).filter(Boolean) ?? [])]) {
    add(path, "configured", "account");
  }
  for (const path of options.advertisedRoots ?? []) add(path, "host", "session");
  for (const path of [
    join(home, ".agents", "skills"),
    join(env.CODEX_HOME || join(home, ".codex"), "skills"),
    join(home, ".claude", "skills"),
    join(home, ".pi", "agent", "skills"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "skills"),
  ]) add(path, "conventional", "account");

  let ancestor = resolve(options.cwd);
  while (true) {
    for (const directory of [".agents", ".codex", ".claude", ".opencode", ".pi"]) {
      add(join(ancestor, directory, "skills"), "conventional", "project");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const registration of readRegisteredRoots({ filesystemId, env })) {
    for (const path of registration.roots) add(path, registration.origin, "unassigned");
  }
  for (const root of [...roots.values()]) {
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(root.path);
      for (let count = 0; count < 256; count += 1) {
        const entry = directory.readSync();
        if (!entry) break;
        const path = join(root.path, entry.name);
        if (entry.isSymbolicLink() && isDirectory(path)) add(path, root.origin, root.scope);
      }
    } catch {
    } finally {
      directory?.closeSync();
    }
  }
  return [...roots.values()].sort(compareRoots);
}

export function qualifyResource(options: {
  path: string;
  cwd: string;
  roots: readonly ResourceRoot[];
}): ResourceLocation | null {
  const observedPath = absoluteResourcePath(options.path, options.cwd);
  if (!observedPath) return null;
  try {
    if (!statSync(observedPath).isFile()) return null;
  } catch {
  }
  const canonicalPath = canonicalResourcePath(observedPath);
  const candidates = options.roots.filter((root) => pathWithin(observedPath, root.path) || pathWithin(canonicalPath, root.canonicalPath));
  candidates.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length || compareRoots(left, right));
  const root = candidates[0];
  if (!root) return null;
  const ownerPath = pathWithin(observedPath, root.path) ? observedPath : canonicalPath;
  const ownerRoot = pathWithin(observedPath, root.path) ? root.path : root.canonicalPath;
  return {
    filesystemId: root.filesystemId,
    canonicalPath,
    observedPath,
    rootPath: root.canonicalPath,
    kind: resourceKind(ownerPath, ownerRoot),
    ownerSkillPath: findOwner(ownerPath, ownerRoot),
  };
}

export function canonicalResourcePath(path: string): string {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(ancestor), ...suffix.reverse());
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return path;
      suffix.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function pathWithin(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function absoluteResourcePath(value: string, cwd: string, home = homedir()): string | null {
  if (!validPathText(value)) return null;
  let path = value;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }
  if (path === "~") path = home;
  else if (path.startsWith(`~${sep}`)) path = join(home, path.slice(2));
  return resolve(cwd, path);
}

function validPathText(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.includes("\0");
}

function resourceConfigurationPath(env: NodeJS.ProcessEnv): string {
  const override = env.HOTPLATE_RESOURCES_CONFIG;
  if (override !== undefined) {
    if (!validPathText(override) || !isAbsolute(override)) throw new Error("Invalid Hotplate resource configuration path.");
    return resolve(override);
  }
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "hotplate", "resources.json");
}

function parseConfiguredRoots(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "version" && key !== "roots")
    || !("version" in value) || value.version !== 1
    || !("roots" in value) || !Array.isArray(value.roots) || value.roots.length > 256) {
    throw new Error("Invalid Hotplate resource configuration.");
  }
  const roots: string[] = [];
  for (const path of value.roots) {
    if (typeof path !== "string" || !validPathText(path) || !isAbsolute(path)) throw new Error("Invalid Hotplate resource configuration.");
    roots.push(resolve(path));
  }
  return [...new Set(roots)].sort();
}

function originPriority(origin: InventoryOrigin): number {
  return { conventional: 0, configured: 1, host: 2 }[origin];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findOwner(path: string, root: string): string | null {
  let ancestor = dirname(path);
  while (pathWithin(ancestor, root)) {
    const skillPath = join(ancestor, "SKILL.md");
    try {
      if (statSync(skillPath).isFile()) return canonicalResourcePath(skillPath);
    } catch {
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return null;
}

function resourceKind(path: string, root: string): ResourceLocation["kind"] {
  const parts = relative(root, path).split(sep);
  if (basename(path) === "SKILL.md") {
    return basename(dirname(path)).startsWith("principle-") || parts.includes("principles") ? "principle" : "skill";
  }
  if (parts.includes("references") || parts.includes("reference")) return "reference";
  if (parts.includes("principles")) return "principle";
  if (parts.includes("scripts") || [".sh", ".bash", ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".pl", ".ps1"].includes(extname(path))) return "script";
  return "file";
}

function compareRoots(left: ResourceRoot, right: ResourceRoot): number {
  return left.canonicalPath.localeCompare(right.canonicalPath) || Number(left.scope === "unassigned") - Number(right.scope === "unassigned")
    || originPriority(right.origin) - originPriority(left.origin) || left.path.localeCompare(right.path);
}
