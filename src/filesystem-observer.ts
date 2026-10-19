import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HostId } from "./domain.js";
import { parseProcessIdentity, readProcessIdentity, resolveProcessAttribution } from "./process-attribution.js";
import type { ObserverCoverageEvidence, ObserverCoverageReason, ProcessIdentity, ResourceAccessEvidence } from "./resource-domain.js";
import { admitResourcePath, qualifyResource, type ResourceRoot } from "./resource-paths.js";

export type FilesystemObservation = {
  evidence: ResourceAccessEvidence | ObserverCoverageEvidence;
  host: HostId;
  sessionId: string | null;
  projectCwd: string;
  observedAt: string;
};

export type FilesystemObserver = { observerId: string; done: Promise<void>; stop: () => Promise<void> };

type HelperMessage =
  | { type: "ready" }
  | { type: "unavailable"; reason: ObserverCoverageReason }
  | { type: "loss"; reason: "queue-overflow" | "process-exited" | "io-error" }
  | { type: "access"; path: string; access: "open" | "access"; process: ProcessIdentity | null; uid: number };

function parseMessage(value: unknown): HelperMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.fromEntries(Object.entries(value));
  if (fields.type === "ready" && fields.scopeVersion === 1) return { type: "ready" };
  if (fields.type === "unavailable" && (fields.reason === "permission-denied" || fields.reason === "unsupported" || fields.reason === "helper-unavailable" || fields.reason === "io-error")) return { type: "unavailable", reason: fields.reason };
  if (fields.type === "loss" && (fields.reason === "queue-overflow" || fields.reason === "process-exited" || fields.reason === "io-error")) return { type: "loss", reason: fields.reason };
  if (fields.type !== "access" || typeof fields.path !== "string" || !isAbsolute(fields.path) || fields.path.length > 4096 || fields.path.includes("\0") || (fields.access !== "open" && fields.access !== "access") || typeof fields.uid !== "number" || !Number.isSafeInteger(fields.uid) || fields.uid < 0) return null;
  const identity = parseProcessIdentity(fields.process);
  if (fields.process !== null && identity === null) return null;
  return { type: "access", path: fields.path, access: fields.access, process: identity, uid: fields.uid };
}

export function encodeFilesystemScope(roots: readonly ResourceRoot[]): Buffer {
  if (roots.length === 0 || roots.length > 1024) throw new Error("Invalid filesystem scope root count");
  const tokens = ["scope-v1"];
  let bytes = Buffer.byteLength(tokens[0] ?? "") + 1;
  const append = (...values: string[]): void => {
    for (const value of values) {
      const length = Buffer.byteLength(value);
      if (length === 0 || length > 4096 || value.includes("\0")) throw new Error("Invalid filesystem scope value");
      bytes += length + 1;
      if (bytes > 8 * 1024 * 1024) throw new Error("Filesystem scope exceeds the input limit");
      tokens.push(value);
    }
  };
  for (const root of roots) {
    const { extent, exclusions } = root.admission;
    if (admitResourcePath({ path: root.path, cwd: root.path, roots: [root], entry: extent === "tree" ? "directory" : "file" }).kind !== "accepted") {
      throw new Error("Filesystem scope root is no longer admitted");
    }
    if (exclusions.segments.length + exclusions.prefixes.length > 16) throw new Error("Too many filesystem scope exclusions");
    append("root", extent === "tree" ? "directory" : "file", root.canonicalPath);
    for (const [kind, rules] of [["segment", exclusions.segments], ["prefix", exclusions.prefixes]] as const) {
      for (const rule of rules) {
        if (isAbsolute(rule) || rule.split("/").some(component => component === "" || component === "." || component === "..") || (kind === "segment" && rule.includes("/"))) {
          throw new Error("Invalid filesystem scope exclusion");
        }
        append(kind, rule);
      }
    }
    append("end-root");
  }
  append("end-scope");
  return Buffer.from(`${tokens.join("\0")}\0`);
}

export function startFilesystemObserver(input: {
  roots: readonly ResourceRoot[];
  helperPath: string;
  env?: NodeJS.ProcessEnv;
  procRoot?: string;
  heartbeatMs?: number;
  onObservation: (observation: FilesystemObservation) => void | Promise<void>;
}): FilesystemObserver {
  const observerId = randomUUID();
  const heartbeatMs = input.heartbeatMs ?? 5000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 60_000) throw new Error("Invalid observer heartbeat interval");
  if (input.roots.length === 0) throw new Error("Filesystem observation requires at least one resource root");
  const env = input.env ?? process.env;
  const observerProcess = readProcessIdentity(process.pid);
  const groups = new Map<string, ResourceRoot[]>();
  const watchRoots: ResourceRoot[] = [];
  const invalidRoots: { root: ResourceRoot; reason: ObserverCoverageReason }[] = [];
  for (const root of input.roots) {
    const admission = admitResourcePath({ path: root.path, cwd: root.path, roots: [root], entry: root.admission.extent === "tree" ? "directory" : "file" });
    if (admission.kind === "rejected") {
      invalidRoots.push({ root, reason: admission.reason === "unreadable" ? "permission-denied" : "io-error" });
      continue;
    }
    watchRoots.push(root);
    const roots = groups.get(root.filesystemId) ?? [];
    roots.push(root);
    groups.set(root.filesystemId, roots);
  }
  let finish: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
  void done.catch(() => {});
  let child: ChildProcessWithoutNullStreams | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let phase: "starting" | "active" | "draining" | "stopping" | "ended" = "starting";
  let unavailable = false;
  let childClosed = false;
  let draining = false;
  let failure: Error | null = null;
  let sequence = 0;
  let overflowPending = false;
  const queue: FilesystemObservation[] = [];

  const settle = (): void => {
    if (!childClosed || draining || queue.length > 0 || phase === "ended") return;
    phase = "ended";
    if (heartbeat !== null) clearInterval(heartbeat);
    if (startupTimer !== null) clearTimeout(startupTimer);
    if (killTimer !== null) clearTimeout(killTimer);
    if (failure) reject(failure);
    else finish();
  };

  const terminate = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (startupTimer !== null) clearTimeout(startupTimer);
    if (!child || childClosed) { settle(); return; }
    child.stdout.resume();
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 1000);
    killTimer.unref();
  };

  const coverage = (state: Pick<Extract<ObserverCoverageEvidence, { status: "active" | "stopped" }>, "status" | "reason"> | Pick<Extract<ObserverCoverageEvidence, { status: "unavailable" | "overflow" }>, "status" | "reason">, selected = groups): void => {
    for (const [filesystemId, roots] of selected) {
      const root = roots[0];
      if (!root) continue;
      queue.push({
        host: "unknown", sessionId: null, projectCwd: "[unknown project]", observedAt: new Date().toISOString(),
        evidence: { kind: "observer-coverage", observerId, mechanism: "fanotify", filesystemId, rootPaths: roots.map((entry) => entry.canonicalPath), heartbeatMs, ...state },
      });
    }
    void drain();
  };

  const drain = async (): Promise<void> => {
    if (draining || failure) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) await input.onObservation(next);
        if (child?.stdout.isPaused() && queue.length < 128) child.stdout.resume();
      }
      overflowPending = false;
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error("Filesystem observation could not be persisted");
      queue.length = 0;
      phase = "stopping";
      terminate();
    } finally {
      draining = false;
      settle();
    }
  };

  const fail = (reason: ObserverCoverageReason): void => {
    if (unavailable || phase === "ended" || failure) return;
    unavailable = true;
    phase = "stopping";
    coverage({ status: "unavailable", reason });
    terminate();
  };

  const handle = (message: HelperMessage): void => {
    if (phase === "ended" || unavailable || failure) return;
    if (message.type === "ready") {
      if (phase === "stopping" || phase === "draining") return;
      if (phase !== "starting") { fail("io-error"); return; }
      phase = "active";
      if (startupTimer !== null) clearTimeout(startupTimer);
      coverage({ status: "active", reason: null });
      heartbeat = setInterval(() => { if (phase === "active" && queue.length < 256) coverage({ status: "active", reason: null }); }, heartbeatMs);
      heartbeat.unref();
      return;
    }
    if (message.type === "unavailable") { fail(message.reason); return; }
    if (phase !== "active" && phase !== "draining") { fail("io-error"); return; }
    if (message.type === "loss") {
      if (!overflowPending) { overflowPending = true; coverage({ status: "overflow", reason: message.reason }); }
      return;
    }
    if (message.uid !== process.getuid?.()) return;
    if (observerProcess !== null && message.process !== null && observerProcess.pid === message.process.pid && observerProcess.startTicks === message.process.startTicks && observerProcess.bootId === message.process.bootId) return;
    const resource = qualifyResource({ path: message.path, cwd: watchRoots[0]?.path ?? "/", roots: watchRoots });
    if (!resource) return;
    if (queue.length >= 512) {
      if (!overflowPending) { overflowPending = true; coverage({ status: "overflow", reason: "queue-overflow" }); }
      return;
    }
    const attribution = resolveProcessAttribution(message.process, { env, ...input.procRoot === undefined ? {} : { procRoot: input.procRoot } });
    const evidence: ResourceAccessEvidence = {
      kind: "resource-access", resource, operationId: `${observerId}:${++sequence}`, mechanism: "fanotify", access: message.access,
      outcome: "unknown", model: null, process: message.process, attribution: attribution.kind,
    };
    queue.push({ evidence, host: attribution.host, sessionId: attribution.sessionId, projectCwd: attribution.projectCwd ?? "[unknown project]", observedAt: new Date().toISOString() });
    if (queue.length >= 256) child?.stdout.pause();
    void drain();
  };

  const stop = async (): Promise<void> => {
    if (phase !== "ended" && phase !== "stopping" && phase !== "draining") {
      phase = phase === "active" ? "draining" : "stopping";
      terminate();
    }
    return done;
  };

  const uid = process.getuid?.();
  for (const { root, reason } of invalidRoots) coverage({ status: "unavailable", reason }, new Map([[root.filesystemId, [root]]]));
  if (watchRoots.length === 0 || failure) {
    childClosed = true;
    settle();
    return { observerId, done, stop };
  }
  if (process.platform !== "linux" || uid === undefined) {
    childClosed = true;
    fail("unsupported");
    return { observerId, done, stop };
  }
  let policy: Buffer;
  try { policy = encodeFilesystemScope(watchRoots); }
  catch { childClosed = true; fail("io-error"); return { observerId, done, stop }; }
  child = spawn(input.helperPath, ["--uid", String(uid)], { stdio: ["pipe", "pipe", "pipe"], env });
  startupTimer = setTimeout(() => fail("helper-unavailable"), 5000);
  startupTimer.unref();
  child.stdin.on("error", () => fail("io-error"));
  child.stdin.end(policy);
  child.stderr.resume();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (phase === "ended" || unavailable || failure) return;
    pending += decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 32_768) { fail("io-error"); return; }
      let message: HelperMessage | null = null;
      try { message = parseMessage(JSON.parse(line)); } catch {}
      if (!message) { fail("io-error"); return; }
      handle(message);
    }
    if (pending.length > 32_768) fail("io-error");
  });
  child.once("error", () => fail("helper-unavailable"));
  child.once("close", (code) => {
    childClosed = true;
    pending += decoder.end();
    if (pending.length > 0 && !unavailable && !failure) fail("io-error");
    if (!unavailable && !failure) {
      if ((phase === "stopping" || phase === "draining") && code === 0) coverage({ status: "stopped", reason: null });
      else fail("process-exited");
    }
    settle();
  });
  return { observerId, done, stop };
}
