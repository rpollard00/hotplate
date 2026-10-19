import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HostId } from "./domain.js";
import { parseProcessIdentity, readProcessIdentity } from "./process-attribution.js";
import type { ProcessIdentity } from "./resource-domain.js";
import type { ResourceAuthority, ResourceRoot } from "./resource-paths.js";

type AdvertisingHost = Exclude<HostId, "unknown">;
export type RegisteredResourceRoots = {
  host: AdvertisingHost;
  origin: "host" | "conventional";
  sessionId: string | null;
  filesystemId: string;
  process: ProcessIdentity | null;
  advertisedAt: number;
  expiresAt: number;
  roots: readonly string[];
} & ({ version: 1 } | { version: 2; rootDescriptors: readonly ResourceRoot[] });

const MAX_RECORD_BYTES = 262144;
const MAX_SCAN_BYTES = 4194304;
const KNOWN_PROCESS_LIFETIME = 86400000;
const UNKNOWN_PROCESS_LIFETIME = 300000;

export function publishResourceRoots(options: {
  host: AdvertisingHost;
  sessionId: string | null;
  filesystemId: string;
  roots: readonly string[];
  rootDescriptors?: readonly ResourceRoot[];
  origin?: "host" | "conventional";
  process?: ProcessIdentity | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = options.env ?? process.env;
  if (env.HOTPLATE_DISABLED === "1" || env.HOTPLATE_DISABLED === "true") return false;
  let temporary: string | undefined;
  try {
    const identity = options.process === undefined ? readProcessIdentity(process.pid) : options.process;
    const advertisedAt = Date.now();
    const record = parseRegistration({ version: options.rootDescriptors === undefined ? 1 : 2, host: options.host, origin: options.origin ?? "host", sessionId: options.sessionId, filesystemId: options.filesystemId,
      process: identity, advertisedAt, expiresAt: advertisedAt + (identity ? KNOWN_PROCESS_LIFETIME : UNKNOWN_PROCESS_LIFETIME),
      roots: [...new Set(options.roots)].sort(), ...(options.rootDescriptors === undefined ? {} : { rootDescriptors: options.rootDescriptors }) });
    if (!record || !isCurrent(record, advertisedAt)) return false;
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) return false;
    const directory = registryDirectory(env, true);
    if (!directory) return false;
    readRegisteredRoots({ filesystemId: options.filesystemId, env, pruneExpired: true });
    const key = createHash("sha256").update(JSON.stringify([record.host, record.origin, record.sessionId, record.filesystemId, record.process])).digest("hex");
    const destination = join(directory, `${key}.json`);
    temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) { try { rmSync(temporary, { force: true }); } catch {} }
  }
}

export function readRegisteredRoots(options: { filesystemId: string; env?: NodeJS.ProcessEnv; pruneExpired?: boolean }): readonly RegisteredResourceRoots[] {
  const directory = registryDirectory(options.env ?? process.env, false);
  if (!directory) return [];
  const result: RegisteredResourceRoots[] = [];
  const now = Date.now();
  let bytes = 0;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    for (let count = 0; count < 512; count += 1) {
      const entry = handle.readSync();
      if (!entry) break;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      const path = join(directory, entry.name);
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = fstatSync(fd);
        if (!metadata.isFile() || !privateOwner(metadata) || metadata.size > MAX_RECORD_BYTES) continue;
        bytes += metadata.size;
        if (bytes > MAX_SCAN_BYTES) break;
        const record = parseRegistration(JSON.parse(readFileSync(fd, "utf8")));
        if (!record) continue;
        if (!isCurrent(record, now)) { if (options.pruneExpired) rmSync(path, { force: true }); continue; }
        if (record.filesystemId === options.filesystemId) result.push(record);
      } catch {
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  } catch {
  } finally {
    handle?.closeSync();
  }
  return result;
}

function registryDirectory(env: NodeJS.ProcessEnv, create: boolean): string | null {
  try {
    const path = env.HOTPLATE_RESOURCE_REGISTRY ?? join(env.HOME || homedir(), ".local", "state", "hotplate", "advertised-roots");
    if (!identifier(path) || !isAbsolute(path)) return null;
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(path);
    return metadata.isDirectory() && privateOwner(metadata) ? path : null;
  } catch {
    return null;
  }
}

function privateOwner(metadata: { mode: number; uid: number }): boolean {
  return (metadata.mode & 0o077) === 0 && (process.getuid === undefined || metadata.uid === process.getuid());
}

function parseRegistration(value: unknown): RegisteredResourceRoots | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["version", "host", "origin", "sessionId", "filesystemId", "process", "advertisedAt", "expiresAt", "roots", "rootDescriptors"].includes(key))
    || !("version" in value) || (value.version !== 1 && value.version !== 2) || !("host" in value)
    || (value.host !== "pi" && value.host !== "codex" && value.host !== "claude-code" && value.host !== "opencode-v1" && value.host !== "opencode-v2")
    || !("origin" in value) || (value.origin !== "host" && value.origin !== "conventional")
    || !("sessionId" in value) || (value.sessionId !== null && !identifier(value.sessionId))
    || !("filesystemId" in value) || !identifier(value.filesystemId) || !("process" in value)
    || !("advertisedAt" in value) || typeof value.advertisedAt !== "number" || !Number.isSafeInteger(value.advertisedAt)
    || !("expiresAt" in value) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    || !("roots" in value) || !Array.isArray(value.roots) || value.roots.length > 2000) return null;
  const identity = value.process === null ? null : parseProcessIdentity(value.process);
  if (value.process !== null && identity === null) return null;
  const lifetime = value.expiresAt - value.advertisedAt;
  if (lifetime <= 0 || lifetime > (identity ? KNOWN_PROCESS_LIFETIME : UNKNOWN_PROCESS_LIFETIME)) return null;
  const roots: string[] = [];
  for (const path of value.roots) {
    if (!identifier(path) || !isAbsolute(path)) return null;
    roots.push(resolve(path));
  }
  const common = { host: value.host, origin: value.origin, sessionId: value.sessionId, filesystemId: value.filesystemId,
    process: identity, advertisedAt: value.advertisedAt, expiresAt: value.expiresAt, roots: [...new Set(roots)].sort() } satisfies Omit<RegisteredResourceRoots, "version">;
  if (value.version === 1) return "rootDescriptors" in value ? null : { ...common, version: 1 };
  if (!("rootDescriptors" in value) || !Array.isArray(value.rootDescriptors) || value.rootDescriptors.length > 2000) return null;
  const rootDescriptors: ResourceRoot[] = [];
  for (const candidate of value.rootDescriptors) {
    const root = parseRootDescriptor(candidate);
    if (!root || root.filesystemId !== common.filesystemId || root.origin !== common.origin || root.scope === "unassigned" || !roots.includes(root.path)) return null;
    rootDescriptors.push(root);
  }
  if (new Set(rootDescriptors.map(root => root.path)).size !== common.roots.length) return null;
  return { ...common, version: 2, rootDescriptors };
}

function parseRootDescriptor(value: unknown): ResourceRoot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("path" in value) || !absolutePath(value.path) || !("canonicalPath" in value) || !absolutePath(value.canonicalPath)
    || !("filesystemId" in value) || !identifier(value.filesystemId)
    || !("origin" in value) || (value.origin !== "host" && value.origin !== "configured" && value.origin !== "conventional")
    || !("scope" in value) || (value.scope !== "account" && value.scope !== "project" && value.scope !== "session" && value.scope !== "unassigned")
    || !("admission" in value) || !value.admission || typeof value.admission !== "object") return null;
  const admission = value.admission;
  if (!("extent" in admission) || (admission.extent !== "tree" && admission.extent !== "file")
    || !("authority" in admission) || !("anchor" in admission) || !admission.anchor || typeof admission.anchor !== "object"
    || !("observedPath" in admission.anchor) || !absolutePath(admission.anchor.observedPath)
    || !("canonicalPath" in admission.anchor) || !absolutePath(admission.anchor.canonicalPath)
    || !("exclusions" in admission) || !admission.exclusions || typeof admission.exclusions !== "object"
    || !("segments" in admission.exclusions) || !pathRules(admission.exclusions.segments)
    || !("prefixes" in admission.exclusions) || !pathRules(admission.exclusions.prefixes)) return null;
  const authority = parseAuthority(admission.authority);
  if (!authority) return null;
  return { path: value.path, canonicalPath: value.canonicalPath, filesystemId: value.filesystemId, origin: value.origin, scope: value.scope,
    admission: { extent: admission.extent, authority, anchor: { observedPath: admission.anchor.observedPath, canonicalPath: admission.anchor.canonicalPath },
      exclusions: { segments: admission.exclusions.segments, prefixes: admission.exclusions.prefixes } } };
}

function parseAuthority(value: unknown): ResourceAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) return null;
  if (value.kind === "legacy-configured") return { kind: value.kind };
  if (!("provider" in value)) return null;
  if (value.kind === "installed" && (value.provider === "shared" || advertisingHost(value.provider)) && "location" in value
    && (value.location === "account" || value.location === "system" || value.location === "configured")) {
    return { kind: value.kind, provider: value.provider, location: value.location };
  }
  if (!advertisingHost(value.provider)) return null;
  if (value.kind === "project" && "projectRoot" in value && absolutePath(value.projectRoot) && "boundary" in value
    && (value.boundary === "reported" || value.boundary === "inferred")) {
    return { kind: value.kind, provider: value.provider, projectRoot: value.projectRoot, boundary: value.boundary };
  }
  if (value.kind === "advertised" && "sessionId" in value && (value.sessionId === null || identifier(value.sessionId))
    && "extent" in value && (value.extent === "package" || value.extent === "collection")) {
    return { kind: value.kind, provider: value.provider, sessionId: value.sessionId, extent: value.extent };
  }
  return null;
}

function advertisingHost(value: unknown): value is AdvertisingHost {
  return value === "codex" || value === "claude-code" || value === "opencode-v1" || value === "opencode-v2" || value === "pi";
}

function absolutePath(value: unknown): value is string { return identifier(value) && isAbsolute(value) && resolve(value) === value; }

function pathRules(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 16 && value.every(rule => identifier(rule) && !isAbsolute(rule) && !rule.split(/[\\/]/u).some(part => part === ".." || part === "." || part === ""));
}

function isCurrent(record: RegisteredResourceRoots, now: number): boolean {
  if (record.advertisedAt > now + 60000 || record.expiresAt <= now) return false;
  if (record.process === null) return true;
  const current = readProcessIdentity(record.process.pid);
  return current !== null && current.bootId === record.process.bootId && current.startTicks === record.process.startTicks;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
}
