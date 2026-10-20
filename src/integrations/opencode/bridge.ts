import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { CaptureFact } from "../../capture.js";
import type { Evidence, ModelRef, ObservationScope } from "../../domain.js";
import type { ReadDelivery, ResourceLocation } from "../../resource-domain.js";
import type { ResourceRoot } from "../../resource-paths.js";
import type { SessionInventoryRequest } from "../../resource-session.js";
import type { ReadTool, ToolOutcome } from "../../tool-reads.js";
import { exitOutcome, positiveInteger, requestedLines, skillAtResource, toolReadFacts } from "../common.js";

export type OpenCodeContext = { projectCwd: string; observedAt?: string; model?: ModelRef; env?: NodeJS.ProcessEnv; roots?: readonly ResourceRoot[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function toolEvidence(tool: unknown, input: unknown, callId: string, outcome: "success" | "error", context: OpenCodeContext, resource: ResourceLocation | null): Extract<Evidence, { kind: "read-result" | "skill-invocation" }> | null {
  const args = object(input);
  if (!args) return null;
  if (tool === "skill" && typeof args.name === "string" && args.name.length > 0) {
    return { kind: "skill-invocation", skill: { name: args.name, canonicalPath: null, version: null }, toolCallId: callId, outcome, model: context.model ?? null };
  }
  if (tool !== "read") return null;
  const skill = skillAtResource(resource);
  return skill ? { kind: "read-result", skill, toolCallId: callId, outcome, model: context.model ?? null } : null;
}

export function openCodeToolFacts(fact: Omit<CaptureFact, "evidence">, input: {
  version: 1 | 2;
  name: unknown;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  failed: boolean;
}, context: OpenCodeContext, roots: readonly ResourceRoot[]): CaptureFact[] {
  const outcome: ToolOutcome = { kind: input.failed ? "failed" : "succeeded" };
  let tool: ReadTool;
  if (input.name === "read") {
    const path = input.version === 1 ? input.args.filePath : input.args.path;
    tool = typeof path === "string"
      ? { kind: "file", path, requested: requestedLines(input.args.offset, input.args.limit), outcome,
        delivery: input.version === 2 && !input.failed ? readDelivery(input.result?.output) : { kind: "unknown" } }
      : { kind: "opaque", family: "file", outcome, reason: "missing-input" };
  } else if (input.name === "bash" || (input.version === 2 && input.name === "shell")) {
    const metadata = object(input.result?.metadata);
    const output = object(input.result?.output);
    const shellOutcome: ToolOutcome = input.failed || output?.timeout === true || metadata?.timeout === true
      ? { kind: "failed" }
      : output?.status === "running" || metadata?.status === "running"
        ? { kind: "unreported" }
        : exitOutcome(input.version === 2 && output ? output.exit : metadata?.exit);
    tool = typeof input.args.command === "string"
      ? { kind: "shell", command: input.args.command, outcome: shellOutcome,
        cwd: typeof input.args.workdir === "string" ? resolve(context.projectCwd, input.args.workdir) : context.projectCwd }
      : { kind: "opaque", family: "shell", outcome: shellOutcome, reason: "missing-input" };
  } else {
    return [];
  }
  return toolReadFacts(fact, tool, roots, context.model ?? null);
}

function readDelivery(value: unknown): ReadDelivery {
  const output = object(value);
  if (output?.type !== "text-page" || output.truncated !== true || !positiveInteger(output.offset)
    || !positiveInteger(output.next) || output.next <= output.offset) return { kind: "unknown" };
  return { kind: "known", returned: { kind: "lines", start: output.offset, count: output.next - output.offset }, truncated: true };
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

export async function sendOpenCodeFacts(facts: readonly CaptureFact[], session?: Pick<SessionInventoryRequest, "host" | "sessionId" | "cwd" | "advertisedRoots" | "advertisements">): Promise<void> {
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
    child.stdin.end(JSON.stringify(session ? { session_id: session.sessionId, cwd: session.cwd, advertised_roots: session.advertisedRoots, advertisements: session.advertisements, facts } : facts));
  });
}
