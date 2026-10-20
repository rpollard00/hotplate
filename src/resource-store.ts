import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DashboardFilter, MachineId, Observation, SourceId } from "./domain.js";
import { isResourceEvidence, parseMachineId, parseObservation, parseSourceId, serializeObservation } from "./observation.js";
import type { InventorySnapshotEvidence, ObserverCoverageEvidence, ResourceCoverageRow, ResourceCoverageView, ResourceEvidence, ResourceLocation, ResourceRow, ResourceView } from "./resource-domain.js";
import { readResourceAccessFacts, recordAnalyticsFact } from "./analytics-read-model.js";
import { readInventoryScanFacts, readInventoryLocationHistory, readInventoryCompletionPaths } from "./inventory-read-model.js";

type StoredSource = { machineId: MachineId; sourceId: SourceId | "local" };
type ResourceObservation = Observation & { evidence: ResourceEvidence };
type StoredEvent = { source: StoredSource; observation: ResourceObservation; count?: number; digest?: string | null };
type ResourceState = {
  row: ResourceRow;
  latestLocationOrder: Pick<Observation, "observedAt" | "producerId" | "sequence" | "id">;
  roots: Map<string, { firstSeen: string | null; lastSeen: string | null }>;
};
type Scan = {
  source: StoredSource;
  identity: InventorySnapshotEvidence;
  startedAt: string | null;
  firstObservedAt: string;
  batches: Map<number, { digest: string | null }>;
  complete: { batchCount: number; observedAt: string } | null;
  invalid: boolean;
};
type InventoryCompletion = { observedAt: string; paths: Set<string> };
type CoverageInterval = { from: number; to: number };
type CoverageHeartbeat = { at: number; heartbeatMs: number; status: ObserverCoverageEvidence["status"] };
type CoverageTimeline = { last: CoverageHeartbeat; intervals: CoverageInterval[] };
type RootCoverage = { intervals: CoverageInterval[]; active: CoverageHeartbeat[] };

export function createResourceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE resource_locations (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, filesystem_id TEXT NOT NULL, canonical_path TEXT NOT NULL,
    location TEXT NOT NULL, first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
    PRIMARY KEY(machine_id, source_id, filesystem_id, canonical_path)
  ) STRICT;
  CREATE TABLE resource_events (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, observation_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(machine_id, source_id, observation_id),
    FOREIGN KEY(machine_id, source_id, observation_id) REFERENCES observations(machine_id, source_id, id)
  ) STRICT;`);
}

export function recordResourceObservation(db: DatabaseSync, source: StoredSource, observation: Observation): void {
  if (!isResourceEvidence(observation.evidence)) return;
  const locations = observation.evidence.kind === "resource-access" ? [observation.evidence.resource]
    : observation.evidence.kind === "inventory-snapshot" ? observation.evidence.resources : [];
  if (locations.length > 0) {
    const upsert = db.prepare(`INSERT INTO resource_locations
      (machine_id, source_id, filesystem_id, canonical_path, location, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id, source_id, filesystem_id, canonical_path) DO UPDATE SET
      location = CASE WHEN excluded.last_observed_at > resource_locations.last_observed_at
        OR (excluded.last_observed_at = resource_locations.last_observed_at AND excluded.location > resource_locations.location)
        THEN excluded.location ELSE resource_locations.location END,
      first_observed_at = MIN(resource_locations.first_observed_at, excluded.first_observed_at),
      last_observed_at = MAX(resource_locations.last_observed_at, excluded.last_observed_at)`);
    for (const location of locations) {
      upsert.run(source.machineId, source.sourceId, location.filesystemId, location.canonicalPath,
        JSON.stringify(location), observation.observedAt, observation.observedAt);
    }
  }
  db.prepare("INSERT INTO resource_events (machine_id, source_id, observation_id, payload) VALUES (?, ?, ?, ?)")
    .run(source.machineId, source.sourceId, observation.id, serializeObservation(observation));
  recordAnalyticsFact(db, source, observation);
}

export function queryResources(db: DatabaseSync, filter: DashboardFilter): ResourceView {
  if (filter.source !== undefined) return { rows: [] };
  const resources = new Map<string, ResourceState>();
  const scans = new Map<string, Scan>();
  for (const history of readInventoryLocationHistory(db, filter)) {
    const order = { observedAt: history.lastAt, producerId: history.producerId, sequence: history.sequence, id: history.observationId };
    const state = resourceState(resources, { machineId: history.machineId, sourceId: history.sourceId }, history.resource, history.lastAt, order);
    const root = state.roots.get(history.resource.rootPath);
    if (root) { root.firstSeen = earliest(root.firstSeen, history.firstAt); root.lastSeen = latest(root.lastSeen, history.lastAt); }
    state.row.firstInventoriedAt = earliest(state.row.firstInventoriedAt, history.firstAt);
    state.row.lastInventoriedAt = latest(state.row.lastInventoriedAt, history.lastAt);
  }
  for (const { source, observation, count = 1, digest = null } of readResourceEvents(db, filter)) {
    const evidence = observation.evidence;
    if (evidence.kind === "observer-coverage" || evidence.kind === "tool-coverage") continue;
    if (evidence.kind === "inventory-snapshot") {
      const key = JSON.stringify([source.machineId, source.sourceId, evidence.filesystemId, evidence.rootPath, evidence.scanId]);
      let scan = scans.get(key);
      if (!scan) {
        scan = { source, identity: evidence, startedAt: null, firstObservedAt: observation.observedAt, batches: new Map(), complete: null, invalid: false };
        scans.set(key, scan);
      }
      if (evidence.origin !== scan.identity.origin || evidence.scope !== scan.identity.scope) scan.invalid = true;
      switch (evidence.phase) {
        case "started": scan.startedAt = earliest(scan.startedAt, observation.observedAt); break;
        case "batch": {
          const previous = scan.batches.get(evidence.batchIndex);
          if (previous && previous.digest !== digest) scan.invalid = true;
          scan.batches.set(evidence.batchIndex, { digest });
          break;
        }
        case "complete":
          if (scan.complete && scan.complete.batchCount !== evidence.batchCount) scan.invalid = true;
          scan.complete = { batchCount: evidence.batchCount, observedAt: observation.observedAt };
          break;
        case "incomplete": scan.invalid = true; break;
        default: { const exhaustive: never = evidence; return exhaustive; }
      }
      continue;
    }
    const scope = accessScope(observation, filter);
    if (scope === "excluded" || (scope === "ambiguous" && evidence.attribution === "non-agent")) continue;
    const state = resourceState(resources, source, evidence.resource, observation.observedAt, observation);
    if (filter.fromObservedAt !== undefined && observation.observedAt < filter.fromObservedAt) continue;
    const row = state.row;
    if (scope === "ambiguous") { row.unattributedAccessCount += count; continue; }
    row.lastAccessAt = latest(row.lastAccessAt, observation.observedAt);
    if (evidence.access === "attempt") row.attemptCount += count;
    else if (evidence.access === "read" && evidence.outcome === "success") row.successfulReadCount += count;
    else if (evidence.access === "inferred-read") row.inferredReadCount += count;
    else if (evidence.access === "read" && evidence.outcome === "error") row.failedReadCount += count;
    else if (evidence.access === "open") row.openCount += count;
    else if (evidence.access === "access") row.accessCount += count;
    if (evidence.attribution === "session" || evidence.attribution === "harness") row.attributedAccessCount += count;
    else if (evidence.attribution === "non-agent") row.nonAgentAccessCount += count;
    else row.unattributedAccessCount += count;
  }
  const inventory = inventoryState(scans, scan => readInventoryCompletionPaths(db, scan, filter));
  let coverageByRoot: Map<string, RootCoverage> | undefined;
  const combinedCoverage = new Map<string, RootCoverage>();
  const to = filter.toObservedAt === undefined ? Date.now() : Date.parse(filter.toObservedAt);
  for (const state of resources.values()) {
    const row = state.row;
    row.rootPaths = [...state.roots.keys()].sort();
    let absent = false;
    let present = false;
    let unknown = false;
    for (const [rootPath, root] of state.roots) {
      const key = rootKey(row, row.resource.filesystemId, rootPath);
      const complete = inventory.completions.get(key);
      const uncertainSince = inventory.uncertainty.get(key);
      const knownAt = complete && complete.observedAt > (root.lastSeen ?? "") ? complete.observedAt : root.lastSeen;
      if (uncertainSince && (knownAt === null || uncertainSince > knownAt)) {
        unknown = true;
        continue;
      }
      if (complete && (root.lastSeen === null || complete.observedAt >= root.lastSeen)) {
        if (complete.paths.has(row.resource.canonicalPath)) present = true;
        else absent = true;
      } else if (root.lastSeen !== null) present = true;
      else unknown = true;
    }
    row.presence = present ? "present" : absent && !unknown ? "absent" : "unknown";
    row.observation = row.attributedAccessCount > 0 ? "observed" : "unknown";
    if (row.observation === "observed" || row.presence !== "present" || row.firstInventoriedAt === null
      || row.unattributedAccessCount > 0 || filter.modelSelection !== undefined || filter.modelId !== undefined || filter.modelProvider !== undefined) continue;
    const availableFrom = Date.parse(row.firstInventoriedAt);
    const requestedFrom = Math.max(availableFrom, filter.fromObservedAt === undefined ? -Infinity : Date.parse(filter.fromObservedAt));
    const physicalRoots = row.rootPaths.filter(rootPath => {
      const suffix = relative(rootPath, row.resource.canonicalPath);
      return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../"));
    });
    const rootKeys = physicalRoots.map(rootPath => rootKey(row, row.resource.filesystemId, rootPath));
    const combinationKey = JSON.stringify(rootKeys);
    let covered = combinedCoverage.get(combinationKey);
    if (!covered) {
      const byRoot = coverageByRoot ??= coverageState(db, filter);
      const roots = rootKeys.flatMap(key => byRoot.get(key) ?? []);
      covered = { intervals: mergeIntervals(roots.flatMap(root => root.intervals)), active: roots.flatMap(root => root.active) };
      combinedCoverage.set(combinationKey, covered);
    }
    const interval = covered.intervals.findLast(item => (filter.fromObservedAt === undefined || item.from <= requestedFrom)
      && Math.min(item.to, to) > Math.max(requestedFrom, item.from) && (filter.toObservedAt === undefined || item.to >= to));
    if (!interval) continue;
    const from = Math.max(requestedFrom, interval.from);
    if (filter.toObservedAt === undefined) {
      const active = covered.active.some(last => to - last.at <= last.heartbeatMs * 3 && interval.to >= last.at);
      if (!active) continue;
    }
    row.observation = "not-observed";
    row.coverageFrom = new Date(from).toISOString();
    row.coverageTo = new Date(Math.min(interval.to, to)).toISOString();
  }
  return { rows: [...resources.values()].map(state => state.row).sort((a, b) => a.resource.canonicalPath.localeCompare(b.resource.canonicalPath) || a.resourceId.localeCompare(b.resourceId)) };
}

export function queryResourceCoverage(db: DatabaseSync, filter: DashboardFilter): ResourceCoverageView {
  if (filter.source !== undefined) return { rows: [] };
  const rows = new Map<string, ResourceCoverageRow>();
  const now = filter.toObservedAt === undefined ? Date.now() : Date.parse(filter.toObservedAt);
  for (const { source, observation } of readEvents(db, filter, "latest-coverage")) {
    const evidence = observation.evidence;
    if (evidence.kind !== "observer-coverage") continue;
    for (const rootPath of evidence.rootPaths) {
      const key = JSON.stringify([source.machineId, source.sourceId, evidence.filesystemId, evidence.observerId, evidence.mechanism, rootPath]);
      rows.set(key, { ...source, observerId: evidence.observerId, filesystemId: evidence.filesystemId, rootPath, mechanism: evidence.mechanism,
        status: evidence.status === "active" && now - Date.parse(observation.observedAt) > evidence.heartbeatMs * 3 ? "stale" : evidence.status,
        reason: evidence.reason, lastObservedAt: observation.observedAt, heartbeatMs: evidence.heartbeatMs });
    }
  }
  return { rows: [...rows.values()].sort((a, b) => a.rootPath.localeCompare(b.rootPath) || a.observerId.localeCompare(b.observerId)) };
}

function* readResourceEvents(db: DatabaseSync, filter: DashboardFilter): Generator<StoredEvent> {
  const inventory = readInventoryScanFacts(db, filter);
  const access = readResourceAccessFacts(db, filter, { kind: "resources" });
  let nextInventory = inventory.next();
  let nextAccess = access.next();
  while (!nextInventory.done || !nextAccess.done) {
    if (!nextAccess.done && (nextInventory.done || compareObservations(nextAccess.value, nextInventory.value.observation) < 0)) {
      const fact = nextAccess.value;
      yield { source: { machineId: fact.machineId, sourceId: fact.sourceId }, observation: fact, count: fact.aggregate?.count ?? 1 };
      nextAccess = access.next();
    } else if (!nextInventory.done) {
      yield nextInventory.value;
      nextInventory = inventory.next();
    }
  }
}

function compareObservations(left: Pick<Observation, "observedAt" | "producerId" | "sequence" | "id">, right: Pick<Observation, "observedAt" | "producerId" | "sequence" | "id">): number {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return compare(left.observedAt, right.observedAt) || compare(left.producerId, right.producerId)
    || left.sequence - right.sequence || compare(left.id, right.id);
}

function* readEvents(db: DatabaseSync, filter: DashboardFilter, selection: "coverage-history" | "latest-coverage"): Generator<StoredEvent> {
  const clauses = ["o.evidence_kind = 'observer-coverage'"];
  const values: (string | number)[] = [];
  if (filter.machineId !== undefined) { clauses.push("e.machine_id = ?"); values.push(filter.machineId); }
  if (filter.toObservedAt !== undefined && selection !== "coverage-history") {
    clauses.push("o.observed_at <= ?");
    values.push(filter.toObservedAt);
  }
  const join = "FROM resource_events e JOIN observations o ON o.machine_id = e.machine_id AND o.source_id = e.source_id AND o.id = e.observation_id";
  const order = "o.observed_at, o.producer_id, o.sequence, o.id";
  const query = selection === "latest-coverage" ? `WITH ranked AS (
      SELECT e.machine_id, e.source_id, e.observation_id,
        ROW_NUMBER() OVER (PARTITION BY e.machine_id, e.source_id,
          c.filesystem_id, c.observer_id, c.mechanism, c.root_set
          ORDER BY o.observed_at DESC, o.producer_id DESC, o.sequence DESC, o.id DESC) AS position
      ${join} JOIN observer_coverage_facts c ON c.machine_id = e.machine_id AND c.source_id = e.source_id AND c.observation_id = e.observation_id
      WHERE ${clauses.join(" AND ")}
    ) SELECT e.machine_id, e.source_id, e.payload ${join}
      JOIN ranked r ON r.machine_id = e.machine_id AND r.source_id = e.source_id AND r.observation_id = e.observation_id
      WHERE r.position = 1 ORDER BY ${order}`
    : `SELECT e.machine_id, e.source_id, e.payload ${join} WHERE ${clauses.join(" AND ")} ORDER BY ${order}`;
  for (const row of db.prepare(query).iterate(...values)) {
    if (typeof row.payload !== "string") throw new Error("Invalid stored resource event");
    const observation = parseObservation(JSON.parse(row.payload));
    const evidence = observation.evidence;
    if (evidence.kind !== "resource-access" && evidence.kind !== "inventory-snapshot" && evidence.kind !== "observer-coverage") {
      throw new Error("Invalid stored resource evidence");
    }
    yield { source: { machineId: parseMachineId(row.machine_id), sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id) },
      observation: { ...observation, evidence } };
  }
}


function accessScope(observation: ResourceObservation, filter: DashboardFilter): "exact" | "ambiguous" | "excluded" {
  const evidence = observation.evidence;
  if (evidence.kind !== "resource-access") return "excluded";
  if (filter.modelSelection?.kind === "unknown" && evidence.model !== null) return "excluded";
  const provider = filter.modelSelection?.kind === "known" ? filter.modelSelection.model.provider : filter.modelSelection?.kind === "unknown" ? null : filter.modelProvider;
  const modelId = filter.modelSelection?.kind === "known" ? filter.modelSelection.model.id : filter.modelSelection?.kind === "unknown" ? null : filter.modelId;
  const comparisons: readonly [string | null | undefined, string | null, boolean][] = [
    [filter.host, observation.host ?? "unknown", observation.host === undefined || observation.host === "unknown"],
    [filter.projectCwd, observation.scope.projectCwd, observation.scope.projectCwd === "[unknown project]"],
    [filter.sessionId, observation.scope.sessionId, observation.scope.sessionId === null],
    [filter.runId, observation.scope.runId, observation.scope.runId === null],
    [provider, evidence.model?.provider ?? null, evidence.model === null],
    [modelId, evidence.model?.id ?? null, evidence.model === null],
  ];
  let ambiguous = false;
  for (const [requested, actual, unknown] of comparisons) {
    if (requested === undefined || requested === actual) continue;
    if (!unknown) return "excluded";
    ambiguous = true;
  }
  return ambiguous ? "ambiguous" : "exact";
}

function resourceState(resources: Map<string, ResourceState>, source: StoredSource, resource: ResourceLocation, observedAt: string, order: Pick<Observation, "observedAt" | "producerId" | "sequence" | "id">): ResourceState {
  const id = createHash("sha256").update(JSON.stringify([source.machineId, source.sourceId, resource.filesystemId, resource.canonicalPath])).digest("hex");
  let state = resources.get(id);
  if (!state) {
    state = { latestLocationOrder: order, roots: new Map(), row: {
      resourceId: id, ...source, resource, rootPaths: [], presence: "unknown", firstInventoriedAt: null, lastInventoriedAt: null,
      lastAccessAt: null, attemptCount: 0, successfulReadCount: 0, inferredReadCount: 0, failedReadCount: 0, openCount: 0, accessCount: 0,
      attributedAccessCount: 0, unattributedAccessCount: 0, nonAgentAccessCount: 0, observation: "unknown", coverageFrom: null, coverageTo: null,
    } };
    resources.set(id, state);
  }
  if (compareObservations(order, state.latestLocationOrder) >= 0) { state.row.resource = resource; state.latestLocationOrder = order; }
  if (!state.roots.has(resource.rootPath)) state.roots.set(resource.rootPath, { firstSeen: null, lastSeen: null });
  return state;
}

function inventoryState(scans: Map<string, Scan>, paths: (scan: Scan) => readonly string[]): { completions: Map<string, InventoryCompletion>; uncertainty: Map<string, string> } {
  const result = new Map<string, InventoryCompletion>();
  const selected = new Map<string, Scan>();
  const uncertainty = new Map<string, string>();
  for (const scan of scans.values()) {
    const complete = scan.complete;
    const key = rootKey(scan.source, scan.identity.filesystemId, scan.identity.rootPath);
    let valid = scan.startedAt !== null && !scan.invalid && complete !== null && scan.batches.size === complete.batchCount;
    if (valid && complete) {
      for (let i = 0; i < complete.batchCount; i += 1) if (!scan.batches.has(i)) { valid = false; break; }
    }
    if (!valid || !complete) {
      const since = scan.startedAt ?? scan.firstObservedAt;
      uncertainty.set(key, latest(uncertainty.get(key) ?? null, since));
      continue;
    }
    const previous = result.get(key);
    if (previous && previous.observedAt >= complete.observedAt) continue;
    result.set(key, { observedAt: complete.observedAt, paths: new Set() });
    selected.set(key, scan);
  }
  for (const [key, scan] of selected) { const completion = result.get(key); if (completion) completion.paths = new Set(paths(scan)); }
  return { completions: result, uncertainty };
}

function coverageState(db: DatabaseSync, filter: DashboardFilter): Map<string, RootCoverage> {
  const observers = new Map<string, { source: StoredSource; filesystemId: string; roots: Map<string, CoverageTimeline> }>();
  for (const { source, observation } of readEvents(db, filter, "coverage-history")) {
    const evidence = observation.evidence;
    if (evidence.kind !== "observer-coverage" || evidence.mechanism !== "fanotify") continue;
    const key = JSON.stringify([source.machineId, source.sourceId, evidence.filesystemId, evidence.observerId]);
    let observer = observers.get(key);
    if (!observer) { observer = { source, filesystemId: evidence.filesystemId, roots: new Map() }; observers.set(key, observer); }
    const current = { at: Date.parse(observation.observedAt), heartbeatMs: evidence.heartbeatMs, status: evidence.status };
    for (const rootPath of evidence.rootPaths) {
      const timeline = observer.roots.get(rootPath);
      if (!timeline) { observer.roots.set(rootPath, { last: current, intervals: [] }); continue; }
      const previous = timeline.last;
      if (previous.status === "active" && current.status === "active" && current.at - previous.at <= previous.heartbeatMs * 3) {
        const interval = timeline.intervals.at(-1);
        if (interval && interval.to >= previous.at) interval.to = current.at;
        else timeline.intervals.push({ from: previous.at, to: current.at });
      }
      timeline.last = current;
    }
  }
  const roots = new Map<string, RootCoverage>();
  for (const observer of observers.values()) {
    for (const [rootPath, timeline] of observer.roots) {
      const key = rootKey(observer.source, observer.filesystemId, rootPath);
      let root = roots.get(key);
      if (!root) { root = { intervals: [], active: [] }; roots.set(key, root); }
      for (const interval of timeline.intervals) root.intervals.push(interval);
      if (timeline.last.status === "active") root.active.push(timeline.last);
    }
  }
  for (const root of roots.values()) root.intervals = mergeIntervals(root.intervals);
  return roots;
}

function mergeIntervals(intervals: readonly CoverageInterval[]): CoverageInterval[] {
  const result: CoverageInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const previous = result.at(-1);
    if (previous && previous.to >= interval.from) previous.to = Math.max(previous.to, interval.to);
    else result.push({ ...interval });
  }
  return result;
}

function rootKey(source: StoredSource, filesystemId: string, rootPath: string): string {
  return JSON.stringify([source.machineId, source.sourceId, filesystemId, rootPath]);
}
function earliest(left: string | null, right: string): string { return left === null || right < left ? right : left; }
function latest(left: string | null, right: string): string { return left === null || right > left ? right : left; }
