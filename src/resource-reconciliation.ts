import type { InventorySnapshotEvidence } from "./resource-domain.js";
import { inventoryResources, type ResourceInventoryResult } from "./resource-inventory.js";
import { createInventoryStage, type InventoryStageOptions, type SnapshotDigest } from "./resource-inventory-stage.js";
import type { ResourceRoot } from "./resource-paths.js";

type PublicationState =
  | { kind: "none" }
  | { kind: "published"; digest: SnapshotDigest }
  | { kind: "retry-required" };

export function createResourceReconciler(
  record: (evidence: InventorySnapshotEvidence) => Promise<void>,
  options: InventoryStageOptions = {},
): { scan(roots: readonly ResourceRoot[], signal: AbortSignal): Promise<ResourceInventoryResult> } {
  const publications = new Map<string, PublicationState>();
  return {
    async scan(roots, signal) {
      signal.throwIfAborted();
      const stage = createInventoryStage(options);
      try {
        const result = await inventoryResources({ roots, signal, record: evidence => stage.append(evidence) });
        signal.throwIfAborted();
        for (const snapshot of stage.snapshots()) {
          signal.throwIfAborted();
          const previous = publications.get(snapshot.key) ?? { kind: "none" };
          if (previous.kind === "published" && previous.digest.sha256 === snapshot.digest.sha256) continue;
          publications.set(snapshot.key, { kind: "retry-required" });
          let started: Extract<InventorySnapshotEvidence, { phase: "started" }> | null = null;
          let batchCount = 0;
          for (const evidence of snapshot.frames()) {
            if (signal.aborted) {
              if (started) await record({ ...started, phase: "incomplete", batchCount, error: "cancelled" });
              signal.throwIfAborted();
            }
            await record(evidence);
            if (evidence.phase === "started") started = evidence;
            if (evidence.phase === "batch") batchCount += 1;
          }
          publications.set(snapshot.key, { kind: "published", digest: snapshot.digest });
        }
        for (const key of publications.keys()) if (!stage.hasRoot(key)) publications.delete(key);
        return result;
      } finally {
        stage.close();
      }
    },
  };
}
