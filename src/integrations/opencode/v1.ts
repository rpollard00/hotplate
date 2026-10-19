import type { CaptureFact } from "../../capture.js";
import { registerHarnessProcess } from "../../process-attribution.js";
import { discoverResourceRoots } from "../../resource-paths.js";
import { resourceFact } from "../common.js";
import { object, reportOpenCodeUnavailable, sendOpenCodeFacts, toolEvidence, toolScope, validContext, type OpenCodeContext } from "./bridge.js";

export function extractOpenCodeV1Fact(input: unknown, output: unknown, context: OpenCodeContext): CaptureFact | null {
  return extractOpenCodeV1Facts(input, output, context)[0] ?? null;
}

export function extractOpenCodeV1Facts(input: unknown, output: unknown, context: OpenCodeContext): readonly CaptureFact[] {
  const event = object(input);
  const result = object(output);
  if (!event || !result || !validContext(context) || typeof event.sessionID !== "string" || typeof event.callID !== "string" || typeof result.output !== "string") return [];
  const fact = { host: "opencode-v1", sessionId: event.sessionID, actorId: event.sessionID, occurrenceId: event.callID, observedAt: context.observedAt ?? new Date().toISOString(), scope: toolScope(event.sessionID, context, null) } satisfies Omit<CaptureFact, "evidence">;
  const roots = context.roots ?? discoverResourceRoots({ cwd: context.projectCwd, project: { host: "opencode-v1", boundary: { kind: "infer" } }, ...(context.env ? { env: context.env } : {}) });
  const resource = event.tool === "read" ? resourceFact(fact, object(event.args)?.filePath, { access: "read", outcome: "success", roots }) : null;
  const evidence = toolEvidence(event.tool, event.args, event.callID, "success", context, resource?.evidence.resource ?? null);
  const facts: CaptureFact[] = evidence ? [{ ...fact, evidence }] : [];
  if (resource) { resource.evidence.model = context.model ?? null; facts.push(resource); }
  return facts;
}

export default async function hotplate(context: { directory: string }) {
  if (process.env.HOTPLATE_DISABLED !== "1" && process.env.HOTPLATE_DISABLED !== "true") registerHarnessProcess({ host: "opencode-v1", binding: { kind: "shared" }, source: "in-process" });
  return {
    "tool.execute.after": async (input: unknown, output: unknown) => {
      try {
        const facts = extractOpenCodeV1Facts(input, output, { projectCwd: context.directory });
        const event = object(input);
        await sendOpenCodeFacts(facts, typeof event?.sessionID === "string" ? { host: "opencode-v1", sessionId: event.sessionID, cwd: context.directory } : undefined);
      } catch { reportOpenCodeUnavailable(); }
    },
  };
}
