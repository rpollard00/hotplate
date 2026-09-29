import { basename, isAbsolute } from "node:path";
import type { CaptureFact } from "../../capture.js";
import { object, reportOpenCodeUnavailable, sendOpenCodeFact, toolEvidence, toolScope, validContext, type OpenCodeContext } from "./bridge.js";

type V2Context = OpenCodeContext & { skills?: readonly { id: string; name: string; path: string | null }[] };

export function extractOpenCodeV2Fact(input: unknown, context: V2Context): CaptureFact | null {
  const event = object(input);
  if (!event || !validContext(context) || typeof event.sessionID !== "string" || typeof event.id !== "string" || (event.status !== "completed" && event.status !== "error")) return null;
  if (event.status === "completed" ? !object(event.result) : !object(event.error)) return null;
  const args = object(event.input);
  const skill = context.skills?.find((entry) => entry.id === args?.id);
  const normalized = event.tool === "read" ? { filePath: args?.path } : { name: skill?.name ?? args?.id };
  const evidence = toolEvidence(event.tool, normalized, event.id, event.status === "completed" ? "success" : "error", context);
  if (evidence?.kind === "skill-invocation" && skill?.path && isAbsolute(skill.path) && basename(skill.path) === "SKILL.md") evidence.skill.canonicalPath = skill.path;
  if (!evidence) return null;
  return { host: "opencode-v2", sessionId: event.sessionID, actorId: event.sessionID, occurrenceId: event.id, observedAt: context.observedAt ?? new Date().toISOString(), scope: toolScope(event.sessionID, context, typeof event.messageID === "string" ? event.messageID : null), evidence };
}

type PluginContext = {
  tool: { hook(name: "execute.after", handler: (event: unknown) => Promise<void>): Promise<unknown> };
  session: { get(input: { sessionID: string }): Promise<unknown> };
  skill?: { list(input: { location: { directory: string } }): Promise<unknown> };
};

export default {
  id: "hotplate",
  async setup(context: PluginContext) {
    await context.tool.hook("execute.after", async (event: unknown) => {
      try {
        const input = object(event);
        if (!input || typeof input.sessionID !== "string" || (input.tool !== "read" && input.tool !== "skill")) return;
        const session = object(await bounded(context.session.get({ sessionID: input.sessionID })));
        const location = object(session?.location);
        if (typeof location?.directory !== "string") { reportOpenCodeUnavailable(); return; }
        const skills: { id: string; name: string; path: string | null }[] = [];
        if (input.tool === "skill" && context.skill) {
          const catalog = object(await bounded(context.skill.list({ location: { directory: location.directory } })));
          if (Array.isArray(catalog?.data)) for (const item of catalog.data) {
            const entry = object(item);
            if (typeof entry?.id === "string" && typeof entry.name === "string") skills.push({ id: entry.id, name: entry.name, path: typeof entry.path === "string" ? entry.path : null });
          }
        }
        const fact = extractOpenCodeV2Fact(event, { projectCwd: location.directory, skills });
        if (fact) await sendOpenCodeFact(fact);
      } catch { reportOpenCodeUnavailable(); }
    });
  },
};

async function bounded<T>(request: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([request, new Promise<null>((done) => { timer = setTimeout(() => done(null), 500); })]); }
  finally { clearTimeout(timer); }
}
