import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { captureFact, parseCaptureFact, type CaptureFact } from "../capture.js";
import type { NativeHostId } from "../domain.js";
import { parseClaudeCodeHook } from "./claude-code.js";
import { parseCodexHook } from "./codex.js";
import { findHarnessAncestor, parseProcessIdentity, registerHarnessProcess } from "../process-attribution.js";
import { object, skillAtPath, text } from "./common.js";
import { launchSessionInventory, runSessionInventory, parseSessionInventoryRequest } from "../resource-session.js";
import { discoverResourceRoots, qualifyResource, type ResourceRoot } from "../resource-paths.js";

export function nativeHost(value: unknown): NativeHostId | null {
  return value === "codex" || value === "claude-code" || value === "opencode-v1" || value === "opencode-v2" ? value : null;
}

export async function runCaptureCommand(value: unknown): Promise<void> {
  const host = nativeHost(value);
  if (!host || process.env.HOTPLATE_DISABLED === "1" || process.env.HOTPLATE_DISABLED === "true") {
    process.stdin.destroy();
    return;
  }
  const harness = findHarnessAncestor({ host });
  await new Promise<void>((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", host], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, NODE_NO_WARNINGS: "1", HOTPLATE_HOOK_PROCESS: JSON.stringify(harness) } });
    let bytes = 0;
    let settled = false;
    const finish = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.unpipe(child.stdin);
      process.stdin.destroy();
      child.kill("SIGKILL");
      if (failed) process.stderr.write("Hotplate capture unavailable.\n");
      done();
    };
    const timer = setTimeout(() => finish(true), 750);
    child.once("error", () => finish(true));
    child.once("close", (code) => finish(code !== 0));
    child.stdin.on("error", () => finish(true));
    process.stdin.on("error", () => finish(true));
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) finish(true);
    });
    process.stdin.pipe(child.stdin);
  });
}

async function worker(host: NativeHostId): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Capture input too large");
    chunks.push(buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const hook = object(input);
  const facts = host === "codex" ? parseCodexHook(input) : host === "claude-code" ? parseClaudeCodeHook(input)
    : (Array.isArray(input) ? input : Array.isArray(hook?.facts) ? hook.facts : [input]).map(parseCaptureFact);
  const sessionId = text(hook?.session_id) ?? facts[0]?.sessionId ?? null;
  const cwd = text(hook?.cwd) ?? facts[0]?.scope.projectCwd;
  const actorId = text(hook?.agent_id) ?? facts[0]?.actorId ?? sessionId;
  const harness = parseProcessIdentity(JSON.parse(process.env.HOTPLATE_HOOK_PROCESS ?? "null"));
  const request = sessionId && cwd ? parseSessionInventoryRequest({ host, sessionId, cwd, harnessProcess: harness,
    ...(hook?.advertised_roots === undefined ? {} : { advertisedRoots: hook.advertised_roots }),
    ...(hook?.advertisements === undefined ? {} : { advertisements: hook.advertisements }) }) : null;
  if (harness) registerHarnessProcess({ host, process: harness, source: "native-hook", binding: host === "claude-code" && sessionId && actorId && cwd
    ? { kind: "dedicated", sessionId, actorId, projectCwd: cwd } : { kind: "shared" } });
  const scopes = new Map<string, readonly ResourceRoot[]>();
  for (const fact of facts) {
    if (fact.host !== host) throw new Error("Capture host mismatch");
    let local = fact;
    if (host === "opencode-v1" || host === "opencode-v2") {
      if (!isAbsolute(fact.scope.projectCwd)) throw new Error("Invalid capture project directory");
      if (hook?.facts !== undefined && request && (fact.sessionId !== request.sessionId || fact.scope.projectCwd !== request.cwd)) throw new Error("Capture session mismatch");
      const key = JSON.stringify([fact.sessionId, fact.scope.projectCwd]);
      let roots = scopes.get(key);
      if (!roots) {
        roots = discoverResourceRoots({ cwd: fact.scope.projectCwd, project: { host, boundary: { kind: "infer" } },
          ...(request?.advertisements ? { advertisements: request.advertisements } : {}),
          ...(request?.advertisedRoots ? { advertisedRoots: request.advertisedRoots } : {}) });
        scopes.set(key, roots);
      }
      const admitted = qualifyLocalFact(fact, roots);
      if (!admitted) continue;
      local = admitted;
    }
    const result = await captureFact({ fact: local });
    if (result.kind === "recorded" && result.dropped > 0) throw new Error("Capture commit unavailable");
  }
  if (request) launchSessionInventory(request);
}

function qualifyLocalFact(fact: CaptureFact, roots: readonly ResourceRoot[]): CaptureFact | null {
  const evidence = fact.evidence;
  switch (evidence.kind) {
    case "command-intent": return fact;
    case "tool-coverage": return fact;
    case "read-attempt":
    case "read-result": {
      const skill = skillAtPath(evidence.skill.canonicalPath, fact.scope.projectCwd, roots);
      return skill ? { ...fact, evidence: { ...evidence, skill: { ...evidence.skill, canonicalPath: skill.canonicalPath } } } : null;
    }
    case "skill-invocation": {
      const resource = evidence.skill.canonicalPath === null ? null : qualifyResource({ path: evidence.skill.canonicalPath, cwd: fact.scope.projectCwd, roots });
      return { ...fact, evidence: { ...evidence, skill: { ...evidence.skill, canonicalPath: resource?.canonicalPath ?? null } } };
    }
    case "catalog-snapshot": {
      const skills = evidence.skills.flatMap((candidate) => {
        const resource = qualifyResource({ path: candidate.canonicalPath, cwd: fact.scope.projectCwd, roots });
        return resource ? [{ ...candidate, canonicalPath: resource.canonicalPath }] : [];
      });
      return { ...fact, evidence: { ...evidence, skills } };
    }
    case "resource-access": {
      const resource = qualifyResource({ path: evidence.resource.observedPath, cwd: fact.scope.projectCwd, roots });
      return resource ? { ...fact, evidence: { ...evidence, resource } } : null;
    }
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--worker") {
  const host = nativeHost(process.argv[3]);
  if (!host) process.exitCode = 1;
  else worker(host).catch(() => { process.exitCode = 1; });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--inventory") {
  const timer = setTimeout(() => process.exit(1), 30000);
  const chunks: Buffer[] = [];
  void (async () => {
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error("Inventory input too large");
      chunks.push(buffer);
    }
    await runSessionInventory(parseSessionInventoryRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  })().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(timer));
}
