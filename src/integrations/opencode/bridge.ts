import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { CaptureFact } from "../../capture.js";
import type { Evidence, ModelRef, NativeHostId, ObservationScope } from "../../domain.js";

export type OpenCodeContext = { projectCwd: string; observedAt?: string; model?: ModelRef; env?: NodeJS.ProcessEnv };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function toolEvidence(tool: unknown, input: unknown, callId: string, outcome: "success" | "error", context: OpenCodeContext): Extract<Evidence, { kind: "read-result" | "skill-invocation" }> | null {
  const args = object(input);
  if (!args) return null;
  if (tool === "skill" && typeof args.name === "string" && args.name.length > 0) {
    return { kind: "skill-invocation", skill: { name: args.name, canonicalPath: null, version: null }, toolCallId: callId, outcome, model: context.model ?? null };
  }
  if (tool !== "read" || typeof args.filePath !== "string" || basename(args.filePath) !== "SKILL.md") return null;
  const canonicalPath = resolve(context.projectCwd, args.filePath);
  return { kind: "read-result", skill: { name: basename(dirname(canonicalPath)), canonicalPath, version: null }, toolCallId: callId, outcome, model: context.model ?? null };
}

export function toolScope(sessionId: string, context: OpenCodeContext, turnId: string | null): ObservationScope {
  return { projectCwd: context.projectCwd, sessionId, sessionFile: null, segmentId: sessionId, segmentReason: "unknown", runId: null, turnId, leafId: null };
}

export function validContext(context: OpenCodeContext): boolean {
  return isAbsolute(context.projectCwd);
}

let reportedUnavailable = false;

export function reportOpenCodeUnavailable(): void {
  if (reportedUnavailable) return;
  reportedUnavailable = true;
  process.stderr.write("Hotplate capture unavailable.\n");
}

export async function sendOpenCodeFact(fact: CaptureFact): Promise<void> {
  await sendOpenCodeFacts([fact]);
}

export async function sendOpenCodeFacts(facts: readonly CaptureFact[], session?: { host: NativeHostId; sessionId: string; cwd: string; advertisedRoots?: readonly string[] }): Promise<void> {
  const first = facts[0];
  const host = first?.host ?? session?.host;
  if (!host) return;
  await new Promise<void>((done) => {
    const child = spawn(process.env.HOTPLATE_NODE_BIN ?? "node", [fileURLToPath(new URL("../../cli.js", import.meta.url)), "capture", host], { stdio: ["pipe", "ignore", "pipe"], shell: false });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reportOpenCodeUnavailable(); done(); }, 750);
    child.stderr.on("data", () => reportOpenCodeUnavailable());
    const finish = () => { clearTimeout(timer); done(); };
    child.once("error", () => { reportOpenCodeUnavailable(); finish(); });
    child.once("close", (code) => { if (code !== 0) reportOpenCodeUnavailable(); finish(); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(session ? { session_id: session.sessionId, cwd: session.cwd, advertised_roots: session.advertisedRoots, facts } : facts));
  });
}
