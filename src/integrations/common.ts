import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { CaptureFact } from "../capture.js";
import type { NativeHostId, SkillRef } from "../domain.js";

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value) ? value : null;
}

export function skillAtPath(path: unknown, cwd: string): SkillRef | null {
  const candidate = text(path);
  if (!candidate || basename(candidate) !== "SKILL.md") return null;
  const canonicalPath = resolve(cwd, candidate);
  const name = basename(dirname(canonicalPath));
  return name ? { name, canonicalPath, version: null } : null;
}

export function hookContext(input: unknown, host: NativeHostId, observedAt: string): Omit<CaptureFact, "evidence"> | null {
  const hook = object(input);
  if (!hook) return null;
  const sessionId = text(hook.session_id);
  const cwd = text(hook.cwd);
  const occurrenceId = text(hook.tool_use_id);
  if (!sessionId || !cwd || !isAbsolute(cwd) || !occurrenceId) return null;
  const actorId = text(hook.agent_id) ?? sessionId;
  const turnId = host === "codex" ? text(hook.turn_id) : null;
  return {
    host, sessionId, actorId, occurrenceId, observedAt,
    scope: {
      projectCwd: cwd, sessionId, sessionFile: null, segmentId: actorId,
      segmentReason: "unknown", runId: turnId, turnId, leafId: null,
    },
  };
}
