import { createHash } from "node:crypto";
import type { InventorySnapshotEvidence } from "./resource-domain.js";
import { inventoryResources, type ResourceInventoryResult } from "./resource-inventory.js";
import type { ResourceRoot } from "./resource-paths.js";

export function createResourceReconciler(record: (evidence: InventorySnapshotEvidence) => Promise<void>): {
  scan(roots: readonly ResourceRoot[], signal: AbortSignal): Promise<ResourceInventoryResult>;
} {
  const previous = new Map<string, string>();
  return {
    async scan(roots, signal) {
      const snapshots = new Map<string, InventorySnapshotEvidence[]>();
      let bytes = 0;
      let streaming = false;
      const result = await inventoryResources({ roots, signal, record: async evidence => {
        if (streaming) { await record(evidence); return; }
        const key = JSON.stringify([evidence.filesystemId, evidence.rootPath]);
        const events = snapshots.get(key) ?? [];
        events.push(evidence);
        snapshots.set(key, events);
        bytes += Buffer.byteLength(JSON.stringify(evidence));
        if (bytes > 8 * 1024 * 1024) {
          for (const entries of snapshots.values()) for (const entry of entries) await record(entry);
          snapshots.clear();
          previous.clear();
          streaming = true;
        }
      } });
      if (streaming) return result;
      for (const [key, events] of snapshots) {
        const terminal = events.at(-1);
        if (!terminal || (terminal.phase !== "complete" && terminal.phase !== "incomplete")) continue;
        const resources = events.flatMap(event => event.resources).map(resource => JSON.stringify(resource)).sort();
        const digest = createHash("sha256").update(JSON.stringify([
          terminal.origin, terminal.scope, terminal.phase, terminal.error, resources,
        ])).digest("hex");
        if (previous.get(key) === digest) continue;
        for (const evidence of events) await record(evidence);
        previous.set(key, digest);
      }
      for (const key of previous.keys()) if (!snapshots.has(key)) previous.delete(key);
      return result;
    },
  };
}
