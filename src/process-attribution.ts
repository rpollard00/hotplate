import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { HostId } from "./domain.js";
import type { ProcessIdentity } from "./resource-domain.js";

type HarnessHost = Exclude<HostId, "unknown">;
type RecognizedHarness = HarnessHost | "opencode";
type ProcessOptions = { procRoot?: string };
type RegistryOptions = ProcessOptions & { env?: NodeJS.ProcessEnv };

export type ProcessBinding =
  | { kind: "shared" }
  | { kind: "dedicated"; sessionId: string; actorId: string; projectCwd: string };

export type ProcessRegistration = {
  version: 1;
  process: ProcessIdentity;
  host: HarnessHost;
  binding: ProcessBinding;
  source: "in-process" | "native-hook" | "wrapper";
};

export type ProcessAttribution =
  | { kind: "session"; host: HarnessHost; sessionId: string; actorId: string; projectCwd: string }
  | { kind: "harness"; host: HostId; sessionId: null; actorId: null; projectCwd: null }
  | { kind: "non-agent" | "unknown"; host: "unknown"; sessionId: null; actorId: null; projectCwd: null };

type ProcessSnapshot = { identity: ProcessIdentity; parentPid: number; uid: number; harness: RecognizedHarness | null };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
}

export function parseProcessIdentity(value: unknown): ProcessIdentity | null {
  const fields = record(value);
  if (!fields || typeof fields.bootId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/u.test(fields.bootId) || typeof fields.pid !== "number" || !Number.isSafeInteger(fields.pid) || fields.pid < 1 || typeof fields.startTicks !== "string" || !/^\d{1,30}$/u.test(fields.startTicks)) return null;
  return { bootId: fields.bootId, pid: fields.pid, startTicks: fields.startTicks };
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startTicks === right.startTicks && left.bootId === right.bootId;
}

function readBounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const data = Buffer.alloc(limit + 1);
    const bytes = readSync(fd, data, 0, data.length, null);
    if (bytes > limit) throw new Error("Process metadata exceeds limit");
    return data.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
}

function processStat(pid: number, procRoot: string): { parentPid: number; startTicks: string } | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readBounded(join(procRoot, String(pid), "stat"), 8192);
    if (!stat.startsWith(`${pid} (`)) return null;
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const startTicks = fields[19];
    if (!Number.isSafeInteger(parentPid) || parentPid < 0 || startTicks === undefined || !/^\d{1,30}$/u.test(startTicks)) return null;
    return { parentPid, startTicks };
  } catch { return null; }
}

export function readProcessIdentity(pid: number, options: ProcessOptions = {}): ProcessIdentity | null {
  const procRoot = options.procRoot ?? "/proc";
  const stat = processStat(pid, procRoot);
  if (!stat) return null;
  try { return parseProcessIdentity({ bootId: readBounded(join(procRoot, "sys/kernel/random/boot_id"), 128).trim(), pid, startTicks: stat.startTicks }); }
  catch { return null; }
}

function recognizedHarness(executable: string, commandName: string, script: string | null): RecognizedHarness | null {
  const name = basename(executable);
  if (name === "codex" || /\/@openai\/codex\//u.test(script ?? "")) return "codex";
  if (name === "claude" || /\/claude\/versions\/[^/]+$/u.test(executable) || /\/@anthropic-ai\/claude-code\//u.test(script ?? "")) return "claude-code";
  if (name === "pi" || ((name === "node" || name === "bun") && (commandName === "pi" || /\/@(?:earendil-works|mariozechner)\/pi-coding-agent\//u.test(script ?? "")))) return "pi";
  if (name === "opencode-v1") return "opencode-v1";
  if (name === "opencode-v2") return "opencode-v2";
  if (name === "opencode" || ((name === "node" || name === "bun") && /\/(?:opencode-ai|@opencode\/[^/]+)\//u.test(script ?? ""))) return "opencode";
  return null;
}

function interpreterScript(pid: number, procRoot: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(join(procRoot, String(pid), "cmdline"), constants.O_RDONLY);
    const data = Buffer.alloc(8192);
    const bytes = readSync(fd, data, 0, data.length, null);
    const args = data.subarray(0, bytes).toString("utf8").split("\0");
    const script = args[1];
    return script !== undefined && isAbsolute(script) && script.length <= 4096 ? script : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function snapshot(pid: number, options: ProcessOptions): ProcessSnapshot | null {
  const procRoot = options.procRoot ?? "/proc";
  const identity = readProcessIdentity(pid, options);
  if (!identity) return null;
  try {
    const stat = processStat(pid, procRoot);
    const status = readBounded(join(procRoot, String(pid), "status"), 16384);
    const uidField = /^Uid:\s+\d+\s+(\d+)/mu.exec(status)?.[1];
    if (!stat || uidField === undefined) return null;
    const executable = readlinkSync(join(procRoot, String(pid), "exe"));
    const commandName = readBounded(join(procRoot, String(pid), "comm"), 256).trim();
    const runtime = basename(executable);
    const script = runtime === "node" || runtime === "bun" ? interpreterScript(pid, procRoot) : null;
    const current = readProcessIdentity(pid, options);
    if (!current || !sameProcess(identity, current)) return null;
    return { identity, parentPid: stat.parentPid, uid: Number(uidField), harness: recognizedHarness(executable, commandName, script) };
  } catch { return null; }
}

function processRegistryDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env.HOTPLATE_PROCESS_REGISTRY;
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("Invalid process registry directory");
    return resolve(configured);
  }
  return join(env.XDG_STATE_HOME?.trim() || join(homedir(), ".local/state"), "hotplate/processes");
}

function privateRegistry(env: NodeJS.ProcessEnv, create: boolean): string | null {
  const directory = processRegistryDirectory(env);
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()) ? directory : null;
  } catch { return null; }
}

function identityKey(identity: ProcessIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.bootId, identity.pid, identity.startTicks])).digest("hex");
}

function registrationName(registration: ProcessRegistration): string {
  return `${identityKey(registration.process)}-${createHash("sha256").update(JSON.stringify([registration.host, registration.binding, registration.source])).digest("hex")}.json`;
}

function parseRegistration(value: unknown): ProcessRegistration | null {
  const fields = record(value);
  if (!fields || fields.version !== 1) return null;
  const identity = parseProcessIdentity(fields.process);
  const host = fields.host;
  if (!identity || (host !== "pi" && host !== "codex" && host !== "claude-code" && host !== "opencode-v1" && host !== "opencode-v2")) return null;
  const source = fields.source;
  if (source !== "in-process" && source !== "native-hook" && source !== "wrapper") return null;
  const binding = record(fields.binding);
  if (!binding) return null;
  if (binding.kind === "shared") return { version: 1, process: identity, host, source, binding: { kind: "shared" } };
  if (binding.kind !== "dedicated" || !identifier(binding.sessionId) || !identifier(binding.actorId) || !identifier(binding.projectCwd) || !isAbsolute(binding.projectCwd)) return null;
  return { version: 1, process: identity, host, source, binding: { kind: "dedicated", sessionId: binding.sessionId, actorId: binding.actorId, projectCwd: binding.projectCwd } };
}

export function registerHarnessProcess(input: RegistryOptions & {
  host: HarnessHost;
  process?: ProcessIdentity;
  pid?: number;
  binding: ProcessBinding;
  source: ProcessRegistration["source"];
}): ProcessRegistration | null {
  const identity = input.process ?? readProcessIdentity(input.pid ?? process.pid, input);
  if (!identity) return null;
  const current = snapshot(identity.pid, input);
  if (!current || !sameProcess(identity, current.identity) || (process.getuid !== undefined && current.uid !== process.getuid())) return null;
  const registration = parseRegistration({ version: 1, process: identity, host: input.host, binding: input.host === "codex" || input.host === "opencode-v1" || input.host === "opencode-v2" ? { kind: "shared" } : input.binding, source: input.source });
  if (!registration) return null;
  let temporary: string | undefined;
  try {
    const directory = privateRegistry(input.env ?? process.env, true);
    if (!directory) return null;
    const destination = join(directory, registrationName(registration));
    temporary = join(directory, `${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(registration)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
    return registration;
  } catch { return null; }
  finally { if (temporary !== undefined) { try { unlinkSync(temporary); } catch {} } }
}

export function unregisterHarnessProcess(registration: ProcessRegistration, options: RegistryOptions = {}): void {
  try {
    const directory = privateRegistry(options.env ?? process.env, false);
    if (directory) unlinkSync(join(directory, registrationName(registration)));
  } catch {}
}

function registrationsFor(identity: ProcessIdentity, options: RegistryOptions): ProcessRegistration[] {
  const matches: ProcessRegistration[] = [];
  try {
    const directory = privateRegistry(options.env ?? process.env, false);
    if (!directory) return matches;
    const prefix = `${identityKey(identity)}-`;
    for (const filename of readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).slice(0, 4096)) {
      let fd: number | undefined;
      try {
        const path = join(directory, filename);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) continue;
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const parsed = parseRegistration(JSON.parse(readFileSync(fd, "utf8")));
        if (parsed && sameProcess(identity, parsed.process) && filename === registrationName(parsed)) matches.push(parsed);
      } catch {}
      finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch {}
  return matches;
}

function matchingHost(expected: HarnessHost, actual: RecognizedHarness | null): boolean {
  return actual === expected || (actual === "opencode" && (expected === "opencode-v1" || expected === "opencode-v2"));
}

export function findHarnessAncestor(input: ProcessOptions & { host: HarnessHost; pid?: number }): ProcessIdentity | null {
  let pid = input.pid ?? process.ppid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const current = snapshot(pid, input);
    if (!current) return null;
    if (matchingHost(input.host, current.harness)) return current.identity;
    if (current.harness !== null) return null;
    pid = current.parentPid;
  }
  return null;
}

function unknownAttribution(kind: "unknown" | "non-agent"): ProcessAttribution {
  return { kind, host: "unknown", sessionId: null, actorId: null, projectCwd: null };
}

function registeredAttribution(registrations: readonly ProcessRegistration[]): ProcessAttribution {
  const first = registrations[0];
  if (!first) return unknownAttribution("unknown");
  const host = registrations.every((entry) => entry.host === first.host) ? first.host : "unknown";
  if (host === "codex" || host === "opencode-v1" || host === "opencode-v2" || host === "unknown" || first.binding.kind === "shared") return { kind: "harness", host, sessionId: null, actorId: null, projectCwd: null };
  const binding = first.binding;
  if (registrations.some((entry) => entry.binding.kind !== "dedicated" || entry.binding.sessionId !== binding.sessionId || entry.binding.actorId !== binding.actorId || entry.binding.projectCwd !== binding.projectCwd)) return { kind: "harness", host, sessionId: null, actorId: null, projectCwd: null };
  return { kind: "session", host, sessionId: binding.sessionId, actorId: binding.actorId, projectCwd: binding.projectCwd };
}

export function resolveProcessAttribution(identity: ProcessIdentity | null, options: RegistryOptions = {}): ProcessAttribution {
  if (!identity) return unknownAttribution("unknown");
  let pid = identity.pid;
  let childStart: bigint | null = null;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64 && pid > 0 && !seen.has(pid); depth++) {
    seen.add(pid);
    const current = snapshot(pid, options);
    if (!current) return unknownAttribution("unknown");
    if ((depth === 0 && !sameProcess(identity, current.identity)) || (childStart !== null && BigInt(current.identity.startTicks) > childStart)) return unknownAttribution("unknown");
    childStart = BigInt(current.identity.startTicks);
    const registrations = registrationsFor(current.identity, options);
    if (registrations.length > 0) return registeredAttribution(registrations);
    if (current.harness !== null) return { kind: "harness", host: current.harness === "opencode" ? "unknown" : current.harness, sessionId: null, actorId: null, projectCwd: null };
    pid = current.parentPid;
  }
  return unknownAttribution("unknown");
}
