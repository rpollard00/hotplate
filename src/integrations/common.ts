import { basename, dirname, isAbsolute } from "node:path";
import type { CaptureFact } from "../capture.js";
import type { ModelRef, NativeHostId, SkillRef } from "../domain.js";
import type { ReadPortion, ResourceLocation } from "../resource-domain.js";
import { qualifyResource, type ResourceRoot } from "../resource-paths.js";
import { shellGlob } from "../shell-glob.js";
import { captureToolReads, type ReadTool, type ToolOutcome } from "../tool-reads.js";

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value) ? value : null;
}

export function requestedLines(offset: unknown, limit: unknown): ReadPortion {
  const start = offset === undefined ? 1 : offset;
  const count = limit === undefined ? null : limit;
  if (!positiveInteger(start) || (count !== null && !positiveInteger(count))) return { kind: "unknown" };
  return { kind: "lines", start, count };
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function exitOutcome(exitCode: unknown): ToolOutcome {
  return typeof exitCode === "number" && Number.isSafeInteger(exitCode)
    ? { kind: exitCode === 0 ? "succeeded" : "failed" } : { kind: "unreported" };
}

export function toolReadFacts(context: Omit<CaptureFact, "evidence">, tool: ReadTool, roots: readonly ResourceRoot[], model: ModelRef = null): CaptureFact[] {
  return captureToolReads({ operationId: context.occurrenceId, tool, context: {
    cwd: context.scope.projectCwd, roots, model, process: null, glob: shellGlob,
    attribution: context.sessionId === null ? "harness" : "session",
  } }).map((evidence) => ({ ...context, evidence }));
}

export function skillAtPath(path: unknown, cwd: string, roots: readonly ResourceRoot[]): SkillRef | null {
  const candidate = text(path);
  return candidate ? skillAtResource(qualifyResource({ path: candidate, cwd, roots })) : null;
}

export function skillAtResource(resource: ResourceLocation | null): SkillRef | null {
  if (!resource || basename(resource.observedPath) !== "SKILL.md") return null;
  const name = basename(dirname(resource.canonicalPath));
  return name ? { name, canonicalPath: resource.canonicalPath, version: null } : null;
}

export function hookContext(input: unknown, host: NativeHostId, observedAt: string): Omit<CaptureFact, "evidence"> | null {
  const hook = object(input);
  if (!hook) return null;
  const sessionId = text(hook.session_id);
  const cwd = text(hook.cwd);
  const occurrenceId = text(hook.tool_use_id);
  if (!cwd || !isAbsolute(cwd) || !occurrenceId) return null;
  const actorId = text(hook.agent_id) ?? sessionId ?? `unattributed:${occurrenceId}`;
  const turnId = host === "codex" ? text(hook.turn_id) : null;
  return {
    host, sessionId, actorId, occurrenceId, observedAt,
    scope: {
      projectCwd: cwd, sessionId, sessionFile: null, segmentId: actorId,
      segmentReason: "unknown", runId: turnId, turnId, leafId: null,
    },
  };
}
