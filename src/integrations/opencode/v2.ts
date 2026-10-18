import { basename, dirname, isAbsolute } from "node:path";
import type { CaptureFact } from "../../capture.js";
import { registerHarnessProcess } from "../../process-attribution.js";
import { resourceFact } from "../common.js";
import { discoverResourceRoots, resourceFilesystemId } from "../../resource-paths.js";
import { publishResourceRoots } from "../../resource-root-registry.js";
import { object, reportOpenCodeUnavailable, sendOpenCodeFacts, toolEvidence, toolScope, validContext, type OpenCodeContext } from "./bridge.js";

type V2Context = OpenCodeContext & { skills?: readonly { id: string; name: string; path: string | null }[] };

export function extractOpenCodeV2Fact(input: unknown, context: V2Context): CaptureFact | null {
  return extractOpenCodeV2Facts(input, context)[0] ?? null;
}

export function extractOpenCodeV2Facts(input: unknown, context: V2Context): readonly CaptureFact[] {
  const event = object(input);
  if (!event || !validContext(context) || typeof event.sessionID !== "string" || typeof event.id !== "string" || (event.status !== "completed" && event.status !== "error")) return [];
  if (event.status === "completed" ? !object(event.result) : !object(event.error)) return [];
  const args = object(event.input);
  const skill = context.skills?.find((entry) => entry.id === args?.id);
  const normalized = event.tool === "read" ? { filePath: args?.path } : { name: skill?.name ?? args?.id };
  const evidence = toolEvidence(event.tool, normalized, event.id, event.status === "completed" ? "success" : "error", context);
  if (evidence?.kind === "skill-invocation" && skill?.path && isAbsolute(skill.path) && basename(skill.path) === "SKILL.md") evidence.skill.canonicalPath = skill.path;
  const fact = { host: "opencode-v2", sessionId: event.sessionID, actorId: event.sessionID, occurrenceId: event.id, observedAt: context.observedAt ?? new Date().toISOString(), scope: toolScope(event.sessionID, context, typeof event.messageID === "string" ? event.messageID : null) } satisfies Omit<CaptureFact, "evidence">;
  const facts: CaptureFact[] = evidence ? [{ ...fact, evidence }] : [];
  if (event.tool === "read") {
    const roots = discoverResourceRoots({ cwd: context.projectCwd, advertisedRoots: catalogRoots(context.skills ?? []), ...(context.env ? { env: context.env } : {}) });
    const resource = resourceFact(fact, normalized.filePath, { access: "read", outcome: event.status === "completed" ? "success" : "error", roots });
    if (resource?.evidence.kind === "resource-access") { resource.evidence.model = context.model ?? null; facts.push(resource); }
  }
  return facts;
}

type PluginContext = {
  tool: { hook(name: "execute.after", handler: (event: unknown) => Promise<void>): Promise<unknown> };
  session: { get(input: { sessionID: string }): Promise<unknown> };
  skill?: { list(input: { location: { directory: string } }): Promise<unknown> };
};

export default {
  id: "hotplate",
  async setup(context: PluginContext) {
    if (process.env.HOTPLATE_DISABLED !== "1" && process.env.HOTPLATE_DISABLED !== "true") registerHarnessProcess({ host: "opencode-v2", binding: { kind: "shared" }, source: "in-process" });
    const catalogs = new Map<string, NonNullable<V2Context["skills"]>>();
    await context.tool.hook("execute.after", async (event: unknown) => {
      if (process.env.HOTPLATE_DISABLED === "1" || process.env.HOTPLATE_DISABLED === "true") return;
      try {
        const input = object(event);
        if (!input || typeof input.sessionID !== "string") return;
        const session = object(await bounded(context.session.get({ sessionID: input.sessionID })));
        const location = object(session?.location);
        if (typeof location?.directory !== "string") { reportOpenCodeUnavailable(); return; }
        const key = JSON.stringify([input.sessionID, location.directory]);
        let skills = catalogs.get(key);
        if (!skills && context.skill) {
          const catalog = object(await bounded(context.skill.list({ location: { directory: location.directory } })));
          if (Array.isArray(catalog?.data)) {
            const loaded: { id: string; name: string; path: string | null }[] = [];
            for (const item of catalog.data) {
              const entry = object(item);
              if (typeof entry?.id === "string" && typeof entry.name === "string") loaded.push({ id: entry.id, name: entry.name, path: typeof entry.path === "string" ? entry.path : null });
            }
            skills = loaded;
            if (catalogs.size >= 256) {
              const oldest = catalogs.keys().next().value;
              if (oldest !== undefined) catalogs.delete(oldest);
            }
            catalogs.set(key, skills);
          }
        }
        const advertisedRoots = catalogRoots(skills ?? []);
        if (!publishResourceRoots({ host: "opencode-v2", sessionId: input.sessionID, filesystemId: resourceFilesystemId(), roots: advertisedRoots })) reportOpenCodeUnavailable();
        const conventionalRoots = discoverResourceRoots({ cwd: location.directory, advertisedRoots }).filter((root) => root.origin === "conventional" && (root.scope === "account" || root.scope === "project"));
        if (!publishResourceRoots({ host: "opencode-v2", sessionId: input.sessionID, filesystemId: resourceFilesystemId(), origin: "conventional", roots: conventionalRoots.map((root) => root.path) })) reportOpenCodeUnavailable();
        const facts = extractOpenCodeV2Facts(event, { projectCwd: location.directory, skills: skills ?? [] });
        await sendOpenCodeFacts(facts, { host: "opencode-v2", sessionId: input.sessionID, cwd: location.directory, advertisedRoots });
      } catch { reportOpenCodeUnavailable(); }
    });
  },
};

function catalogRoots(skills: NonNullable<V2Context["skills"]>): readonly string[] {
  return [...new Set(skills.flatMap((skill) => skill.path && isAbsolute(skill.path) && basename(skill.path) === "SKILL.md" ? [dirname(skill.path)] : []))];
}

async function bounded<T>(request: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([request, new Promise<null>((done) => { timer = setTimeout(() => done(null), 500); })]); }
  finally { clearTimeout(timer); }
}
