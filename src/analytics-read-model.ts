import { createHash } from "node:crypto";
import { analyticsEvidenceTime, analyticsHourBucket } from "./analytics-time.js";
import type { DatabaseSync } from "node:sqlite";
import type { DashboardFilter, Observation } from "./domain.js";
import type { ContentFact, ContentInterval, ContentMeasure } from "./content-analytics.js";
import type { ResourceAccessEvidence } from "./resource-domain.js";
import { parseMachineId, parseObservation, parseSourceId } from "./observation.js";
import { createInventoryReadModel, recordInventoryFact } from "./inventory-read-model.js";

type StoredSource = Pick<ContentFact, "machineId" | "sourceId">;
type SqlValue = string | number | null;

export function createAnalyticsReadModel(db: DatabaseSync): void {
  db.function("hotplate_resource_group", { varargs: true }, (...columns) => groupKey(columns));
  db.function("hotplate_resource_bucket", value => analyticsHourBucket(string(value)));
  db.exec(`CREATE TABLE IF NOT EXISTS resource_access_facts (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, observation_id TEXT NOT NULL,
    host TEXT NOT NULL, observed_at TEXT NOT NULL, project_cwd TEXT NOT NULL, session_id TEXT, run_id TEXT,
    scope_json TEXT NOT NULL, producer_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    resource_json TEXT NOT NULL, mechanism TEXT NOT NULL, access TEXT NOT NULL, outcome TEXT NOT NULL,
    attribution TEXT NOT NULL, model_provider TEXT, model_id TEXT, evidence_json TEXT NOT NULL, group_key TEXT NOT NULL, bucket_start TEXT NOT NULL, display_key TEXT NOT NULL,
    PRIMARY KEY(machine_id, source_id, observation_id),
    FOREIGN KEY(machine_id, source_id, observation_id) REFERENCES observations(machine_id, source_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS resource_access_host_time_idx ON resource_access_facts(host, observed_at);
  CREATE INDEX IF NOT EXISTS resource_access_model_time_idx ON resource_access_facts(model_provider, model_id, observed_at);
  CREATE INDEX IF NOT EXISTS resource_access_scope_time_idx ON resource_access_facts(project_cwd, session_id, run_id, observed_at);
  CREATE INDEX IF NOT EXISTS resource_access_time_idx ON resource_access_facts(observed_at);
  CREATE INDEX IF NOT EXISTS resource_access_bucket_idx ON resource_access_facts(bucket_start, access);
  CREATE INDEX IF NOT EXISTS resource_access_tool_time_idx ON resource_access_facts(observed_at) WHERE access NOT IN ('open', 'access');
  CREATE INDEX IF NOT EXISTS resource_access_group_idx ON resource_access_facts(group_key, bucket_start, observed_at DESC, producer_id DESC, sequence DESC, observation_id DESC, machine_id, source_id);
  CREATE INDEX IF NOT EXISTS resource_access_display_idx ON resource_access_facts(display_key, bucket_start, observed_at);
  CREATE INDEX IF NOT EXISTS resource_access_category_scope_idx ON resource_access_facts(access, machine_id, project_cwd, session_id, run_id, observed_at);
  CREATE TABLE IF NOT EXISTS filesystem_access_buckets (
    group_key TEXT NOT NULL, bucket_start TEXT NOT NULL, machine_id TEXT NOT NULL, source_id TEXT NOT NULL,
    observation_id TEXT NOT NULL, producer_id TEXT NOT NULL, sequence INTEGER NOT NULL, fact_count INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    display_key TEXT NOT NULL, project_cwd TEXT NOT NULL, session_id TEXT, run_id TEXT, host TEXT NOT NULL, model_provider TEXT, model_id TEXT,
    PRIMARY KEY(group_key, bucket_start)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS observer_coverage_facts (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, observation_id TEXT NOT NULL,
    filesystem_id TEXT NOT NULL, observer_id TEXT NOT NULL, mechanism TEXT NOT NULL, root_set TEXT NOT NULL,
    PRIMARY KEY(machine_id, source_id, observation_id),
    FOREIGN KEY(machine_id, source_id, observation_id) REFERENCES observations(machine_id, source_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS observer_coverage_identity_idx ON observer_coverage_facts(machine_id, source_id, filesystem_id, observer_id, mechanism, root_set);
  INSERT OR REPLACE INTO resource_access_facts
    SELECT o.machine_id, o.source_id, o.id, o.host, o.observed_at, o.project_cwd, o.session_id, o.run_id,
      json_extract(e.payload, '$.scope'), o.producer_id, o.sequence,
      json_extract(e.payload, '$.evidence.resource'), json_extract(e.payload, '$.evidence.mechanism'),
      json_extract(e.payload, '$.evidence.access'), json_extract(e.payload, '$.evidence.outcome'),
      json_extract(e.payload, '$.evidence.attribution'), json_extract(e.payload, '$.evidence.model.provider'),
      json_extract(e.payload, '$.evidence.model.id'), CASE WHEN json_extract(e.payload, '$.evidence.access') IN ('open', 'access') THEN '{}' ELSE json_extract(e.payload, '$.evidence') END,
      hotplate_resource_group(o.machine_id, o.source_id, o.host, o.project_cwd, o.session_id, o.run_id,
        json_extract(e.payload, '$.evidence.resource'), json_extract(e.payload, '$.evidence.mechanism'),
        json_extract(e.payload, '$.evidence.access'), json_extract(e.payload, '$.evidence.outcome'),
        json_extract(e.payload, '$.evidence.attribution'), json_extract(e.payload, '$.evidence.model.provider'), json_extract(e.payload, '$.evidence.model.id')), hotplate_resource_bucket(o.observed_at),
      hotplate_resource_group(o.machine_id, o.source_id, o.host, json_extract(e.payload, '$.evidence.resource'),
        json_extract(e.payload, '$.evidence.mechanism'), json_extract(e.payload, '$.evidence.access'), json_extract(e.payload, '$.evidence.outcome'),
        json_extract(e.payload, '$.evidence.attribution'), json_extract(e.payload, '$.evidence.model.provider'), json_extract(e.payload, '$.evidence.model.id'))
    FROM observations o JOIN resource_events e ON e.machine_id = o.machine_id AND e.source_id = o.source_id AND e.observation_id = o.id
    WHERE o.evidence_kind = 'resource-access';
  INSERT OR REPLACE INTO observer_coverage_facts
    SELECT o.machine_id, o.source_id, o.id, json_extract(e.payload, '$.evidence.filesystemId'),
      json_extract(e.payload, '$.evidence.observerId'), json_extract(e.payload, '$.evidence.mechanism'), json_extract(e.payload, '$.evidence.rootPaths')
    FROM observations o JOIN resource_events e ON e.machine_id = o.machine_id AND e.source_id = o.source_id AND e.observation_id = o.id
    WHERE o.evidence_kind = 'observer-coverage';
  INSERT OR REPLACE INTO filesystem_access_buckets
    WITH ranked AS (SELECT group_key, bucket_start, machine_id, source_id, observation_id, producer_id, sequence, display_key, project_cwd, session_id, run_id, host, model_provider, model_id,
      COUNT(*) OVER (PARTITION BY group_key, bucket_start) AS fact_count,
      MIN(observed_at) OVER (PARTITION BY group_key, bucket_start) AS first_at, observed_at AS last_at,
      ROW_NUMBER() OVER (PARTITION BY group_key, bucket_start ORDER BY observed_at DESC, producer_id DESC, sequence DESC, observation_id DESC) AS position
      FROM resource_access_facts WHERE access IN ('open', 'access'))
    SELECT group_key, bucket_start, machine_id, source_id, observation_id, producer_id, sequence, fact_count, first_at, last_at, display_key, project_cwd, session_id, run_id, host, model_provider, model_id FROM ranked WHERE position = 1;`);
  createInventoryReadModel(db);
}

export function recordAnalyticsFact(db: DatabaseSync, source: StoredSource, observation: Observation): void {
  const evidence = observation.evidence;
  if (evidence.kind === "resource-access") {
    const resourceJson = JSON.stringify(evidence.resource);
    const key = groupKey([source.machineId, source.sourceId, observation.host ?? "unknown", observation.scope.projectCwd,
      observation.scope.sessionId, observation.scope.runId, resourceJson, evidence.mechanism, evidence.access, evidence.outcome,
      evidence.attribution, evidence.model?.provider ?? null, evidence.model?.id ?? null]);
    const bucket = analyticsHourBucket(observation.observedAt);
    const displayKey = groupKey([source.machineId, source.sourceId, observation.host ?? "unknown", resourceJson,
      evidence.mechanism, evidence.access, evidence.outcome, evidence.attribution, evidence.model?.provider ?? null, evidence.model?.id ?? null]);
    db.prepare(`INSERT INTO resource_access_facts VALUES (${Array(22).fill("?").join(",")})`).run(
      source.machineId, source.sourceId, observation.id, observation.host ?? "unknown", observation.observedAt,
      observation.scope.projectCwd, observation.scope.sessionId, observation.scope.runId, JSON.stringify(observation.scope),
      observation.producerId, observation.sequence, resourceJson, evidence.mechanism, evidence.access,
      evidence.outcome, evidence.attribution, evidence.model?.provider ?? null, evidence.model?.id ?? null,
      evidence.access === "open" || evidence.access === "access" ? "{}" : JSON.stringify(evidence),
      key, bucket, displayKey,
    );
    if (evidence.access === "open" || evidence.access === "access") db.prepare(`INSERT INTO filesystem_access_buckets VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_key, bucket_start) DO UPDATE SET
      observation_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id) > (last_at, producer_id, sequence, observation_id) THEN excluded.observation_id ELSE observation_id END,
      producer_id = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id) > (last_at, producer_id, sequence, observation_id) THEN excluded.producer_id ELSE producer_id END,
      sequence = CASE WHEN (excluded.last_at, excluded.producer_id, excluded.sequence, excluded.observation_id) > (last_at, producer_id, sequence, observation_id) THEN excluded.sequence ELSE sequence END,
      fact_count = fact_count + 1, first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`)
      .run(key, bucket, source.machineId, source.sourceId, observation.id, observation.producerId, observation.sequence, observation.observedAt, observation.observedAt, displayKey, observation.scope.projectCwd,
        observation.scope.sessionId, observation.scope.runId, observation.host ?? "unknown", evidence.model?.provider ?? null, evidence.model?.id ?? null);
  } else if (evidence.kind === "observer-coverage") {
    db.prepare("INSERT INTO observer_coverage_facts VALUES (?, ?, ?, ?, ?, ?, ?)").run(source.machineId, source.sourceId, observation.id,
      evidence.filesystemId, evidence.observerId, evidence.mechanism, JSON.stringify(evidence.rootPaths));
  } else if (evidence.kind === "inventory-snapshot") {
    recordInventoryFact(db, source, { ...observation, evidence });
  }
}

export function* readResourceAccessFacts(db: DatabaseSync, filter: DashboardFilter, mode: { kind: "resources" } | { kind: "content"; selection: ContentInterval; measure: ContentMeasure }): Generator<ContentFact<ResourceAccessEvidence>> {
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  const groups = ["b.display_key"];
  const boundaries = [filter.fromObservedAt, filter.toObservedAt].filter((value): value is string => value !== undefined);
  if (mode.kind === "content" && mode.selection.kind === "interval") boundaries.push(mode.selection.startAt, mode.selection.endAt);
  const timeValues: SqlValue[] = [];
  const timeColumns: string[] = [];
  for (const [index, boundary] of boundaries.entries()) {
    timeColumns.push(`CASE WHEN b.last_at < ? THEN 0 WHEN b.first_at > ? THEN 2 ELSE 1 END AS time_scope_${index}`);
    timeValues.push(boundary, boundary); groups.push(`b.time_scope_${index}`);
  }
  const needsHourly = mode.kind === "content" && (mode.measure === "activity" || mode.measure === "fsOpens" || mode.measure === "fsAccesses");
  if (needsHourly) groups.push("b.bucket_start");
  else {
    timeColumns.push("CASE WHEN b.bucket_start LIKE 'raw:%' THEN b.bucket_start ELSE '' END AS partial_bucket");
    groups.push("b.partial_bucket");
  }
  const scope = (column: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (mode.kind === "content") { clauses.push(`b.${column} IS ?`); values.push(value); }
    else groups.push(`b.${column}`);
  };
  if (filter.machineId !== undefined) { clauses.push("b.machine_id = ?"); values.push(filter.machineId); }
  scope("project_cwd", filter.projectCwd); scope("session_id", filter.sessionId); scope("run_id", filter.runId);
  const scopeClauses = [...clauses]; const scopeValues = [...values];
  const boundaryBuckets = new Set<string>();
  for (const boundary of boundaries) {
    const time = Date.parse(boundary);
    if (Number.isFinite(time)) boundaryBuckets.add(new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString());
    if (mode.kind === "resources" && /^\d{4}-\d\d-\d\dT\d\d/u.test(boundary)) boundaryBuckets.add(`${boundary.slice(0, 13)}:00:00.000Z`);
  }
  if (boundaryBuckets.size) { clauses.push(`b.bucket_start NOT IN (${[...boundaryBuckets].map(() => "?").join(",")})`); values.push(...boundaryBuckets); }
  const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
  const partition = groups.join(", ");
  const rows = db.prepare(`WITH scoped AS (SELECT b.*${timeColumns.length ? ", " + timeColumns.join(", ") : ""} FROM filesystem_access_buckets b WHERE ${where}), ranked AS (SELECT b.machine_id, b.source_id, b.observation_id,
      SUM(b.fact_count) OVER (PARTITION BY ${partition}) AS fact_count,
      MIN(b.first_at) OVER (PARTITION BY ${partition}) AS first_at,
      MAX(b.last_at) OVER (PARTITION BY ${partition}) AS last_at,
      ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY b.last_at DESC, b.producer_id DESC, b.sequence DESC, b.observation_id DESC) AS position
      FROM scoped b)
    SELECT a.*, r.fact_count, r.first_at, r.last_at FROM ranked r JOIN resource_access_facts a
      ON a.machine_id = r.machine_id AND a.source_id = r.source_id AND a.observation_id = r.observation_id WHERE r.position = 1`).iterate(...timeValues, ...values);
  const facts: ContentFact<ResourceAccessEvidence>[] = [];
  const include = (row: Record<string, unknown>) => {
    if (mode.kind === "resources" && filter.toObservedAt !== undefined && string(row.last_at) > filter.toObservedAt) return;
    facts.push(resourceFact(row, mode.kind));
  };
  for (const row of rows) include(row);
  const rawScope = scopeClauses.map(clause => clause.replaceAll("b.", "a."));
  if (boundaryBuckets.size) {
    const partialWhere = [...rawScope, "a.access IN ('open', 'access')", `a.bucket_start IN (${[...boundaryBuckets].map(() => "?").join(",")})`];
    for (const row of db.prepare(`SELECT a.*, 1 AS fact_count, observed_at AS first_at, observed_at AS last_at
      FROM resource_access_facts a WHERE ${partialWhere.join(" AND ")}`).iterate(...scopeValues, ...boundaryBuckets)) include(row);
  }
  const rawClauses = rawScope;
  for (const row of db.prepare(`SELECT a.*, 1 AS fact_count, observed_at AS first_at, observed_at AS last_at
    FROM resource_access_facts a WHERE ${rawClauses.length ? rawClauses.join(" AND ") + " AND " : ""}access NOT IN ('open', 'access')`).iterate(...scopeValues)) include(row);
  facts.sort((left, right) => compare(left.observedAt, right.observedAt) || compare(left.producerId, right.producerId)
    || left.sequence - right.sequence || compare(left.id, right.id));
  yield* facts;
}

export function readResourceProjectFacets(db: DatabaseSync, filter: DashboardFilter): string[] {
  const clauses = ["access IN ('open', 'access')"]; const values: SqlValue[] = [];
  for (const [column, value] of [["machine_id", filter.machineId], ["project_cwd", filter.projectCwd], ["session_id", filter.sessionId], ["run_id", filter.runId]] as const) {
    if (value !== undefined) { clauses.push(`${column} IS ?`); values.push(value); }
  }
  if (filter.fromObservedAt !== undefined || filter.toObservedAt !== undefined) {
    db.function("hotplate_analytics_time", value => analyticsEvidenceTime(string(value)));
    for (const [value, comparison] of [[filter.fromObservedAt, ">="], [filter.toObservedAt, "<="]] as const) {
      if (value === undefined) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time)) { clauses.push(`hotplate_analytics_time(observed_at) ${comparison} ?`); values.push(time); }
      else clauses.push("hotplate_analytics_time(observed_at) IS NOT NULL");
    }
  }
  return db.prepare(`SELECT DISTINCT project_cwd FROM resource_access_facts WHERE ${clauses.join(" AND ")}`).all(...values).map(row => string(row.project_cwd));
}

function resourceFact(row: Record<string, unknown>, mode: "resources" | "content"): ContentFact<ResourceAccessEvidence> {
  const count = number(row.fact_count); const firstAt = string(row.first_at); const lastAt = string(row.last_at);
  const grouped = row.access === "open" || row.access === "access";
  const evidence: unknown = grouped ? {
    kind: "resource-access", resource: JSON.parse(string(row.resource_json)), mechanism: row.mechanism,
    access: row.access, outcome: row.outcome, attribution: row.attribution,
    model: row.model_provider === null || row.model_id === null ? null : { provider: row.model_provider, id: row.model_id },
    operationId: string(row.group_key), process: null,
  } : JSON.parse(string(row.evidence_json));
  const observation = parseObservation({ id: row.observation_id, producerId: row.producer_id, sequence: row.sequence,
    observedAt: mode === "resources" ? lastAt : firstAt, host: row.host, scope: JSON.parse(string(row.scope_json)), evidence });
  if (observation.evidence.kind !== "resource-access") throw new Error("Invalid resource analytics fact");
  return { ...observation, evidence: observation.evidence, machineId: parseMachineId(row.machine_id),
    sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id), aggregate: { count, lastObservedAt: lastAt } };
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function groupKey(columns: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(columns)).digest("hex");
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid analytics string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid analytics count");
  return value;
}
