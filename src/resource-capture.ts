import { randomUUID } from "node:crypto";
import type { HostId, HotplateStore, ObservationScope } from "./domain.js";
import type { ResourceEvidence } from "./resource-domain.js";
import { readNativeAccountConfiguration } from "./integrations/native-settings.js";
import { openCaptureStore, openHotplateStore, resolveHotplateDatabasePath } from "./store.js";

export type ResourceEvent = {
  evidence: ResourceEvidence;
  host?: HostId;
  sessionId?: string | null;
  projectCwd?: string;
  observedAt?: string;
};

export function openResourceRecorder(options: { cwd: string; env?: NodeJS.ProcessEnv; databasePath?: string }): {
  record(event: ResourceEvent): Promise<void>;
  close(): Promise<void>;
} {
  const env = options.env ?? process.env;
  const configuration = options.databasePath ? null : readNativeAccountConfiguration(env);
  const store: HotplateStore = options.databasePath
    ? openHotplateStore({ databasePath: options.databasePath })
    : configuration ? openCaptureStore(configuration) : openHotplateStore({ databasePath: resolveHotplateDatabasePath({ env }) });
  const producerId = `resources:${randomUUID()}`;
  let sequence = 0;
  return {
    async record(event) {
      const scope: ObservationScope = {
        projectCwd: event.projectCwd ?? options.cwd,
        sessionId: event.sessionId ?? null,
        sessionFile: null,
        segmentId: producerId,
        segmentReason: "unknown",
        runId: null,
        turnId: null,
        leafId: null,
      };
      sequence += 1;
      const result = await store.record({
        id: `${producerId}:${sequence}`, producerId, sequence,
        host: event.host ?? "unknown",
        observedAt: event.observedAt ?? new Date().toISOString(),
        scope, evidence: event.evidence,
      });
      if (result.dropped) throw new Error("Hotplate could not persist resource evidence");
    },
    close: () => store.close(),
  };
}
