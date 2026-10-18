import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { NativeHostId } from "./domain.js";
import { readNativeAccountConfiguration } from "./integrations/native-settings.js";
import { parseProcessIdentity, readProcessIdentity } from "./process-attribution.js";
import { openResourceRecorder } from "./resource-capture.js";
import type { ProcessIdentity } from "./resource-domain.js";
import { inventoryResources } from "./resource-inventory.js";
import { discoverResourceRoots, resourceFilesystemId, type ResourceRoot } from "./resource-paths.js";
import { publishResourceRoots } from "./resource-root-registry.js";
import { resolveHotplateDatabasePath } from "./store.js";

export type SessionInventoryRequest = { host: NativeHostId; sessionId: string; cwd: string; advertisedRoots?: readonly string[]; harnessProcess?: ProcessIdentity | null; leaseToken?: string };

export function parseSessionInventoryRequest(value: unknown): SessionInventoryRequest {
  if (!value || typeof value !== "object" || !("host" in value) || !("sessionId" in value) || !("cwd" in value)
    || (value.host !== "codex" && value.host !== "claude-code" && value.host !== "opencode-v1" && value.host !== "opencode-v2")
    || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 4096
    || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || value.cwd.length > 4096) throw new Error("Invalid session inventory request.");
  const request: SessionInventoryRequest = { host: value.host, sessionId: value.sessionId, cwd: value.cwd };
  if ("harnessProcess" in value) {
    const identity = value.harnessProcess === null ? null : parseProcessIdentity(value.harnessProcess);
    if (value.harnessProcess !== null && identity === null) throw new Error("Invalid inventory harness process.");
    request.harnessProcess = identity;
  }
  if ("advertisedRoots" in value) {
    if (!Array.isArray(value.advertisedRoots) || value.advertisedRoots.length > 2000) throw new Error("Invalid inventory roots.");
    const roots: string[] = [];
    for (const path of value.advertisedRoots) {
      if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0")) throw new Error("Invalid inventory roots.");
      roots.push(path);
    }
    request.advertisedRoots = roots;
  }
  if ("leaseToken" in value) {
    if (typeof value.leaseToken !== "string" || !/^[a-f0-9-]{36}$/u.test(value.leaseToken)) throw new Error("Invalid inventory lease.");
    request.leaseToken = value.leaseToken;
  }
  return request;
}

function sessionSlot(request: SessionInventoryRequest, env: NodeJS.ProcessEnv) {
  const roots = discoverResourceRoots({ cwd: request.cwd, env, ...(request.advertisedRoots ? { advertisedRoots: request.advertisedRoots } : {}) });
  publishSessionRoots(request, env, roots);
  const configuration = readNativeAccountConfiguration(env);
  const databasePath = configuration?.databasePath ?? resolveHotplateDatabasePath({ env });
  const key = createHash("sha256").update(JSON.stringify([databasePath, configuration?.enrollment.sourceId ?? "local", request.host, request.sessionId, request.cwd, roots])).digest("hex");
  const directory = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "hotplate", "session-inventory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).mode & 0o077) throw new Error("Inventory state directory is not private.");
  return { roots, databasePath, completed: join(directory, `${key}.complete`), lease: join(directory, `${key}.lease`) };
}

function readLease(path: string) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > 4096 || (metadata.mode & 0o077)) return null;
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/u.test(value.token)
      || !("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || !("process" in value)) return null;
    return { token: value.token, createdAt: value.createdAt, process: parseProcessIdentity(value.process) };
  } finally { closeSync(fd); }
}

function withLeaseLock<T>(slot: ReturnType<typeof sessionSlot>, action: () => T): T {
  mkdirSync(dirname(slot.databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(slot.databasePath, { timeout: 1000, allowExtension: false });
  try {
    chmodSync(slot.databasePath, 0o600);
    db.exec("BEGIN IMMEDIATE");
    try { return action(); }
    finally { db.exec("ROLLBACK"); }
  } finally { db.close(); }
}

function releaseLease(slot: ReturnType<typeof sessionSlot>, token: string): void {
  withLeaseLock(slot, () => { if (readLease(slot.lease)?.token === token) rmSync(slot.lease, { force: true }); });
}

function claimLease(slot: ReturnType<typeof sessionSlot>): string | null {
  return withLeaseLock(slot, () => {
    if (existsSync(slot.completed)) return null;
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(slot.lease, JSON.stringify({ token, createdAt: Date.now(), process: readProcessIdentity(process.pid) }), { flag: "wx", mode: 0o600 });
        return token;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const lease = readLease(slot.lease);
        const current = lease?.process ? readProcessIdentity(lease.process.pid) : null;
        const alive = lease?.process && current && lease.process.bootId === current.bootId && lease.process.startTicks === current.startTicks;
        if (lease && Date.now() - lease.createdAt < 30000 && (alive || lease.process === null)) return null;
        rmSync(slot.lease, { force: true });
      }
    }
    return null;
  });
}

export function launchSessionInventory(request: SessionInventoryRequest, env: NodeJS.ProcessEnv = process.env): void {
  if (env.HOTPLATE_DISABLED === "1" || env.HOTPLATE_DISABLED === "true") return;
  try {
    const slot = sessionSlot(request, env);
    if (existsSync(slot.completed)) return;
    const leaseToken = claimLease(slot);
    if (!leaseToken) return;
    const child = spawn(env.HOTPLATE_NODE_BIN ?? process.execPath, [fileURLToPath(new URL("./integrations/command.js", import.meta.url)), "--inventory"], {
      detached: true, stdio: ["pipe", "ignore", "ignore"], env: { ...env, NODE_NO_WARNINGS: "1" },
    });
    child.once("error", () => { try { releaseLease(slot, leaseToken); } catch {} });
    child.stdin.on("error", () => {});
    const childPid = child.pid;
    if (childPid) withLeaseLock(slot, () => {
      if (readLease(slot.lease)?.token === leaseToken) writeFileSync(slot.lease, JSON.stringify({ token: leaseToken, createdAt: Date.now(), process: readProcessIdentity(childPid) }), { mode: 0o600 });
    });
    child.stdin.end(JSON.stringify({ ...request, leaseToken }));
    child.unref();
  } catch {
  }
}

export async function runSessionInventory(request: SessionInventoryRequest, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.HOTPLATE_DISABLED === "1" || env.HOTPLATE_DISABLED === "true") return;
  const slot = sessionSlot(request, env);
  const token = request.leaseToken ?? claimLease(slot);
  if (!token) return;
  try {
    if (!withLeaseLock(slot, () => readLease(slot.lease)?.token === token && !existsSync(slot.completed))) return;
    const recorder = openResourceRecorder({ cwd: request.cwd, env });
    try {
      const result = await inventoryResources({ roots: slot.roots, signal: AbortSignal.timeout(20000), record: async (evidence) => {
        if (readLease(slot.lease)?.token !== token) throw new Error("Inventory lease expired.");
        await recorder.record({ evidence, host: request.host, sessionId: request.sessionId });
      } });
      if (result.scans.every((scan) => scan.status === "complete")) withLeaseLock(slot, () => {
        if (readLease(slot.lease)?.token !== token) throw new Error("Inventory lease expired.");
        const temporary = `${slot.completed}.${token}.tmp`;
        writeFileSync(temporary, JSON.stringify({ completedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
        renameSync(temporary, slot.completed);
      });
    } finally { await recorder.close(); }
  } finally {
    releaseLease(slot, token);
  }
}

function publishSessionRoots(request: SessionInventoryRequest, env: NodeJS.ProcessEnv, roots: readonly ResourceRoot[]): void {
  if (request.advertisedRoots) publishResourceRoots({ host: request.host, sessionId: request.sessionId,
    filesystemId: resourceFilesystemId(env), roots: request.advertisedRoots, process: request.harnessProcess ?? null, env });
  publishResourceRoots({ host: request.host, sessionId: request.sessionId, filesystemId: resourceFilesystemId(env), origin: "conventional",
    roots: roots.filter((root) => root.origin === "conventional" && root.scope === "project").map((root) => root.path), process: request.harnessProcess ?? null, env });
}
