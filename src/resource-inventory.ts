import { createHash, randomUUID } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { InventoryError, InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";
import { admitResourcePath, narrowResourceRoot, pathWithin, qualifyResource, type ResourceDiagnostic, type ResourceRoot } from "./resource-paths.js";

type InventoryScanResult = {
  root: ResourceRoot;
  scanId: string;
  resourceCount: number;
  batchCount: number;
} & ({ status: "complete" } | { status: "incomplete"; error: InventoryError });

export type ResourceInventoryResult = { roots: readonly ResourceRoot[]; observationRoots: readonly ResourceRoot[]; scans: readonly InventoryScanResult[] };

type Snapshot = {
  root: ResourceRoot;
  scanId: string;
  resources: ResourceLocation[];
  bytes: number;
  batchCount: number;
  resourceCount: number;
  error: InventoryError | null;
};

export async function inventoryResources(options: {
  roots: readonly ResourceRoot[];
  record: (evidence: InventorySnapshotEvidence, root: ResourceRoot) => void | Promise<void>;
  scanId?: string;
  batchSize?: number;
  maxEntries?: number;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: ResourceDiagnostic) => void;
}): Promise<ResourceInventoryResult> {
  const batchSize = boundedInteger(options.batchSize ?? 64, 1, 256, "batchSize");
  const maxEntries = boundedInteger(options.maxEntries ?? 100000, 1, 1000000, "maxEntries");
  const record = async (evidence: InventorySnapshotEvidence, root: ResourceRoot): Promise<void> => {
    try { await options.record(evidence, root); } catch (error) { throw new RecordFailure(error); }
  };
  const representatives = new Map<string, ResourceRoot>();
  const observationRoots = [...options.roots];
  for (const root of [...options.roots].sort(compareRoots)) {
    const key = rootKey(root);
    if (!representatives.has(key)) representatives.set(key, root);
  }
  const snapshots: Snapshot[] = [...representatives].map(([identity, root]) => ({ root,
    scanId: options.scanId === undefined ? randomUUID() : `${options.scanId}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    resources: [], bytes: 0, batchCount: 0, resourceCount: 0, error: null,
  }));
  let bufferedBytes = 0;
  const common = (snapshot: Snapshot) => ({ kind: "inventory-snapshot", scanId: snapshot.scanId, filesystemId: snapshot.root.filesystemId,
    rootPath: snapshot.root.canonicalPath, origin: snapshot.root.origin, scope: snapshot.root.scope } satisfies Pick<InventorySnapshotEvidence, "kind" | "scanId" | "filesystemId" | "rootPath" | "origin" | "scope">);
  const flush = async (snapshot: Snapshot): Promise<void> => {
    if (snapshot.resources.length === 0) return;
    await record({ ...common(snapshot), phase: "batch", resources: snapshot.resources, batchIndex: snapshot.batchCount, error: null }, snapshot.root);
    snapshot.batchCount += 1;
    snapshot.resources = [];
    bufferedBytes -= snapshot.bytes;
    snapshot.bytes = 0;
  };
  const report = (root: ResourceRoot, path: string, canonicalPath: string | null, reason: ResourceDiagnostic["reason"]): void => {
    options.onDiagnostic?.({ path, canonicalPath, reason, relatedPaths: [root.path] });
  };
  const affected = (root: ResourceRoot, canonicalPath: string): Snapshot[] => snapshots.filter(snapshot => snapshot.root.filesystemId === root.filesystemId
    && (pathWithin(canonicalPath, snapshot.root.canonicalPath) || pathWithin(snapshot.root.canonicalPath, canonicalPath)));
  const fail = (root: ResourceRoot, canonicalPath: string, error: InventoryError): void => {
    for (const snapshot of affected(root, canonicalPath)) snapshot.error ??= error;
  };
  const deviceBoundary = (root: ResourceRoot, path: string, entry: "directory" | "file"): boolean => {
    const narrowed = narrowResourceRoot({ root, path, entry });
    if (!narrowed) { fail(root, root.canonicalPath, "io-error"); return false; }
    const known = observationRoots.some(candidate => candidate.filesystemId === narrowed.filesystemId && candidate.canonicalPath === narrowed.canonicalPath
      && admitResourcePath({ path: candidate.path, cwd: candidate.path, roots: [candidate], entry }).kind === "accepted");
    if (!known) observationRoots.push(narrowed);
    return true;
  };
  const directories = new Set<string>();
  const files = new Set<string>();
  let entries = 0;
  let memberships = 0;
  let stopped: "limit" | "cancelled" | null = null;
  const stop = (): boolean => {
    if (options.signal?.aborted) stopped = "cancelled";
    return stopped !== null;
  };
  const file = async (root: ResourceRoot, path: string, parentDevice?: number): Promise<void> => {
    const admission = admitResourcePath({ path, cwd: root.path, roots: [root], entry: "file" });
    if (admission.kind === "rejected") {
      if (admission.reason !== "excluded" && admission.reason !== "escaping-link") fail(root, root.canonicalPath,
        admission.reason === "missing" || admission.reason === "unreadable" || admission.reason === "limit" ? admission.reason : "io-error");
      return;
    }
    const identity = JSON.stringify([root.filesystemId, admission.canonicalPath]);
    if (files.has(identity)) return;
    if (files.size + directories.size >= maxEntries) { stopped = "limit"; return; }
    try {
      const device = (await stat(path)).dev;
      if (parentDevice !== undefined && device !== parentDevice && !deviceBoundary(root, path, "file")) return;
    } catch (error) { fail(root, admission.canonicalPath, inventoryError(error)); return; }
    files.add(identity);
    for (const snapshot of snapshots) {
      if (snapshot.root.filesystemId !== root.filesystemId || !pathWithin(admission.canonicalPath, snapshot.root.canonicalPath)) continue;
      const observedPath = join(snapshot.root.path, relative(snapshot.root.canonicalPath, admission.canonicalPath));
      const resource = qualifyResource({ path: observedPath, cwd: snapshot.root.path, roots: [snapshot.root] });
      if (!resource) continue;
      if (memberships >= maxEntries) { stopped = "limit"; return; }
      const bytes = Buffer.byteLength(JSON.stringify(resource));
      if (snapshot.resources.length >= batchSize || snapshot.bytes + bytes > 262144) await flush(snapshot);
      if (bufferedBytes + bytes > 262144) for (const pending of snapshots) {
        await flush(pending);
        if (bufferedBytes + bytes <= 262144) break;
      }
      snapshot.resources.push(resource);
      snapshot.bytes += bytes;
      bufferedBytes += bytes;
      snapshot.resourceCount += 1;
      memberships += 1;
    }
  };
  const directory = async (root: ResourceRoot, path: string, depth: number, parentDevice?: number): Promise<void> => {
    if (stop()) return;
    if (depth > 256) { stopped = "limit"; return; }
    const admission = admitResourcePath({ path, cwd: root.path, roots: [root], entry: "directory" });
    if (admission.kind === "rejected") {
      if (admission.reason === "excluded" || admission.reason === "escaping-link") report(root, path, null, admission.reason);
      else fail(root, root.canonicalPath, admission.reason === "missing" || admission.reason === "unreadable" || admission.reason === "limit" ? admission.reason : "io-error");
      return;
    }
    const identity = JSON.stringify([root.filesystemId, admission.canonicalPath]);
    if (directories.has(identity)) return;
    if (files.size + directories.size >= maxEntries) { stopped = "limit"; return; }
    directories.add(identity);
    let handle: Awaited<ReturnType<typeof opendir>>;
    let device: number;
    try {
      device = (await stat(path)).dev;
      if (parentDevice !== undefined && device !== parentDevice && !deviceBoundary(root, path, "directory")) return;
      handle = await opendir(path);
    }
    catch (error) { fail(root, admission.canonicalPath, inventoryError(error)); return; }
    try {
      for await (const entry of handle) {
        if (stop()) return;
        if (entries >= maxEntries) { stopped = "limit"; return; }
        entries += 1;
        const child = join(path, entry.name);
        if (entry.isDirectory()) await directory(root, child, depth + 1, device);
        else if (entry.isFile()) await file(root, child, device);
        else if (entry.isSymbolicLink()) {
          const target = admitResourcePath({ path: child, cwd: root.path, roots: [root], entry: "directory" });
          if (target.kind === "accepted") await directory(root, child, depth + 1, device);
          else if (target.reason === "not-file") await file(root, child, device);
          else if (target.reason === "escaping-link" || target.reason === "excluded") {
            if (!options.roots.some(candidate => candidate.path === child)) report(root, child, null, target.reason);
          }
          else fail(root, admission.canonicalPath, target.reason === "missing" || target.reason === "unreadable" || target.reason === "limit" ? target.reason : "io-error");
        }
      }
    } catch (error) {
      if (error instanceof RecordFailure) throw error;
      fail(root, admission.canonicalPath, inventoryError(error));
    }
  };
  try {
    for (const snapshot of snapshots) await record({ ...common(snapshot), phase: "started", resources: [], error: null }, snapshot.root);
    for (const snapshot of snapshots) {
      if (stop()) break;
      if (snapshot.root.admission.extent === "file") await file(snapshot.root, snapshot.root.path);
      else await directory(snapshot.root, snapshot.root.path, 0);
    }
    const scans: InventoryScanResult[] = [];
    for (const snapshot of snapshots) {
      if (stop()) snapshot.error ??= stopped;
      if (snapshot.error === "limit") report(snapshot.root, snapshot.root.path, snapshot.root.canonicalPath, "limit");
      await flush(snapshot);
      const result = { root: snapshot.root, scanId: snapshot.scanId, resourceCount: snapshot.resourceCount, batchCount: snapshot.batchCount };
      if (snapshot.error === null) {
        await record({ ...common(snapshot), phase: "complete", resources: [], batchCount: snapshot.batchCount, error: null }, snapshot.root);
        scans.push({ ...result, status: "complete" });
      } else {
        await record({ ...common(snapshot), phase: "incomplete", resources: [], batchCount: snapshot.batchCount, error: snapshot.error }, snapshot.root);
        scans.push({ ...result, status: "incomplete", error: snapshot.error });
      }
    }
    return { roots: options.roots, observationRoots: observationRoots.sort(compareRoots), scans };
  } catch (error) { if (error instanceof RecordFailure) throw error.failure; throw error; }
}

class RecordFailure extends Error {
  constructor(readonly failure: unknown) { super("Inventory recording failed."); }
}

function inventoryError(error: unknown): InventoryError {
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOENT") return "missing";
    if (error.code === "EACCES" || error.code === "EPERM") return "unreadable";
  }
  return "io-error";
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid inventory ${name}.`);
  return value;
}

function rootKey(root: ResourceRoot): string { return JSON.stringify([root.filesystemId, root.canonicalPath]); }

function compareRoots(left: ResourceRoot, right: ResourceRoot): number {
  const priority = { conventional: 0, configured: 1, host: 2 };
  return left.filesystemId.localeCompare(right.filesystemId) || left.canonicalPath.localeCompare(right.canonicalPath)
    || Number(left.scope === "unassigned") - Number(right.scope === "unassigned") || priority[right.origin] - priority[left.origin]
    || left.path.localeCompare(right.path);
}
