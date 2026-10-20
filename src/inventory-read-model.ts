import { createHash } from "node:crypto";
import { analyticsHourBucket } from "./analytics-time.js";
import type { DatabaseSync } from "node:sqlite";
import type { DashboardFilter, Observation } from "./domain.js";
import type { ContentFact } from "./content-analytics.js";
import type { InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";
import { isResourceLocation, parseMachineId, parseObservation, parseSourceId } from "./observation.js";

type Source = Pick<ContentFact, "machineId" | "sourceId">;
type SqlValue = string | number | null;
export type InventoryFact = { source: Source; observation: Observation & { evidence: InventorySnapshotEvidence }; digest: string | null };
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
  db.prepare("INSERT INTO inventory_scan_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    source.machineId, source.sourceId, observation.id, evidence.filesystemId, evidence.rootPath, evidence.scanId,
    observation.host ?? "unknown", observation.scope.projectCwd, observation.scope.sessionId, observation.scope.runId, evidence.scope,
    observation.observedAt, observation.producerId, observation.sequence, evidence.phase,
    evidence.phase === "batch" ? digest([JSON.stringify(evidence.resources)]) : null, JSON.stringify(metadata),
  );
  if (evidence.phase !== "batch") return;
  const insertVariant = db.prepare("INSERT INTO inventory_location_variants(location) VALUES (?) ON CONFLICT(location) DO UPDATE SET location = excluded.location RETURNING id");
  const upsert = db.prepare(`INSERT INTO inventory_location_buckets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_key, bucket_start) DO UPDATE SET
    producer_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.producer_id ELSE producer_id END,
    sequence = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.sequence ELSE sequence END,
    observation_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.observation_id ELSE observation_id END,
    resource_order = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id, excluded.resource_order) > (last_at, producer_id, sequence, observation_id, resource_order) THEN excluded.resource_order ELSE resource_order END,
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`);
  for (const [resourceOrder, resource] of evidence.resources.entries()) {
    const variant = integer(insertVariant.get(JSON.stringify(resource))?.id);
    const key = digest([source.machineId, source.sourceId, observation.host ?? "unknown", observation.scope.projectCwd,
      observation.scope.sessionId, observation.scope.runId, evidence.scope, variant]);
    upsert.run(key, analyticsHourBucket(observation.observedAt), source.machineId, source.sourceId, variant, observation.host ?? "unknown",
      observation.scope.projectCwd, observation.scope.sessionId, observation.scope.runId, evidence.scope,
      observation.observedAt, observation.observedAt, observation.producerId, observation.sequence, observation.id, resourceOrder);
  }
}

export function* readInventoryScanFacts(db: DatabaseSync, filter: DashboardFilter): Generator<InventoryFact> {
  const where = inventoryWhere(filter, "s");
  for (const row of db.prepare(`SELECT s.machine_id, s.source_id, s.metadata_json, s.batch_digest FROM inventory_scan_facts s
    WHERE ${where.sql} ORDER BY s.observed_at, s.producer_id, s.sequence, s.observation_id`).iterate(...where.values)) {
    const observation = parseObservation(JSON.parse(string(row.metadata_json)));
    if (observation.evidence.kind !== "inventory-snapshot") throw new Error("Invalid inventory projection");
    yield { source: source(row), observation: { ...observation, evidence: observation.evidence }, digest: row.batch_digest === null ? null : string(row.batch_digest) };
  }
}

export function* readInventoryLocationHistory(db: DatabaseSync, filter: DashboardFilter): Generator<InventoryLocationHistory> {
  const where = inventoryWhere(filter, "b", false);
  const values = [...where.values];
  const latest = filter.toObservedAt === undefined ? undefined : db.prepare("SELECT observed_at FROM inventory_scan_facts ORDER BY observed_at DESC LIMIT 1").get()?.observed_at;
  const historical = filter.toObservedAt !== undefined && typeof latest === "string" && latest > filter.toObservedAt;
  let selected = `SELECT b.machine_id, b.source_id, b.variant_id, b.first_at, b.last_at, b.producer_id, b.sequence, b.observation_id, b.resource_order
    FROM inventory_location_buckets b WHERE ${where.sql}`;
  if (historical && filter.toObservedAt !== undefined) {
    const boundaryBucket = analyticsHourBucket(filter.toObservedAt);
    selected += " AND b.bucket_start != ? AND b.last_at <= ?";
    values.push(boundaryBucket, filter.toObservedAt);
    const partial = inventoryWhere(filter, "s");
    selected += ` UNION ALL SELECT s.machine_id, s.source_id, v.id, s.observed_at, s.observed_at, s.producer_id, s.sequence, s.observation_id, j.key
      FROM inventory_scan_facts s JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
      JOIN json_each(e.payload, '$.evidence.resources') j JOIN inventory_location_variants v ON v.location = j.value
      WHERE ${partial.sql} AND s.phase = 'batch' AND s.observed_at >= ?`;
    values.push(...partial.values, boundaryBucket.startsWith("raw:") ? filter.toObservedAt : boundaryBucket);
  }
  const sql = historical ? `WITH selected AS (${selected}), ranked AS (SELECT *, MIN(first_at) OVER (PARTITION BY machine_id, source_id, variant_id) AS first_seen,
      ROW_NUMBER() OVER (PARTITION BY machine_id, source_id, variant_id ORDER BY last_at DESC, producer_id DESC, sequence DESC, observation_id DESC, resource_order DESC) AS position FROM selected)
    SELECT r.*, v.location FROM ranked r JOIN inventory_location_variants v ON v.id = r.variant_id WHERE r.position = 1 ORDER BY r.last_at, r.producer_id, r.sequence, r.observation_id, r.resource_order`
    : `WITH totals AS (SELECT b.machine_id, b.source_id, b.variant_id, MIN(b.first_at) AS first_seen
      FROM inventory_location_buckets b WHERE ${where.sql} GROUP BY b.machine_id, b.source_id, b.variant_id)
      SELECT r.*, t.first_seen, v.location FROM totals t JOIN inventory_location_buckets r ON r.rowid = (
        SELECT b.rowid FROM inventory_location_buckets b WHERE ${where.sql} AND b.machine_id = t.machine_id AND b.source_id = t.source_id
          AND b.variant_id = t.variant_id ORDER BY b.last_at DESC, b.producer_id DESC, b.sequence DESC, b.observation_id DESC, b.resource_order DESC LIMIT 1)
      JOIN inventory_location_variants v ON v.id = t.variant_id ORDER BY r.last_at, r.producer_id, r.sequence, r.observation_id, r.resource_order`;
  if (!historical) values.push(...where.values);
  for (const row of db.prepare(sql).iterate(...values)) {
    const resource: unknown = JSON.parse(string(row.location));
    if (!isResourceLocation(resource)) throw new Error("Invalid inventory location projection");
    yield { ...source(row), resource, firstAt: string(row.first_seen), lastAt: string(row.last_at),
      producerId: string(row.producer_id), sequence: integer(row.sequence), observationId: string(row.observation_id) };
  }
}

export function readInventoryCompletionPaths(db: DatabaseSync, selected: { source: Source; identity: InventorySnapshotEvidence }, filter: DashboardFilter): string[] {
  const where = inventoryWhere(filter, "s");
  return db.prepare(`SELECT DISTINCT json_extract(j.value, '$.canonicalPath') AS path FROM inventory_scan_facts s
    JOIN resource_events e ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
    JOIN json_each(e.payload, '$.evidence.resources') j WHERE ${where.sql} AND s.machine_id = ? AND s.source_id = ? AND s.filesystem_id = ?
      AND s.root_path = ? AND s.scan_id = ? AND s.phase = 'batch'`).all(...where.values, selected.source.machineId, selected.source.sourceId,
    selected.identity.filesystemId, selected.identity.rootPath, selected.identity.scanId).map(row => string(row.path));
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
