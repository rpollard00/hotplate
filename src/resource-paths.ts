import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, opendirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { InventoryOrigin, InventoryScope, ResourceLocation } from "./resource-domain.js";
import type { HostId } from "./domain.js";
import { readRegisteredRoots } from "./resource-root-registry.js";

export type ResourceHost = Exclude<HostId, "unknown">;
export type ResourceBoundary = { readonly kind: "reported"; readonly path: string } | { readonly kind: "infer" };
export type ResourceAdvertisement =
  | { readonly kind: "package"; readonly path: string; readonly host: ResourceHost; readonly sessionId: string | null }
  | { readonly kind: "collection"; readonly path: string; readonly host: ResourceHost; readonly sessionId: string | null; readonly source: "host-configuration" };
export type ResourceAuthority =
  | { readonly kind: "installed"; readonly provider: ResourceHost | "shared"; readonly location: "account" | "system" | "configured" }
  | { readonly kind: "project"; readonly provider: ResourceHost; readonly projectRoot: string; readonly boundary: "reported" | "inferred" }
  | { readonly kind: "advertised"; readonly provider: ResourceHost; readonly sessionId: string | null; readonly extent: "package" | "collection" }
  | { readonly kind: "legacy-configured" };
export type ResourceRoot = Readonly<{
  path: string;
  canonicalPath: string;
  filesystemId: string;
  origin: InventoryOrigin;
  scope: InventoryScope;
  admission: Readonly<{
    extent: "tree" | "file";
    authority: ResourceAuthority;
    anchor: Readonly<{ observedPath: string; canonicalPath: string }>;
    exclusions: Readonly<{ segments: readonly string[]; prefixes: readonly string[] }>;
  }>;
}>;
export type ResourceDiagnostic = Readonly<{
  path: string;
  canonicalPath: string | null;
  reason: "source-root" | "legacy-declaration" | "outside-project" | "excluded" | "escaping-link" | "authority-changed" | "missing" | "unreadable" | "limit";
  relatedPaths: readonly string[];
}>;
export type DiscoverResourceRootsOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  roots?: readonly string[];
  filesystemId?: string;
  project?: { host: ResourceHost; boundary: ResourceBoundary };
  advertisements?: readonly ResourceAdvertisement[];
  advertisedRoots?: readonly string[];
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void;
};
export type ResourceAdmission =
  | { kind: "accepted"; root: ResourceRoot; observedPath: string; canonicalPath: string }
  | { kind: "rejected"; reason: ResourceDiagnostic["reason"] | "outside-scope" | "not-file" };

type AccountLocation = "agents" | "codex" | "codex-system" | "claude" | "pi" | "opencode";
type ProviderPolicy = { account: readonly AccountLocation[]; project: readonly { path: string; ancestors: boolean }[] };
const PROVIDERS: Record<ResourceHost, ProviderPolicy> = {
  codex: { account: ["agents", "codex", "codex-system"], project: [{ path: ".agents/skills", ancestors: true }] },
  "claude-code": { account: ["claude"], project: [{ path: ".claude/skills", ancestors: true }] },
  "opencode-v1": { account: ["opencode"], project: [{ path: ".opencode/skills", ancestors: true }] },
  "opencode-v2": { account: ["opencode", "claude", "agents"], project: [".opencode/skills", ".claude/skills", ".agents/skills"].map(path => ({ path, ancestors: true })) },
  pi: { account: ["pi", "agents"], project: [{ path: ".pi/skills", ancestors: false }, { path: ".agents/skills", ancestors: true }] },
};
const EXCLUDED_SEGMENTS = Object.freeze([".git", ".jj", "node_modules"]);
const validatedRoots = new WeakSet<ResourceRoot>();
const incompleteRoots = new WeakSet<ResourceRoot>();
const narrowedSources = new WeakMap<ResourceRoot, ResourceRoot>();

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

export function discoverResourceRoots(options: DiscoverResourceRootsOptions): readonly ResourceRoot[] {
  const env = options.env ?? process.env;
  const home = resolve(env.HOME || homedir());
  const filesystemId = options.filesystemId ?? resourceFilesystemId(env);
  const roots = new Map<string, ResourceRoot>();
  const accounts = accountLocations(env, home);
  const caches = [join(env.CODEX_HOME || join(home, ".codex"), "plugins", "cache"), join(home, ".claude", "plugins", "cache")];
  const diagnostic = (path: string, reason: ResourceDiagnostic["reason"], relatedPaths: readonly string[] = []): void => {
    const canonicalPath = canonicalResourcePath(path);
    const installed = reason === "source-root" ? [...roots.values()]
      .filter(root => root.admission.authority.kind !== "legacy-configured" && pathWithin(root.canonicalPath, canonicalPath))
      .map(root => root.path) : [];
    options.onDiagnostic?.({ path, canonicalPath, reason, relatedPaths: [...new Set([...relatedPaths, ...installed])].sort() });
  };
  const add = (input: {
    path: string; origin: InventoryOrigin; scope: InventoryScope; authority: ResourceAuthority;
    anchor?: ResourceRoot["admission"]["anchor"]; extent?: "tree" | "file"; canonicalPath?: string;
  }): ResourceRoot | null => {
    const path = absoluteResourcePath(input.path, options.cwd, home);
    if (!path) return null;
    const canonicalPath = canonicalResourcePath(path);
    if (input.canonicalPath !== undefined && input.canonicalPath !== canonicalPath) {
      diagnostic(path, "authority-changed", [input.canonicalPath]);
      return null;
    }
    const existing = roots.get(path);
    if (existing && (input.scope === "unassigned" || (existing.scope !== "unassigned" && originPriority(existing.origin) >= originPriority(input.origin)))) return existing;
    const anchor = input.anchor ?? { observedPath: path, canonicalPath };
    if (canonicalResourcePath(anchor.observedPath) !== anchor.canonicalPath) {
      diagnostic(path, "authority-changed", [anchor.observedPath]);
      return null;
    }
    if (isRetiredPath(path) || isRetiredPath(canonicalPath)
      || [path, canonicalPath].some(candidate => candidate.split(sep).some(segment => segment === ".git" || segment === ".jj"))) {
      diagnostic(path, "excluded");
      return null;
    }
    const directPackage = isPackageDirectory(path);
    const independent = input.authority.kind === "installed" || input.authority.kind === "project" || (input.anchor !== undefined && input.anchor.observedPath !== path);
    if (caches.some(cache => pathWithin(cache, path) || pathWithin(canonicalResourcePath(cache), canonicalPath))
      || unsafeRoot(path, home, directPackage, independent) || unsafeRoot(canonicalPath, canonicalResourcePath(home), directPackage, independent)) {
      diagnostic(path, "source-root");
      return null;
    }
    let extent = input.extent ?? "tree";
    try {
      const metadata = statSync(path);
      if (metadata.isFile()) extent = "file";
      else if (!metadata.isDirectory()) { diagnostic(path, "unreadable"); return null; }
    } catch (error) {
      if (input.origin === "conventional") return null;
      diagnostic(path, filesystemReason(error));
    }
    const root = freezeRoot({ path, canonicalPath, filesystemId, origin: input.origin, scope: input.scope,
      admission: { extent, authority: input.authority, anchor, exclusions: { segments: EXCLUDED_SEGMENTS, prefixes: retirementPrefixes(path, canonicalPath) } } });
    roots.set(path, root);
    if (input.authority.kind === "legacy-configured") diagnostic(path, "legacy-declaration");
    return root;
  };
  const accountHosts: readonly ResourceHost[] = options.project ? [options.project.host] : ["codex", "claude-code", "opencode-v1", "opencode-v2", "pi"];
  for (const host of accountHosts) {
    for (const location of PROVIDERS[host].account) {
      const path = accounts[location];
      add({ path, origin: "conventional", scope: "account", authority: {
        kind: "installed", provider: location === "agents" ? "shared" : host, location: location === "codex-system" ? "system" : "account",
      } });
    }
  }
  if (options.project) {
    const boundary = projectBoundary(options, diagnostic);
    if (boundary) {
      let ancestor = resolve(options.cwd);
      while (true) {
        for (const convention of PROVIDERS[options.project.host].project) {
          if (!convention.ancestors && ancestor !== resolve(options.cwd)) continue;
          add({ path: join(ancestor, convention.path), origin: "conventional", scope: "project", authority: {
            kind: "project", provider: options.project.host, projectRoot: boundary.path, boundary: boundary.kind,
          } });
        }
        if (ancestor === boundary.path) break;
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
  }
  const aliases = (root: ResourceRoot): void => {
    if (root.admission.extent !== "tree" || (root.admission.authority.kind === "advertised" && root.admission.authority.extent !== "collection")) return;
    if (isPackageDirectory(root.path) && root.admission.authority.kind !== "advertised") return;
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(root.path);
      for (let count = 0; count <= 100000; count += 1) {
        const entry = directory.readSync();
        if (!entry) return;
        if (count === 100000) { diagnostic(root.path, "limit"); incompleteRoots.add(root); return; }
        if (!entry.isSymbolicLink() || excludedRelative(entry.name, root.admission.exclusions)) continue;
        const path = join(root.path, entry.name);
        const canonicalPath = canonicalResourcePath(path);
        if (pathWithin(canonicalPath, root.canonicalPath)) continue;
        add({ path, origin: root.origin, scope: root.scope, authority: root.admission.authority, anchor: root.admission.anchor });
      }
    } catch {
    } finally {
      directory?.closeSync();
    }
  };
  for (const root of [...roots.values()]) aliases(root);
  for (const path of [...readResourceConfiguration(env).roots, ...(options.roots ?? []), ...(env.HOTPLATE_RESOURCE_ROOTS?.split(delimiter).filter(Boolean) ?? [])]) {
    const absolute = absoluteResourcePath(path, options.cwd, home);
    if (!absolute) continue;
    const canonical = canonicalResourcePath(absolute);
    const installed = [...roots.values()].find(root => root.canonicalPath === canonical);
    const root = add({ path: absolute, origin: "configured", scope: "account", authority: installed?.admission.authority ?? { kind: "legacy-configured" },
      ...(installed ? { anchor: installed.admission.anchor } : {}) });
    if (root) aliases(root);
  }
  for (const advertisement of options.advertisements ?? []) {
    const advertisedPath = absoluteResourcePath(advertisement.path, options.cwd, home);
    if (!advertisedPath) continue;
    const packageProof = advertisement.kind === "package" && (isFile(advertisedPath) || isPackageDirectory(advertisedPath));
    const independent = packageProof ? undefined : [...roots.values()].find(root => root.canonicalPath === canonicalResourcePath(advertisedPath) && root.admission.authority.kind !== "advertised");
    if (advertisement.kind === "package" && !packageProof && !independent) {
      diagnostic(advertisedPath, "missing");
      continue;
    }
    const root = add({ path: advertisement.path, origin: "host", scope: "session", authority: {
      kind: "advertised", provider: advertisement.host, sessionId: advertisement.sessionId, extent: advertisement.kind,
    }, ...(independent ? { anchor: { observedPath: independent.path, canonicalPath: independent.canonicalPath } } : {}) });
    if (root && advertisement.kind === "collection") aliases(root);
  }
  const addLegacy = (path: string, host: ResourceHost, origin: "host" | "conventional", scope: InventoryScope): void => {
    const absolute = absoluteResourcePath(path, options.cwd, home);
    if (!absolute) return;
    const conventional = recognizedConvention(absolute, host, accounts);
    if (!conventional && (origin === "conventional" || !isPackageDirectory(absolute))) {
      diagnostic(absolute, "source-root");
      return;
    }
    const root = add({ path: absolute, origin, scope, authority: conventional
      ? { kind: "installed", provider: host, location: "configured" }
      : { kind: "advertised", provider: host, sessionId: null, extent: "package" } });
    if (root && conventional) aliases(root);
  };
  for (const path of options.advertisedRoots ?? []) addLegacy(path, options.project?.host ?? "codex", "host", "session");
  for (const registration of readRegisteredRoots({ filesystemId, env })) {
    if (registration.version === 2) {
      for (const descriptor of registration.rootDescriptors) {
        const independent = [...roots.values()].some(root => root.canonicalPath === descriptor.canonicalPath && root.admission.authority.kind !== "advertised");
        if (!registeredAuthority(descriptor, registration.host, accounts, independent)) { diagnostic(descriptor.path, "source-root"); continue; }
        const root = add({ path: descriptor.path, canonicalPath: descriptor.canonicalPath, origin: registration.origin, scope: "unassigned",
          authority: descriptor.admission.authority, anchor: descriptor.admission.anchor, extent: descriptor.admission.extent });
        if (root && root.path === root.admission.anchor.observedPath) aliases(root);
      }
    } else {
      for (const path of registration.roots) addLegacy(path, registration.host, registration.origin, "unassigned");
    }
  }
  const selectedRoots = resolveRootExclusions([...roots.values()], (root, sources) => diagnostic(root.path, "excluded", sources.map(source => source.path)));
  roots.clear();
  for (const root of selectedRoots) roots.set(root.path, root);
  const retirementRoots = selectedRoots.filter(root => root.admission.exclusions.prefixes.length > 0);
  for (const root of roots.values()) {
    const prefixes = new Set(root.admission.exclusions.prefixes);
    let retired = false;
    for (const source of retirementRoots) for (const prefix of source.admission.exclusions.prefixes) {
      const path = join(source.canonicalPath, prefix);
      if (pathWithin(root.canonicalPath, path)) retired = true;
      else if (pathWithin(path, root.canonicalPath)) prefixes.add(relative(root.canonicalPath, path));
    }
    if (retired) { roots.delete(root.path); diagnostic(root.path, "excluded"); }
    else if (prefixes.size !== root.admission.exclusions.prefixes.length) {
      const replacement = freezeRoot({ ...root, admission: { ...root.admission, exclusions: { segments: EXCLUDED_SEGMENTS, prefixes: [...prefixes].sort() } } });
      if (incompleteRoots.has(root)) incompleteRoots.add(replacement);
      roots.set(root.path, replacement);
    }
  }
  return Object.freeze([...roots.values()].sort(compareRoots));
}

export function narrowResourceRoot(options: { root: ResourceRoot; path: string; entry: "directory" | "file" }): ResourceRoot | null {
  const { root, entry } = options;
  const admission = admitResourcePath({ path: options.path, cwd: root.path, roots: [root], entry });
  if (admission.kind === "rejected") return null;
  const path = join(root.path, relative(root.canonicalPath, admission.canonicalPath));
  const projected = admitResourcePath({ path, cwd: root.path, roots: [root], entry });
  if (projected.kind === "rejected" || projected.canonicalPath !== admission.canonicalPath) return null;
  if (projected.canonicalPath === root.canonicalPath) return root;
  const prefixes = root.admission.exclusions.prefixes.map(prefix => join(root.canonicalPath, prefix))
    .filter(prefix => pathWithin(prefix, projected.canonicalPath))
    .map(prefix => relative(projected.canonicalPath, prefix));
  const narrowed = freezeRoot({ ...root, path, canonicalPath: projected.canonicalPath, admission: {
    ...root.admission, extent: entry === "directory" ? "tree" : "file",
    exclusions: { segments: root.admission.exclusions.segments, prefixes },
  } });
  narrowedSources.set(narrowed, root);
  return narrowed;
}

export function admitResourcePath(options: {
  path: string; cwd: string; roots: readonly ResourceRoot[]; entry: "directory" | "file" | "file-or-missing";
}): ResourceAdmission {
  const observedPath = absoluteResourcePath(options.path, options.cwd);
  if (!observedPath) return { kind: "rejected", reason: "outside-scope" };
  const canonicalPath = canonicalResourcePath(observedPath);
  const candidates = options.roots.filter(root => pathWithin(observedPath, root.path) || pathWithin(observedPath, root.canonicalPath));
  candidates.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length || compareRoots(left, right));
  let reason: Extract<ResourceAdmission, { kind: "rejected" }>["reason"] = "outside-scope";
  for (const root of candidates) {
    const source = narrowedSources.get(root);
    if (source) {
      const inherited = admitResourcePath({ ...options, roots: [source] });
      if (inherited.kind === "rejected") { reason = inherited.reason; continue; }
    }
    if (incompleteRoots.has(root)) { reason = "limit"; continue; }
    if (!validatedRoots.has(root) || canonicalResourcePath(root.path) !== root.canonicalPath
      || canonicalResourcePath(root.admission.anchor.observedPath) !== root.admission.anchor.canonicalPath) {
      reason = "authority-changed";
      continue;
    }
    const observedRoot = pathWithin(observedPath, root.path) ? root.path : root.canonicalPath;
    if (excludedRelative(relative(observedRoot, observedPath), root.admission.exclusions)
      || (pathWithin(canonicalPath, root.canonicalPath) && excludedRelative(relative(root.canonicalPath, canonicalPath), root.admission.exclusions))) {
      reason = "excluded";
      continue;
    }
    if (!pathWithin(canonicalPath, root.canonicalPath)) { reason = "escaping-link"; continue; }
    if (root.admission.extent === "file" && canonicalPath !== root.canonicalPath) continue;
    try {
      const metadata = statSync(observedPath);
      if (options.entry === "directory" ? !metadata.isDirectory() : !metadata.isFile()) { reason = "not-file"; continue; }
    } catch (error) {
      if (options.entry !== "file-or-missing" || filesystemReason(error) !== "missing") { reason = filesystemReason(error); continue; }
    }
    return { kind: "accepted", root, observedPath, canonicalPath };
  }
  return { kind: "rejected", reason };
}

export function qualifyResource(options: { path: string; cwd: string; roots: readonly ResourceRoot[] }): ResourceLocation | null {
  const admission = admitResourcePath({ ...options, entry: "file-or-missing" });
  if (admission.kind === "rejected") return null;
  const { observedPath, canonicalPath } = admission;
  let root = admission.root;
  let source = narrowedSources.get(root);
  while (source) { root = source; source = narrowedSources.get(root); }
  const ownerPath = pathWithin(observedPath, root.path) ? observedPath : canonicalPath;
  const ownerRoot = pathWithin(observedPath, root.path) ? root.path : root.canonicalPath;
  return { filesystemId: root.filesystemId, canonicalPath, observedPath, rootPath: root.canonicalPath,
    kind: resourceKind(ownerPath, ownerRoot), ownerSkillPath: findOwner(ownerPath, ownerRoot, root) };
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
  return join(env.HOME || homedir(), ".config", "hotplate", "resources.json");
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

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isPackageDirectory(path: string): boolean {
  const marker = join(path, "SKILL.md");
  if (!isFile(marker)) return false;
  const root = canonicalResourcePath(path);
  const canonical = canonicalResourcePath(marker);
  return pathWithin(canonical, root) && !excludedRelative(relative(root, canonical), { segments: EXCLUDED_SEGMENTS, prefixes: [] });
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function accountLocations(env: NodeJS.ProcessEnv, home: string): Record<AccountLocation, string> {
  return {
    agents: join(home, ".agents", "skills"), codex: join(env.CODEX_HOME || join(home, ".codex"), "skills"),
    "codex-system": "/etc/codex/skills", claude: join(home, ".claude", "skills"), pi: join(home, ".pi", "agent", "skills"),
    opencode: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "skills"),
  };
}

function projectBoundary(options: DiscoverResourceRootsOptions, diagnostic: (path: string, reason: ResourceDiagnostic["reason"], relatedPaths?: readonly string[]) => void): { path: string; kind: "reported" | "inferred" } | null {
  if (!options.project) return null;
  const cwd = resolve(options.cwd);
  if (options.project.boundary.kind === "reported") {
    const path = absoluteResourcePath(options.project.boundary.path, cwd);
    if (!path || !pathWithin(cwd, path) || !pathWithin(canonicalResourcePath(cwd), canonicalResourcePath(path))) {
      diagnostic(cwd, "outside-project", path ? [path] : []);
      return null;
    }
    return { path, kind: "reported" };
  }
  let ancestor = cwd;
  while (true) {
    if (exists(join(ancestor, ".git")) || exists(join(ancestor, ".jj"))) return { path: ancestor, kind: "inferred" };
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  diagnostic(cwd, "outside-project");
  return { path: cwd, kind: "inferred" };
}

function recognizedConvention(path: string, host: ResourceHost, accounts: Record<AccountLocation, string>): boolean {
  return PROVIDERS[host].account.some(location => path === accounts[location])
    || PROVIDERS[host].project.some(convention => path.endsWith(`${sep}${convention.path.split("/").join(sep)}`))
    || (host === "opencode-v1" && path.endsWith(`${sep}opencode${sep}skills`));
}

function registeredAuthority(root: ResourceRoot, host: ResourceHost, accounts: Record<AccountLocation, string>, independent: boolean): boolean {
  const { authority, anchor } = root.admission;
  if (root.path !== anchor.observedPath) {
    try {
      if (!(root.canonicalPath === anchor.canonicalPath && root.path === root.canonicalPath)
        && (dirname(root.path) !== anchor.observedPath || !lstatSync(root.path).isSymbolicLink())) return false;
    } catch { return false; }
  }
  switch (authority.kind) {
    case "installed":
      return authority.provider === "shared" ? anchor.observedPath === accounts.agents || anchor.observedPath.endsWith(`${sep}.agents${sep}skills`)
        : recognizedConvention(anchor.observedPath, authority.provider, accounts);
    case "project":
      return authority.provider === host && pathWithin(anchor.observedPath, authority.projectRoot)
        && PROVIDERS[host].project.some(convention => anchor.observedPath.endsWith(`${sep}${convention.path.split("/").join(sep)}`));
    case "advertised":
      return authority.provider === host && (authority.extent === "collection" || independent
        || (root.path === anchor.observedPath && (root.admission.extent === "file" ? isFile(root.path) : isPackageDirectory(root.path))));
    case "legacy-configured": return false;
  }
}

function unsafeRoot(path: string, home: string, directPackage: boolean, independent: boolean): boolean {
  if (pathWithin(home, path) || dirname(path) === path) return true;
  const parts = path.split(sep);
  const plugins = parts.indexOf("plugins");
  if (plugins >= 0 && (parts[plugins + 1] === "cache" || plugins === parts.length - 1)) {
    if (!directPackage && (basename(path) !== "skills" || parts.length < plugins + 6)) return true;
  }
  return !directPackage && !independent && (exists(join(path, ".git")) || exists(join(path, ".jj")));
}

function isRetiredPath(path: string): boolean {
  const parts = path.split(sep);
  return parts.some((part, index) => part === ".claude" && parts[index + 1] === "skills" && parts[index + 2] === ".trash");
}

function retirementPrefixes(...paths: readonly string[]): readonly string[] {
  return paths.some(path => path.endsWith(`${sep}.claude${sep}skills`)) ? [".trash"] : [];
}

function excludedRelative(path: string, exclusions: ResourceRoot["admission"]["exclusions"]): boolean {
  return path.split(sep).some(part => exclusions.segments.includes(part))
    || exclusions.prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}${sep}`));
}

function resolveRootExclusions(roots: readonly ResourceRoot[], reject: (root: ResourceRoot, sources: readonly ResourceRoot[]) => void): readonly ResourceRoot[] {
  const blockers = new Map<ResourceRoot, Set<ResourceRoot>>();
  for (const root of roots) {
    blockers.set(root, new Set(roots.filter(source => source !== root && [
      [root.path, source.path], [root.canonicalPath, source.canonicalPath],
      [root.admission.anchor.observedPath, source.path], [root.admission.anchor.canonicalPath, source.canonicalPath],
    ].some(([path, boundary]) => path !== undefined && boundary !== undefined && pathWithin(path, boundary)
      && excludedRelative(relative(boundary, path), source.admission.exclusions)))));
  }
  const selected: ResourceRoot[] = [];
  while (blockers.size > 0) {
    const ready = new Set([...blockers].filter(([, sources]) => sources.size === 0).map(([root]) => root));
    const cyclic = ready.size === 0 ? cyclicRootAuthorities(blockers) : new Set<ResourceRoot>();
    const removed = new Set([...ready, ...cyclic]);
    for (const [root, sources] of blockers) {
      const excludedBy = cyclic.has(root) ? [...sources] : [...sources].filter(source => ready.has(source));
      if (excludedBy.length > 0) { removed.add(root); reject(root, excludedBy); }
    }
    for (const root of ready) selected.push(root);
    for (const root of removed) blockers.delete(root);
    for (const sources of blockers.values()) for (const root of removed) sources.delete(root);
  }
  return selected;
}

function cyclicRootAuthorities(blockers: ReadonlyMap<ResourceRoot, ReadonlySet<ResourceRoot>>): Set<ResourceRoot> {
  type Visit = { root: ResourceRoot; index: number; low: number; parent: Visit | null; sources: Iterator<ResourceRoot> };
  const visits = new Map<ResourceRoot, Visit>();
  const active = new Set<ResourceRoot>();
  const pending: ResourceRoot[] = [];
  const cyclic = new Set<ResourceRoot>();
  const frames: Visit[] = [];
  const enter = (root: ResourceRoot, parent: Visit | null): void => {
    const visit: Visit = { root, index: visits.size, low: visits.size, parent, sources: (blockers.get(root) ?? new Set<ResourceRoot>()).values() };
    visits.set(root, visit);
    active.add(root);
    pending.push(root);
    frames.push(visit);
  };
  for (const root of blockers.keys()) {
    if (visits.has(root)) continue;
    enter(root, null);
    while (frames.length > 0) {
      const visit = frames.at(-1);
      if (!visit) break;
      const next = visit.sources.next();
      if (!next.done) {
        const source = visits.get(next.value);
        if (!source) enter(next.value, visit);
        else if (active.has(source.root)) visit.low = Math.min(visit.low, source.index);
        continue;
      }
      frames.pop();
      if (visit.parent) visit.parent.low = Math.min(visit.parent.low, visit.low);
      if (visit.low !== visit.index) continue;
      const component: ResourceRoot[] = [];
      while (pending.length > 0) {
        const member = pending.pop();
        if (!member) break;
        active.delete(member);
        component.push(member);
        if (member === visit.root) break;
      }
      if (component.length > 1) for (const member of component) cyclic.add(member);
    }
  }
  return cyclic;
}

function freezeRoot(root: ResourceRoot): ResourceRoot {
  const frozen = Object.freeze({ ...root, admission: Object.freeze({ ...root.admission,
    authority: Object.freeze({ ...root.admission.authority }), anchor: Object.freeze({ ...root.admission.anchor }),
    exclusions: Object.freeze({ segments: Object.freeze([...root.admission.exclusions.segments]), prefixes: Object.freeze([...root.admission.exclusions.prefixes]) }),
  }) });
  validatedRoots.add(frozen);
  return frozen;
}

function filesystemReason(error: unknown): "missing" | "unreadable" {
  return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unreadable";
}

function findOwner(path: string, root: string, descriptor: ResourceRoot): string | null {
  let ancestor = dirname(path);
  while (pathWithin(ancestor, root)) {
    const skillPath = join(ancestor, "SKILL.md");
    try {
      if (admitResourcePath({ path: skillPath, cwd: root, roots: [descriptor], entry: "file" }).kind === "accepted") return canonicalResourcePath(skillPath);
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
