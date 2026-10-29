import { createHash } from "node:crypto";
import { refreshInventoryMembership } from "./inventory-membership.js";
import { analyticsHourBucket } from "./analytics-time.js";
import type { DatabaseSync } from "node:sqlite";
import type { DashboardFilter, Observation } from "./domain.js";
import type { ContentFact } from "./content-analytics.js";
import type { InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";
import { isResourceLocation, parseMachineId, parseObservation, parseSourceId } from "./observation.js";

type Source = Pick<ContentFact, "machineId" | "sourceId">;
type SqlValue = string | number | null;
export type InventoryLocationHistory = Source & { resource: ResourceLocation; firstAt: string; lastAt: string; producerId: string; sequence: number; observationId: string };

export function createInventoryReadModel(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_scan_facts (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, observation_id TEXT NOT NULL,
    filesystem_id TEXT NOT NULL, root_path TEXT NOT NULL, scan_id TEXT NOT NULL,
    host TEXT NOT NULL, project_cwd TEXT NOT NULL, session_id TEXT, run_id TEXT, visibility TEXT NOT NULL,
    observed_at TEXT NOT NULL, producer_id TEXT NOT NULL, sequence INTEGER NOT NULL, phase TEXT NOT NULL, batch_digest TEXT, metadata_json TEXT NOT NULL,
    PRIMARY KEY(machine_id, source_id, observation_id),
    FOREIGN KEY(machine_id, source_id, observation_id) REFERENCES observations(machine_id, source_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS inventory_scan_identity_idx ON inventory_scan_facts(machine_id, source_id, filesystem_id, root_path, scan_id, phase, observed_at);
  CREATE INDEX IF NOT EXISTS inventory_scan_time_idx ON inventory_scan_facts(observed_at);
  CREATE INDEX IF NOT EXISTS inventory_scan_scope_idx ON inventory_scan_facts(host, visibility, project_cwd, session_id, run_id, observed_at);
  CREATE TABLE IF NOT EXISTS inventory_location_variants (id INTEGER PRIMARY KEY, location TEXT NOT NULL UNIQUE) STRICT;
  CREATE TABLE IF NOT EXISTS inventory_location_buckets (
    group_key TEXT NOT NULL, bucket_start TEXT NOT NULL, machine_id TEXT NOT NULL, source_id TEXT NOT NULL,
    variant_id INTEGER NOT NULL REFERENCES inventory_location_variants(id),
    host TEXT NOT NULL, project_cwd TEXT NOT NULL, session_id TEXT, run_id TEXT, visibility TEXT NOT NULL,
    first_at TEXT NOT NULL, last_at TEXT NOT NULL, producer_id TEXT NOT NULL, sequence INTEGER NOT NULL, observation_id TEXT NOT NULL, resource_order INTEGER NOT NULL,
    PRIMARY KEY(group_key, bucket_start)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS inventory_location_scope_idx ON inventory_location_buckets(host, visibility, project_cwd, session_id, run_id, last_at);
  CREATE INDEX IF NOT EXISTS inventory_location_time_idx ON inventory_location_buckets(bucket_start, last_at);
  CREATE INDEX IF NOT EXISTS inventory_location_history_idx ON inventory_location_buckets(machine_id, source_id, variant_id, last_at DESC, producer_id DESC, sequence DESC, observation_id DESC, resource_order DESC, first_at);
  INSERT OR REPLACE INTO inventory_scan_facts
    (machine_id, source_id, observation_id, filesystem_id, root_path, scan_id, host, project_cwd, session_id, run_id, visibility, observed_at, producer_id, sequence, phase, batch_digest, metadata_json)
    SELECT o.machine_id, o.source_id, o.id, json_extract(e.payload, '$.evidence.filesystemId'), json_extract(e.payload, '$.evidence.rootPath'),
      json_extract(e.payload, '$.evidence.scanId'), o.host, o.project_cwd, o.session_id, o.run_id, json_extract(e.payload, '$.evidence.scope'),
      o.observed_at, o.producer_id, o.sequence, json_extract(e.payload, '$.evidence.phase'),
      CASE WHEN json_extract(e.payload, '$.evidence.phase') = 'batch' THEN hotplate_resource_group(json_extract(e.payload, '$.evidence.resources')) END,
      json_set(e.payload, '$.evidence.resources', json('[]'))
    FROM observations o JOIN resource_events e ON e.machine_id = o.machine_id AND e.source_id = o.source_id AND e.observation_id = o.id WHERE o.evidence_kind = 'inventory-snapshot';
  INSERT OR IGNORE INTO inventory_location_variants(location)
    SELECT DISTINCT j.value FROM inventory_scan_facts s JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
    JOIN json_each(e.payload, '$.evidence.resources') j WHERE s.phase = 'batch';
  INSERT OR REPLACE INTO inventory_location_buckets
    WITH flattened AS (SELECT s.machine_id, s.source_id, v.id AS variant_id, s.host, s.project_cwd, s.session_id, s.run_id, s.visibility,
      s.observed_at, s.producer_id, s.sequence, s.observation_id, j.key AS resource_order, hotplate_resource_bucket(s.observed_at) AS bucket_start,
      hotplate_resource_group(s.machine_id, s.source_id, s.host, s.project_cwd, s.session_id, s.run_id, s.visibility, v.id) AS group_key
      FROM inventory_scan_facts s JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
      JOIN json_each(e.payload, '$.evidence.resources') j JOIN inventory_location_variants v ON v.location = j.value WHERE s.phase = 'batch'),
    ranked AS (SELECT *, MIN(observed_at) OVER (PARTITION BY group_key, bucket_start) AS first_at,
      ROW_NUMBER() OVER (PARTITION BY group_key, bucket_start ORDER BY observed_at DESC, producer_id DESC, sequence DESC, observation_id DESC, resource_order DESC) AS position FROM flattened)
    SELECT group_key, bucket_start, machine_id, source_id, variant_id, host, project_cwd, session_id, run_id, visibility,
      first_at, observed_at, producer_id, sequence, observation_id, resource_order FROM ranked WHERE position = 1;`);
}

export function recordInventoryFact(db: DatabaseSync, source: Source, observation: Observation & { evidence: InventorySnapshotEvidence }): void {
  const evidence = observation.evidence;
  const metadata = { ...observation, evidence: { ...evidence, resources: [] } };
  db.prepare("INSERT INTO inventory_scan_facts (machine_id, source_id, observation_id, filesystem_id, root_path, scan_id, host, project_cwd, session_id, run_id, visibility, observed_at, producer_id, sequence, phase, batch_digest, metadata_json, positive_projection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(
    source.machineId, source.sourceId, observation.id, evidence.filesystemId, evidence.rootPath, evidence.scanId,
    observation.host ?? "unknown", observation.scope.projectCwd, observation.scope.sessionId, observation.scope.runId, evidence.scope,
    observation.observedAt, observation.producerId, observation.sequence, evidence.phase,
    evidence.phase === "batch" ? digest([JSON.stringify(evidence.resources)]) : null, JSON.stringify(metadata),
  );
  refreshInventoryMembership(db, source, evidence);
  if (evidence.phase !== "batch") return;
  const insertVariant = db.prepare("INSERT INTO inventory_location_variants(location) VALUES (?) ON CONFLICT(location) DO UPDATE SET location = excluded.location RETURNING id");
  const upsert = db.prepare(`INSERT INTO inventory_location_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, source_id, host, visibility, variant_id) DO UPDATE SET
    producer_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.producer_id ELSE producer_id END,
    sequence = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.sequence ELSE sequence END,
    observation_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.observation_id ELSE observation_id END,
    resource_order = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.resource_order ELSE resource_order END,
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`);
  for (const [resourceOrder, resource] of evidence.resources.entries()) {
    const variant = integer(insertVariant.get(JSON.stringify(resource))?.id);
    upsert.run(source.machineId, source.sourceId, observation.host ?? "unknown", evidence.scope, variant,
      observation.observedAt, observation.observedAt, observation.producerId, observation.sequence, observation.id, resourceOrder);
  }
}

type InventoryState = { completions: Map<string, { observedAt: string; paths: Set<string> }>; uncertainty: Map<string, string> };

export function readInventoryState(db: DatabaseSync, filter: DashboardFilter): InventoryState {
  if ([filter.host, filter.projectCwd, filter.sessionId, filter.runId, filter.modelId, filter.modelProvider].every(value => value === undefined)
    && isCurrentInventory(db, filter)) return readCurrentInventoryState(db, filter);
  const where = inventoryWhere(filter, "s");
  const identity = "machine_id, source_id, filesystem_id, root_path, scan_id";
  const root = "machine_id, source_id, filesystem_id, root_path";
  const sql = `WITH facts AS (
      SELECT s.*, ROW_NUMBER() OVER (ORDER BY s.observed_at, s.producer_id, s.sequence, s.observation_id) AS ordinal
      FROM inventory_scan_facts s WHERE ${where.sql}
    ), scans AS (
      SELECT ${identity}, MIN(ordinal) AS first_ordinal, MIN(metadata_json) AS metadata_json,
        MIN(observed_at) AS first_at, MIN(CASE WHEN phase = 'started' THEN observed_at END) AS started_at,
        MAX(CASE WHEN phase = 'complete' THEN observed_at END) AS completed_at,
        MIN(CASE WHEN phase = 'complete' THEN json_extract(metadata_json, '$.evidence.batchCount') END) AS min_count,
        MAX(CASE WHEN phase = 'complete' THEN json_extract(metadata_json, '$.evidence.batchCount') END) AS max_count,
        MAX(CASE WHEN phase = 'incomplete' THEN 1 ELSE 0 END) AS incomplete,
        COUNT(DISTINCT visibility) AS scopes, COUNT(DISTINCT json_extract(metadata_json, '$.evidence.origin')) AS origins,
        COUNT(DISTINCT CASE WHEN phase = 'batch' THEN json_extract(metadata_json, '$.evidence.batchIndex') END) AS batches,
        COUNT(DISTINCT CASE WHEN phase = 'batch' THEN json_array(json_extract(metadata_json, '$.evidence.batchIndex'), batch_digest) END) AS contents,
        MIN(CASE WHEN phase = 'batch' THEN json_extract(metadata_json, '$.evidence.batchIndex') END) AS first_batch,
        MAX(CASE WHEN phase = 'batch' THEN json_extract(metadata_json, '$.evidence.batchIndex') END) AS last_batch
      FROM facts GROUP BY ${identity}
    ), classified AS (
      SELECT *, started_at IS NOT NULL AND completed_at IS NOT NULL AND incomplete = 0 AND scopes = 1 AND origins = 1
        AND min_count = max_count AND batches = max_count AND contents = batches
        AND (batches = 0 OR (first_batch = 0 AND last_batch = batches - 1)) AS valid FROM scans
    ), completions AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY ${root} ORDER BY completed_at DESC, first_ordinal) AS position
      FROM classified WHERE valid
    ), uncertainty AS (
      SELECT ${root}, MAX(COALESCE(started_at, first_at)) AS uncertain_since FROM classified WHERE NOT valid GROUP BY ${root}
    ) SELECT machine_id, source_id, filesystem_id, root_path, metadata_json, completed_at, NULL AS uncertain_since
      FROM completions WHERE position = 1
    UNION ALL SELECT machine_id, source_id, filesystem_id, root_path, NULL, NULL, uncertain_since FROM uncertainty`;
  const completions = new Map<string, { observedAt: string; paths: Set<string> }>();
  const uncertainty = new Map<string, string>();
  for (const row of db.prepare(sql).iterate(...where.values)) {
    const key = JSON.stringify([row.machine_id, row.source_id, row.filesystem_id, row.root_path]);
    if (row.uncertain_since !== null) { uncertainty.set(key, string(row.uncertain_since)); continue; }
    const observation = parseObservation(JSON.parse(string(row.metadata_json)));
    if (observation.evidence.kind !== "inventory-snapshot") throw new Error("Invalid inventory projection");
    completions.set(key, { observedAt: string(row.completed_at), paths: new Set(readInventoryCompletionPaths(db, { source: source(row), identity: observation.evidence }, filter)) });
  }
  return { completions, uncertainty };
}

function isCurrentInventory(db: DatabaseSync, filter: DashboardFilter): boolean {
  if (filter.toObservedAt === undefined) return true;
  const domain = inventoryWhere(filter, "s", false);
  const latest = db.prepare(`SELECT MAX(s.observed_at) AS at FROM inventory_scan_facts s WHERE ${domain.sql}`).get(...domain.values)?.at;
  return typeof latest !== "string" || latest <= filter.toObservedAt;
}

function readCurrentInventoryState(db: DatabaseSync, filter: DashboardFilter): InventoryState {
  const values = filter.machineId === undefined ? [] : [filter.machineId];
  const where = filter.machineId === undefined ? "1 = 1" : "machine_id = ?";
  const root = "machine_id, source_id, filesystem_id, root_path";
  const sameRoot = "c.machine_id = r.machine_id AND c.source_id = r.source_id AND c.filesystem_id = r.filesystem_id AND c.root_path = r.root_path";
  const rows = db.prepare(`WITH roots AS (SELECT DISTINCT ${root} FROM inventory_scan_current WHERE ${where})
    SELECT r.*, c.membership_id, c.completed_at,
      (SELECT COALESCE(started_at, first_at) FROM inventory_scan_current c WHERE ${sameRoot} AND membership_id IS NULL
        ORDER BY COALESCE(started_at, first_at) DESC LIMIT 1) AS uncertain_since
    FROM roots r LEFT JOIN inventory_scan_current c ON c.rowid = (
      SELECT c.rowid FROM inventory_scan_current c WHERE ${sameRoot} AND membership_id IS NOT NULL
        ORDER BY completed_at DESC, first_at, first_producer, first_sequence, first_observation LIMIT 1)`).iterate(...values);
  const completions = new Map<string, { observedAt: string; paths: Set<string> }>();
  const uncertainty = new Map<string, string>();
  for (const row of rows) {
    const key = JSON.stringify([row.machine_id, row.source_id, row.filesystem_id, row.root_path]);
    if (row.uncertain_since !== null) uncertainty.set(key, string(row.uncertain_since));
    if (row.membership_id !== null) completions.set(key, { observedAt: string(row.completed_at), paths: new Set(readMembershipPaths(db, string(row.membership_id))) });
  }
  return { completions, uncertainty };
}

export function* readInventoryLocationHistory(db: DatabaseSync, filter: DashboardFilter): Generator<InventoryLocationHistory> {
  const historical = !isCurrentInventory(db, filter);
  const compact = !historical && filter.projectCwd === undefined && filter.sessionId === undefined && filter.runId === undefined;
  const where = inventoryWhere(filter, "b", false);
  const values = [...where.values];
  let selected = `SELECT b.machine_id, b.source_id, b.variant_id, b.first_at, b.last_at, b.producer_id, b.sequence, b.observation_id, b.resource_order
    FROM ${compact ? "inventory_location_current" : "inventory_location_buckets"} b WHERE ${where.sql}`;
  if (!compact) {
    const raw = inventoryWhere(filter, "s");
    let eligible = "s.positive_projection = 1";
    if (historical && filter.toObservedAt !== undefined) {
      const boundaryBucket = analyticsHourBucket(filter.toObservedAt);
      selected += " AND b.bucket_start != ? AND b.last_at <= ?";
      values.push(boundaryBucket, filter.toObservedAt);
      eligible = "(s.positive_projection = 1 OR s.observed_at >= ?)";
      raw.values.push(boundaryBucket.startsWith("raw:") ? filter.toObservedAt : boundaryBucket);
    }
    selected += ` UNION ALL SELECT s.machine_id, s.source_id, v.id, s.observed_at, s.observed_at, s.producer_id, s.sequence, s.observation_id, j.key
      FROM inventory_scan_facts s JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
      JOIN json_each(e.payload, '$.evidence.resources') j JOIN inventory_location_variants v ON v.location = j.value
      WHERE ${raw.sql} AND s.phase = 'batch' AND ${eligible}`;
    values.push(...raw.values);
  }
  const sql = `WITH selected AS (${selected}), ranked AS (SELECT *, MIN(first_at) OVER (PARTITION BY machine_id, source_id, variant_id) AS first_seen,
      ROW_NUMBER() OVER (PARTITION BY machine_id, source_id, variant_id ORDER BY last_at DESC, producer_id DESC, sequence DESC, observation_id DESC, resource_order DESC) AS position FROM selected)
    SELECT r.*, v.location FROM ranked r JOIN inventory_location_variants v ON v.id = r.variant_id WHERE r.position = 1
    ORDER BY r.last_at, r.producer_id, r.sequence, r.observation_id, r.resource_order`;
  for (const row of db.prepare(sql).iterate(...values)) {
    const resource: unknown = JSON.parse(string(row.location));
    if (!isResourceLocation(resource)) throw new Error("Invalid inventory location projection");
    yield { ...source(row), resource, firstAt: string(row.first_seen), lastAt: string(row.last_at),
      producerId: string(row.producer_id), sequence: integer(row.sequence), observationId: string(row.observation_id) };
  }
}

export function readInventoryCompletionPaths(db: DatabaseSync, selected: { source: Source; identity: InventorySnapshotEvidence }, filter: DashboardFilter): string[] {
  const where = inventoryWhere(filter, "s");
  const identityValues = [selected.source.machineId, selected.source.sourceId, selected.identity.filesystemId, selected.identity.rootPath, selected.identity.scanId];
  const identity = "s.machine_id = ? AND s.source_id = ? AND s.filesystem_id = ? AND s.root_path = ? AND s.scan_id = ?";
  const membership = db.prepare(`SELECT s.membership_id FROM inventory_scan_facts s WHERE ${identity} AND s.membership_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM inventory_scan_facts s WHERE ${identity} AND NOT (${where.sql})) LIMIT 1`)
    .get(...identityValues, ...identityValues, ...where.values)?.membership_id;
  if (typeof membership === "string") return readMembershipPaths(db, membership);
  return db.prepare(`SELECT DISTINCT json_extract(j.value, '$.canonicalPath') AS path FROM inventory_scan_facts s
    JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
    JOIN json_each(e.payload, '$.evidence.resources') j WHERE ${where.sql} AND s.machine_id = ? AND s.source_id = ? AND s.filesystem_id = ?
      AND s.root_path = ? AND s.scan_id = ? AND s.phase = 'batch'`).all(...where.values, selected.source.machineId, selected.source.sourceId,
    selected.identity.filesystemId, selected.identity.rootPath, selected.identity.scanId).map(row => string(row.path));
}

function readMembershipPaths(db: DatabaseSync, membership: string): string[] {
  return db.prepare(`SELECT DISTINCT json_extract(v.location, '$.canonicalPath') AS path
    FROM inventory_membership_members m JOIN inventory_location_variants v ON v.id = m.variant_id WHERE m.membership_id = ?`)
    .all(membership).map(row => string(row.path));
}

function inventoryWhere(filter: DashboardFilter, alias: string, asOf = true): { sql: string; values: SqlValue[] } {
  const clauses = ["1 = 1"]; const values: SqlValue[] = [];
  const add = (sql: string, ...parameters: SqlValue[]) => { clauses.push(sql.replaceAll("s.", `${alias}.`)); values.push(...parameters); };
  if (filter.machineId !== undefined) add("s.machine_id = ?", filter.machineId);
  if (asOf && filter.toObservedAt !== undefined) add("s.observed_at <= ?", filter.toObservedAt);
  if ([filter.host, filter.projectCwd, filter.sessionId, filter.runId, filter.modelId, filter.modelProvider].some(value => value !== undefined)) add("s.visibility != 'unassigned'");
  if (filter.host !== undefined) add("(s.host = ? OR s.host = 'unknown')", filter.host);
  if (filter.projectCwd !== undefined) add("(s.project_cwd = ? OR s.visibility = 'account')", filter.projectCwd);
  if (filter.sessionId !== undefined) add("(s.session_id IS ? OR s.visibility = 'account')", filter.sessionId);
  if (filter.runId !== undefined) add("(s.run_id IS ? OR s.visibility = 'account')", filter.runId);
  return { sql: clauses.join(" AND "), values };
}

function source(row: Record<string, unknown>): Source { return { machineId: parseMachineId(row.machine_id), sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id) }; }
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid inventory string"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid inventory integer"); return value; }
function digest(values: readonly unknown[]): string { return createHash("sha256").update(JSON.stringify(values)).digest("hex"); }
