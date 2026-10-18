import { createHash, randomUUID } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InventoryError, InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";
import { canonicalResourcePath, qualifyResource, type ResourceRoot } from "./resource-paths.js";

type InventoryScanResult = {
  root: ResourceRoot;
  scanId: string;
  resourceCount: number;
  batchCount: number;
} & ({ status: "complete" } | { status: "incomplete"; error: InventoryError });

export type ResourceInventoryResult = { roots: readonly ResourceRoot[]; scans: readonly InventoryScanResult[] };

type TraversalEntry =
  | { kind: "file"; path: string }
  | { kind: "alias"; path: string; canonicalPath: string }
  | { kind: "error"; error: InventoryError };

export async function inventoryResources(options: {
  roots: readonly ResourceRoot[];
  record: (evidence: InventorySnapshotEvidence) => void | Promise<void>;
  scanId?: string;
  batchSize?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}): Promise<ResourceInventoryResult> {
  const batchSize = boundedInteger(options.batchSize ?? 64, 1, 256, "batchSize");
  const maxEntries = boundedInteger(options.maxEntries ?? 100000, 1, 1000000, "maxEntries");
  const roots = new Map(options.roots.map((root) => [rootKey(root), root]));
  const scannedRoots = new Set<string>();
  const scans: InventoryScanResult[] = [];
  const budget = { remaining: maxEntries };
  for (const root of roots.values()) {
    const identity = JSON.stringify([root.filesystemId, root.canonicalPath]);
    if (scannedRoots.has(identity)) continue;
    scannedRoots.add(identity);
    const scanId = options.scanId === undefined ? randomUUID() : `${options.scanId}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
    const common = {
      kind: "inventory-snapshot", scanId, filesystemId: root.filesystemId, rootPath: root.canonicalPath, origin: root.origin, scope: root.scope,
    } satisfies Pick<InventorySnapshotEvidence, "kind" | "scanId" | "filesystemId" | "rootPath" | "origin" | "scope">;
    await options.record({ ...common, phase: "started", resources: [], error: null });
    let resources: ResourceLocation[] = [];
    let batchBytes = 0;
    let batchCount = 0;
    let resourceCount = 0;
    let error: InventoryError | null = null;
    const files = new Set<string>();
    const flush = async (): Promise<void> => {
      if (!resources.length) return;
      await options.record({ ...common, phase: "batch", resources, batchIndex: batchCount, error: null });
      batchCount += 1;
      resources = [];
      batchBytes = 0;
    };
    for await (const entry of traverseRoot(root, budget, options.signal)) {
      if (entry.kind === "error") {
        error ??= entry.error;
        continue;
      }
      if (entry.kind === "alias") {
        const alias = { ...root, path: entry.path, canonicalPath: entry.canonicalPath };
        if (!roots.has(rootKey(alias))) roots.set(rootKey(alias), alias);
        continue;
      }
      const resource = qualifyResource({ path: entry.path, cwd: root.path, roots: [root] });
      if (!resource) continue;
      if (files.has(resource.canonicalPath)) continue;
      files.add(resource.canonicalPath);
      const bytes = Buffer.byteLength(JSON.stringify(resource));
      if (resources.length >= batchSize || batchBytes + bytes > 262144) await flush();
      resources.push(resource);
      batchBytes += bytes;
      resourceCount += 1;
    }
    await flush();
    if (error === null) {
      await options.record({ ...common, phase: "complete", resources: [], batchCount, error: null });
      scans.push({ root, scanId, resourceCount, batchCount, status: "complete" });
    } else {
      await options.record({ ...common, phase: "incomplete", resources: [], batchCount, error });
      scans.push({ root, scanId, resourceCount, batchCount, status: "incomplete", error });
    }
  }
  return { roots: [...roots.values()], scans };
}

async function* traverseRoot(root: ResourceRoot, budget: { remaining: number }, signal: AbortSignal | undefined): AsyncGenerator<TraversalEntry> {
  const directories = new Set<string>();
  let stopped = false;
  async function* directory(path: string, depth: number, parentDevice: number): AsyncGenerator<TraversalEntry> {
    if (stopped) return;
    if (signal?.aborted) {
      stopped = true;
      yield { kind: "error", error: "cancelled" };
      return;
    }
    if (depth > 256) {
      stopped = true;
      yield { kind: "error", error: "limit" };
      return;
    }
    const canonicalPath = canonicalResourcePath(path);
    if (directories.has(canonicalPath)) return;
    directories.add(canonicalPath);
    let handle: Awaited<ReturnType<typeof opendir>>;
    let device: number;
    try {
      device = (await stat(path)).dev;
      if (device !== parentDevice) yield { kind: "alias", path, canonicalPath };
      handle = await opendir(path);
    } catch (error) {
      yield { kind: "error", error: inventoryError(error) };
      return;
    }
    try {
      for await (const entry of handle) {
        if (stopped) return;
        if (signal?.aborted) {
          stopped = true;
          yield { kind: "error", error: "cancelled" };
          return;
        }
        if (budget.remaining <= 0) {
          stopped = true;
          yield { kind: "error", error: "limit" };
          return;
        }
        budget.remaining -= 1;
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          yield* directory(child, depth + 1, device);
        } else if (entry.isFile()) {
          yield { kind: "file", path: child };
        } else if (entry.isSymbolicLink()) {
          let target: Awaited<ReturnType<typeof stat>>;
          try {
            target = await stat(child);
          } catch (error) {
            yield { kind: "error", error: inventoryError(error) };
            continue;
          }
          if (target.isDirectory()) {
            yield { kind: "alias", path: child, canonicalPath: canonicalResourcePath(child) };
            yield* directory(child, depth + 1, device);
          } else if (target.isFile()) {
            yield { kind: "alias", path: child, canonicalPath: canonicalResourcePath(child) };
            yield { kind: "file", path: child };
          }
        }
      }
    } catch (error) {
      yield { kind: "error", error: inventoryError(error) };
    }
  }
  if (signal?.aborted) {
    yield { kind: "error", error: "cancelled" };
    return;
  }
  let device: number;
  try {
    const rootStat = await stat(root.path);
    device = rootStat.dev;
    if (rootStat.isFile()) {
      if (budget.remaining <= 0) {
        yield { kind: "error", error: "limit" };
        return;
      }
      budget.remaining -= 1;
      yield { kind: "file", path: root.path };
      return;
    }
  } catch (error) {
    yield { kind: "error", error: inventoryError(error) };
    return;
  }
  yield* directory(root.path, 0, device);
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

function rootKey(root: ResourceRoot): string {
  return JSON.stringify([root.filesystemId, root.canonicalPath, root.path]);
}
