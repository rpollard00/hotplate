import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HostId } from "./domain.js";
import { parseProcessIdentity, readProcessIdentity } from "./process-attribution.js";
import type { ProcessIdentity } from "./resource-domain.js";

type AdvertisingHost = Exclude<HostId, "unknown">;
export type RegisteredResourceRoots = {
  version: 1;
  host: AdvertisingHost;
  origin: "host" | "conventional";
  sessionId: string | null;
  filesystemId: string;
  process: ProcessIdentity | null;
  advertisedAt: number;
  expiresAt: number;
  roots: readonly string[];
};

const MAX_RECORD_BYTES = 262144;
const MAX_SCAN_BYTES = 4194304;
const KNOWN_PROCESS_LIFETIME = 86400000;
const UNKNOWN_PROCESS_LIFETIME = 300000;

export function publishResourceRoots(options: {
  host: AdvertisingHost;
  sessionId: string | null;
  filesystemId: string;
  roots: readonly string[];
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
    const record = parseRegistration({ version: 1, host: options.host, origin: options.origin ?? "host", sessionId: options.sessionId, filesystemId: options.filesystemId,
      process: identity, advertisedAt, expiresAt: advertisedAt + (identity ? KNOWN_PROCESS_LIFETIME : UNKNOWN_PROCESS_LIFETIME),
      roots: [...new Set(options.roots)].sort() });
    if (!record || !isCurrent(record, advertisedAt)) return false;
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) return false;
    const directory = registryDirectory(env, true);
    if (!directory) return false;
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

export function readRegisteredRoots(options: { filesystemId: string; env?: NodeJS.ProcessEnv }): readonly RegisteredResourceRoots[] {
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
        if (!isCurrent(record, now)) { rmSync(path, { force: true }); continue; }
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
    const path = join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "hotplate", "advertised-roots");
    if (!isAbsolute(path)) return null;
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
    || Object.keys(value).some((key) => !["version", "host", "origin", "sessionId", "filesystemId", "process", "advertisedAt", "expiresAt", "roots"].includes(key))
    || !("version" in value) || value.version !== 1 || !("host" in value)
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
  return { version: 1, host: value.host, origin: value.origin, sessionId: value.sessionId, filesystemId: value.filesystemId,
    process: identity, advertisedAt: value.advertisedAt, expiresAt: value.expiresAt, roots: [...new Set(roots)].sort() };
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
