import type { CaptureFact } from "../../capture.js";
import { object, reportOpenCodeUnavailable, sendOpenCodeFact, toolEvidence, toolScope, validContext, type OpenCodeContext } from "./bridge.js";

export function extractOpenCodeV1Fact(input: unknown, output: unknown, context: OpenCodeContext): CaptureFact | null {
  const event = object(input);
  const result = object(output);
  if (!event || !result || !validContext(context) || typeof event.sessionID !== "string" || typeof event.callID !== "string" || typeof result.output !== "string") return null;
  const evidence = toolEvidence(event.tool, event.args, event.callID, "success", context);
  if (!evidence) return null;
  return { host: "opencode-v1", sessionId: event.sessionID, actorId: event.sessionID, occurrenceId: event.callID, observedAt: context.observedAt ?? new Date().toISOString(), scope: toolScope(event.sessionID, context, null), evidence };
}

export default async function hotplate(context: { directory: string }) {
  return {
    "tool.execute.after": async (input: unknown, output: unknown) => {
      try {
        const fact = extractOpenCodeV1Fact(input, output, { projectCwd: context.directory });
        if (fact) await sendOpenCodeFact(fact);
      } catch { reportOpenCodeUnavailable(); }
    },
  };
}
