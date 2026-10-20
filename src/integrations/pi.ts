import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ReadDelivery, ReadPortion } from "../resource-domain.js";
import type { ReadTool, ToolOutcome } from "../tool-reads.js";
import { exitOutcome, nonnegativeInteger, object, requestedLines } from "./common.js";

export function normalizePiTool(event: ToolResultEvent, cwd: string): ReadTool | null {
  const outcome: ToolOutcome = { kind: event.isError ? "failed" : "succeeded" };
  if (event.toolName === "read") {
    if (typeof event.input.path !== "string") return { kind: "opaque", family: "file", outcome, reason: "missing-input" };
    const requested = requestedLines(event.input.offset, event.input.limit);
    const path = event.input.path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ").replace(/^@/u, "");
    return { kind: "file", path, requested, outcome,
      delivery: event.isError ? { kind: "unknown" } : readDelivery(event.details, requested) };
  }
  if (event.toolName === "bash") {
    const structured = "structuredContent" in event ? object(event.structuredContent) : null;
    const shellOutcome = event.isError ? outcome : structured && "exit_code" in structured ? exitOutcome(structured.exit_code) : outcome;
    return typeof event.input.command === "string"
      ? { kind: "shell", command: event.input.command, cwd, outcome: shellOutcome }
      : { kind: "opaque", family: "shell", outcome: shellOutcome, reason: "missing-input" };
  }
  if (event.toolName === "powershell") return { kind: "opaque", family: "shell", outcome, reason: "unsupported-syntax" };
  if (event.toolName === "python" || event.toolName === "python_exec" || event.toolName === "execute_python") {
    const customOutcome: ToolOutcome = { kind: event.isError ? "failed" : "unreported" };
    return typeof event.input.code === "string"
      ? { kind: "python", code: event.input.code, cwd, outcome: customOutcome }
      : { kind: "opaque", family: "python", outcome: customOutcome, reason: "missing-input" };
  }
  return null;
}

function readDelivery(details: unknown, requested: ReadPortion): ReadDelivery {
  const truncation = object(object(details)?.truncation);
  if (requested.kind !== "lines" || !truncation || typeof truncation.truncated !== "boolean"
    || !nonnegativeInteger(truncation.outputLines) || truncation.lastLinePartial !== false) return { kind: "unknown" };
  return { kind: "known", returned: { kind: "lines", start: requested.start, count: truncation.outputLines }, truncated: truncation.truncated };
}
