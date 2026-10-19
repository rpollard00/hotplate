import { basename, dirname, isAbsolute } from "node:path";
import type { CaptureFact } from "../capture.js";
import type { NativeHostId, SkillRef } from "../domain.js";
import type { ResourceAccessEvidence, ResourceLocation } from "../resource-domain.js";
import { qualifyResource, type ResourceRoot } from "../resource-paths.js";

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value) ? value : null;
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

export function resourceFact(context: Omit<CaptureFact, "evidence">, path: unknown, options: {
  access: "read" | "attempt";
  outcome: ResourceAccessEvidence["outcome"];
  roots: readonly ResourceRoot[];
}): (Omit<CaptureFact, "evidence"> & { evidence: ResourceAccessEvidence }) | null {
  const value = text(path);
  if (!value) return null;
  const resource = qualifyResource({ path: value, cwd: context.scope.projectCwd, roots: options.roots });
  if (!resource) return null;
  return { ...context, evidence: {
    kind: "resource-access", resource, operationId: context.occurrenceId,
    mechanism: "host-tool", access: options.access, outcome: options.outcome, model: null, process: null,
    attribution: context.sessionId === null ? "harness" : "session",
  } };
}
