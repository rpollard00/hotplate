import { BASELINE_PROTOCOL_VERSION, type TokenDigest } from "./network-protocol.js";
import { createHash } from "node:crypto";
import {
  isObservation, isInputSource, isGapReason, LOCAL_IDENTITY, LOCAL_SOURCE_ID,
  observationProtocolVersion, parseHostId, parseMachineId, parseSourceId, parseObservation, serializeObservation, validateEnrollment, validateNetworkIdentity,
  type ProtocolVersion,
} from "./observation.js";
import { existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createResourceSchema, recordResourceObservation, queryResources, queryResourceCoverage } from "./resource-store.js";
import type { ResourceView, ResourceCoverageView, ToolCoverageEvidence } from "./resource-domain.js";
import { buildContentAnalytics, buildContentTimelines, type ContentInput, type ContentFact, type ContentQuery, type ContentReport, type ContentSkillEvidence, type ContentTimelineRequest, type ContentTimelines } from "./content-analytics.js";
import { createSharedInventory } from "./inventory-membership.js";
import { createAnalyticsReadModel, readResourceAccessFacts, readResourceProjectFacets } from "./analytics-read-model.js";
import type {
  HostId,
  CaptureEnrollment,
  DashboardFilterOptions,
  MachineId,
  SourceId,
  SourceIdentity,
  CaptureHealthReasonRow,
  CaptureHealthView,
  CaptureWriteSummary,
  ChainFilter,
  ChainObservation,
  DashboardFilter,
  GapReason,
  HotplateStore,
  InputSource,
  ModelMatrixRow,
  ModelMatrixView,
  ModelRef,
  Observation,
  OverviewView,
  SkillChainRun,
  SkillChainStep,
  SkillChainView,
  SkillRef,
  SkillTableRow,
  SkillTableView,
} from "./domain.js";

const SCHEMA_VERSION = 10;
export const MAX_DYNAMIC_SOURCES = 10_000;
export const ENROLLMENTS_PER_MINUTE = 30;
const DEFAULT_BUSY_TIMEOUT_MS = 25;
const DEFAULT_BUSY_RETRIES = 3;
const STATISTICS_INTERVAL_MS = 60 * 60 * 1000;

type SqlValue = string | number | bigint | null;

type OpenHotplateStoreOptions = {
  databasePath?: string;
  busyTimeoutMs?: number;
  busyRetries?: number;
};

type ResolveDatabasePathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type HotplateReadonlyStore = Omit<HotplateStore, "record">;

export type HotplateReadOpenResult =
  | { kind: "ready"; databasePath: string; store: HotplateReadonlyStore }
  | { kind: "missing"; databasePath: string };

export function resolveHotplateDatabasePath(options: ResolveDatabasePathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.HOTPLATE_DB?.trim();
  if (override) {
    return resolve(override);
  }

  const dataHome = env.XDG_DATA_HOME?.trim() ? resolve(env.XDG_DATA_HOME) : join(options.homeDir ?? homedir(), ".local", "share");
  return join(dataHome, "hotplate", "analytics.sqlite");
}

export function openCaptureStore(args: { databasePath: string; enrollment: CaptureEnrollment }): HotplateStore {
  return openLocalWriter({ databasePath: args.databasePath }, validateEnrollment(args.enrollment));
}

export function openHotplateStore(options: OpenHotplateStoreOptions = {}): HotplateStore {
  return openLocalWriter(options);
}

function openLocalWriter(options: OpenHotplateStoreOptions, enrollment?: CaptureEnrollment): HotplateStore {
  const databasePath = options.databasePath ?? resolveHotplateDatabasePath();
  if (databasePath !== ":memory:") {
    createPrivateDirectory(dirname(databasePath));
  }

  const db = new DatabaseSync(databasePath, {
    timeout: boundedBusyTimeout(options.busyTimeoutMs),
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  secureDatabaseFiles(databasePath);

  return new SqliteHotplateStore({
    db,
    databasePath,
    readOnly: false,
    busyRetries: options.busyRetries ?? DEFAULT_BUSY_RETRIES,
    enrollment,
  });
}

export function openHotplateReadStore(options: Pick<OpenHotplateStoreOptions, "databasePath" | "busyTimeoutMs"> = {}): HotplateReadOpenResult {
  const databasePath = options.databasePath ?? resolveHotplateDatabasePath();
  if (databasePath !== ":memory:" && !existsSync(databasePath)) {
    return { kind: "missing", databasePath };
  }

  const db = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: boundedBusyTimeout(options.busyTimeoutMs),
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  const store = new SqliteHotplateStore({ db, databasePath, readOnly: true, busyRetries: 0 });
  return { kind: "ready", databasePath, store };
}

export function assertHotplateReadiness(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error("Hotplate database is missing. Start capture or restore the configured database.");
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: DEFAULT_BUSY_TIMEOUT_MS, allowExtension: false });
  try {
    db.exec("BEGIN");
    assertReadableSchema(db);
    const state = db.prepare("SELECT kind FROM database_state WHERE singleton = 1").get();
    if (state?.kind !== "local" && state?.kind !== "aggregate") throw new Error("Hotplate database has no valid installation state.");
    db.prepare("SELECT id FROM observations ORDER BY machine_id, source_id, id LIMIT 1").get();
  } finally {
    db.close();
  }
}

class SqliteHotplateStore implements HotplateStore {
  readonly #db: DatabaseSync;
  readonly #databasePath: string;
  readonly #readOnly: boolean;
  readonly #busyRetries: number;
  readonly #enrollment: CaptureEnrollment | undefined;
  #closed = false;

  constructor(options: { db: DatabaseSync; databasePath: string; readOnly: boolean; busyRetries: number; enrollment?: CaptureEnrollment | undefined }) {
    this.#db = options.db;
    this.#databasePath = options.databasePath;
    this.#readOnly = options.readOnly;
    this.#busyRetries = options.busyRetries;
    this.#enrollment = options.enrollment;
    try {
      execWithBusyRetry(this.#db, "PRAGMA foreign_keys = ON", this.#busyRetries);
      if (!this.#readOnly) {
        execWithBusyRetry(this.#db, "PRAGMA journal_mode = WAL", this.#busyRetries);
        execWithBusyRetry(this.#db, "PRAGMA synchronous = NORMAL", this.#busyRetries);
        migrate(this.#db, this.#busyRetries);
        configureWriter(this.#db, "local", this.#busyRetries, this.#enrollment);
        secureDatabaseFiles(this.#databasePath);
      } else {
        assertReadableSchema(this.#db);
        this.#db.exec("BEGIN");
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  async record(input: Observation | readonly Observation[], options: { signal?: AbortSignal } = {}): Promise<CaptureWriteSummary> {
    if (this.#closed || this.#readOnly || options.signal?.aborted) {
      return { accepted: 0, duplicate: 0, dropped: observationCount(input) };
    }

    const observations = Array.isArray(input) ? input : [input];
    const valid: Observation[] = [];
    let invalid = 0;
    for (const observation of observations) {
      if (isObservation(observation)) {
        valid.push(parseObservation(observation));
      } else {
        invalid += 1;
      }
    }

    if (valid.length === 0) {
      return { accepted: 0, duplicate: 0, dropped: invalid };
    }

    for (let attempt = 0; attempt <= this.#busyRetries; attempt += 1) {
      if (this.#closed || options.signal?.aborted) return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
      try {
        const written = this.#write(valid);
        return { ...written, dropped: invalid };
      } catch (error) {
        rollbackBestEffort(this.#db);
        if (!isBusyError(error) || attempt === this.#busyRetries) {
          return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
        }
        try {
          await delay(Math.min(5 * (attempt + 1), 25), undefined, { signal: options.signal });
        } catch {
          return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
        }
      }
    }

    return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
  }

  async queryFilterOptions(filter: DashboardFilter): Promise<DashboardFilterOptions> {
    assertOpen(this.#closed);
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (filter.machineId !== undefined) { params.push(filter.machineId); clauses.push("machine_id = ?"); }
    if (filter.host !== undefined) { params.push(filter.host); clauses.push("host = ?"); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const strings = (sql: string, values: readonly SqlValue[] = params): string[] => this.#db.prepare(sql).all(...values).map(row => requireString(row.value, "filter option"));
    const time = this.#db.prepare(`SELECT MIN(observed_at) AS first, MAX(observed_at) AS last FROM observations ${where}`).get(...params);
    const { host: _host, modelSelection: _selection, modelProvider: _provider, modelId: _modelId, ...facetFilter } = filter;
    const facets = observationWhere(facetFilter, ["AND evidence_kind IN ('read-result', 'read-attempt', 'skill-invocation')"]);
    const agentModelPairs = this.#db.prepare(`SELECT DISTINCT host, model_provider, model_id FROM observations ${facets.sql} ORDER BY host, model_provider, model_id`).all(...facets.params)
      .map(row => ({ host: parseHostId(requireString(row.host, "facet host")), model: modelFromColumns(row.model_provider, row.model_id) }));
    return {
      agentModelPairs,
      hosts: strings("SELECT DISTINCT host AS value FROM observations UNION SELECT DISTINCT host AS value FROM catalog_skills ORDER BY value", []).map(parseHostId),
      machines: strings("SELECT machine_id AS value FROM observations UNION SELECT machine_id AS value FROM catalog_skills ORDER BY value", []).map(parseMachineId),
      projects: strings(`SELECT project_cwd AS value FROM observations ${where} UNION SELECT project_cwd AS value FROM catalog_skills ${where} ORDER BY value`, [...params, ...params]),
      modelProviders: strings(`SELECT DISTINCT model_provider AS value FROM observations ${where || "WHERE 1 = 1"} AND model_provider IS NOT NULL ORDER BY value`),
      modelIds: strings(`SELECT DISTINCT model_id AS value FROM observations ${where || "WHERE 1 = 1"} AND model_id IS NOT NULL ORDER BY value`),
      timeRange: { firstObservedAt: nullableString(time?.first), lastObservedAt: nullableString(time?.last) },
    };
  }

  async queryOverview(filter: DashboardFilter): Promise<OverviewView> {
    assertOpen(this.#closed);
    const where = observationWhere(filter);
    const skillRunWhere = observationWhere(filter, ["AND evidence_kind IN ('wrapper-observed', 'read-result')"]);
    const catalogWhere = catalogWhereClause(filter);

    return {
      readAttemptCount: count(this.#db, `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'read-attempt'"]).sql}`, observationWhere(filter, ["AND evidence_kind = 'read-attempt'"]).params),
      skillInvocationCount: count(this.#db, `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'skill-invocation'"]).sql}`, observationWhere(filter, ["AND evidence_kind = 'skill-invocation'"]).params),
      observationCount: count(this.#db, `SELECT COUNT(*) AS value FROM observations ${where.sql}`, where.params),
      commandIntentCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'command-intent'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'command-intent'"]).params,
      ),
      rpcCommandIntentCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'command-intent'", "AND source = 'rpc'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'command-intent'", "AND source = 'rpc'"]).params,
      ),
      wrapperObservedCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'wrapper-observed'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'wrapper-observed'"]).params,
      ),
      readResultCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'read-result'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'read-result'"]).params,
      ),
      successfulReadCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'read-result'", "AND outcome = 'success'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'read-result'", "AND outcome = 'success'"]).params,
      ),
      failedReadCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'read-result'", "AND outcome = 'error'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'read-result'", "AND outcome = 'error'"]).params,
      ),
      uniqueObservedSkillRunActivations: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM (
          SELECT skill_name, skill_path, project_cwd, IFNULL(session_id, ''), segment_id, IFNULL(run_id, '')
          FROM observations ${skillRunWhere.sql} AND skill_name IS NOT NULL AND (run_id IS NOT NULL OR host IN ('unknown', 'pi')) AND (evidence_kind != 'read-result' OR outcome = 'success')
          GROUP BY host, machine_id, source_id, skill_name, skill_path, project_cwd, session_id, segment_id, run_id
        )`,
        skillRunWhere.params,
      ),
      catalogSkillCount: count(this.#db, `SELECT COUNT(*) AS value FROM (SELECT 1 FROM catalog_skills ${catalogWhere.sql} GROUP BY host, machine_id, project_cwd, skill_name, skill_path)`, catalogWhere.params),
      captureGapCount: count(
        this.#db,
        `SELECT COUNT(*) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'capture-gap'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'capture-gap'"]).params,
      ),
      droppedObservationCount: count(
        this.#db,
        `SELECT COALESCE(SUM(dropped), 0) AS value FROM observations ${observationWhere(filter, ["AND evidence_kind = 'capture-gap'"]).sql}`,
        observationWhere(filter, ["AND evidence_kind = 'capture-gap'"]).params,
      ),
      firstObservedAt: stringValue(firstRow(this.#db, `SELECT MIN(observed_at) AS value FROM observations ${where.sql}`, where.params)?.value),
      lastObservedAt: stringValue(firstRow(this.#db, `SELECT MAX(observed_at) AS value FROM observations ${where.sql}`, where.params)?.value),
    };
  }

  async querySkillTable(filter: DashboardFilter): Promise<SkillTableView> {
    assertOpen(this.#closed);
    const rows = new Map<string, MutableSkillTableRow>();
    const catalog = this.#db.prepare(`
      SELECT host, machine_id, skill_name, skill_path, skill_version, last_observed_at
      FROM catalog_skills ${catalogWhereClause(filter).sql}
      ORDER BY last_observed_at DESC, json_array(skill_version) DESC, machine_id, skill_name, skill_path
    `).all(...catalogWhereClause(filter).params);

    for (const row of catalog) {
      const skillName = requireString(row.skill_name, "skill_name");
      const canonicalPath = requireString(row.skill_path, "skill_path");
      const entry = getSkillRow(rows, parseHostId(row.host), parseMachineId(row.machine_id), skillName, canonicalPath, nullableString(row.skill_version));
      entry.cataloged = true;
      entry.lastObservedAt = latestTime(entry.lastObservedAt, nullableString(row.last_observed_at));
    }

    const where = observationWhere(filter, ["AND evidence_kind IN ('command-intent', 'wrapper-observed', 'read-result', 'read-attempt', 'skill-invocation')"]);
    const observationRows = this.#db.prepare(`
      SELECT * FROM observations ${where.sql}
      ORDER BY observed_at, producer_id, sequence, id
    `).all(...where.params);

    const activations = new Set<string>();
    for (const row of observationRows) {
      const kind = requireString(row.evidence_kind, "evidence_kind");
      const skillName = nullableString(row.skill_name);
      if (skillName === null) {
        continue;
      }
      const canonicalPath = nullableString(row.skill_path);
      const entry = getSkillRow(rows, parseHostId(row.host), parseMachineId(row.machine_id), skillName, canonicalPath, nullableString(row.skill_version));
      entry.lastObservedAt = latestTime(entry.lastObservedAt, requireString(row.observed_at, "observed_at"));

      if (kind === "read-attempt") { entry.readAttemptCount += 1; continue; }
      if (kind === "skill-invocation") { entry.skillInvocationCount += 1; continue; }
      if (kind === "command-intent") {
        entry.commandIntentCount += 1;
        const source = requireInputSource(row.source);
        if (source === "interactive") entry.interactiveCommandIntentCount += 1;
        if (source === "rpc") entry.rpcCommandIntentCount += 1;
        if (source === "extension") entry.extensionCommandIntentCount += 1;
        continue;
      }

      if (kind === "wrapper-observed") {
        entry.wrapperObservedCount += 1;
        addActivation(activations, entry, row);
        continue;
      }

      if (kind === "read-result") {
        entry.readResultCount += 1;
        if (row.outcome === "success") {
          entry.successfulReadCount += 1;
          addActivation(activations, entry, row);
        } else {
          entry.failedReadCount += 1;
        }
      }
    }

    for (const activation of activations) {
      const parts: unknown = JSON.parse(activation);
      if (!Array.isArray(parts) || typeof parts[0] !== "string") throw new Error("Invalid activation key");
      const key = parts[0];
      const entry = rows.get(key);
      if (entry) {
        entry.uniqueObservedRunActivations += 1;
      }
    }

    return {
      rows: [...rows.values()]
        .map(toSkillTableRow)
        .sort((left, right) => left.skillName.localeCompare(right.skillName) || nullLastCompare(left.canonicalPath, right.canonicalPath)),
    };
  }

  async queryModelMatrix(filter: DashboardFilter): Promise<ModelMatrixView> {
    assertOpen(this.#closed);
    const where = observationWhere(filter, ["AND evidence_kind = 'read-result'"]);
    const rows = this.#db.prepare(`
      SELECT
        host, machine_id,
        skill_name,
        skill_path,
        model_provider,
        model_id,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successful_read_count,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS failed_read_count,
        COUNT(*) AS read_result_count,
        COUNT(DISTINCT CASE WHEN outcome = 'success' AND (run_id IS NOT NULL OR host IN ('unknown', 'pi')) THEN json_array(host, machine_id, source_id, project_cwd, session_id, segment_id, run_id, skill_name, skill_path) END) AS unique_activations
      FROM observations ${where.sql} AND skill_name IS NOT NULL AND skill_path IS NOT NULL
      GROUP BY host, machine_id, skill_name, skill_path, model_provider, model_id
      ORDER BY skill_name, skill_path, model_provider, model_id
    `).all(...where.params);

    return {
      rows: rows.map((row): ModelMatrixRow => ({
        host: parseHostId(row.host),
        machineId: parseMachineId(row.machine_id),
        skillName: requireString(row.skill_name, "skill_name"),
        canonicalPath: requireString(row.skill_path, "skill_path"),
        model: modelFromColumns(row.model_provider, row.model_id),
        successfulReadCount: numberValue(row.successful_read_count),
        failedReadCount: numberValue(row.failed_read_count),
        readResultCount: numberValue(row.read_result_count),
        uniqueObservedRunActivations: numberValue(row.unique_activations),
      })),
    };
  }

  async querySkillChain(filter: ChainFilter): Promise<SkillChainView> {
    assertOpen(this.#closed);
    const where = chainBaseWhere(filter);
    const rows = this.#db.prepare(`
      SELECT * FROM observations ${where.sql}
        AND evidence_kind IN ('command-intent', 'wrapper-observed', 'read-result', 'read-attempt', 'skill-invocation', 'capture-gap')
      ORDER BY project_cwd, IFNULL(session_id, ''), segment_id, IFNULL(run_id, ''), observed_at, IFNULL(turn_id, ''), IFNULL(leaf_id, ''), producer_id, sequence, id
    `).all(...where.params);

    const runs = new Map<string, MutableChainRun>();
    for (const row of rows) {
      const run = getChainRun(runs, row);
      const kind = requireString(row.evidence_kind, "evidence_kind");
      if (kind === "capture-gap") {
        flushFilteredGap(run);
        run.steps.push({
          kind: "gap",
          observedAt: requireString(row.observed_at, "observed_at"),
          omitted: numberValue(row.dropped),
          reason: requireGapReason(row.gap_reason),
        });
        continue;
      }

      const evidence = evidenceFromRow(row);
      if (!chainEvidenceIncluded(evidence, filter)) {
        run.filteredGap += 1;
        continue;
      }

      flushFilteredGap(run);
      addChainObservation(run, {
        observationId: requireString(row.id, "id"),
        observedAt: requireString(row.observed_at, "observed_at"),
        sequence: numberValue(row.sequence),
        evidence,
      }, nullableString(row.turn_id), nullableString(row.leaf_id));
    }

    for (const run of runs.values()) {
      flushFilteredGap(run);
    }

    return { runs: [...runs.values()].map(toSkillChainRun) };
  }

  async queryCaptureHealth(filter: DashboardFilter): Promise<CaptureHealthView> {
    assertOpen(this.#closed);
    const where = observationWhere(filter, ["AND evidence_kind = 'capture-gap'"]);
    const rows = this.#db.prepare(`
      SELECT gap_reason, COUNT(*) AS event_count, COALESCE(SUM(dropped), 0) AS dropped_count, MAX(observed_at) AS last_observed_at
      FROM observations ${where.sql}
      GROUP BY gap_reason
      ORDER BY gap_reason
    `).all(...where.params);

    const byReason = rows.map((row): CaptureHealthReasonRow => ({
      reason: requireGapReason(row.gap_reason),
      eventCount: numberValue(row.event_count),
      droppedObservationCount: numberValue(row.dropped_count),
      lastObservedAt: nullableString(row.last_observed_at),
    }));

    return {
      captureGapCount: byReason.reduce((sum, row) => sum + row.eventCount, 0),
      droppedObservationCount: byReason.reduce((sum, row) => sum + row.droppedObservationCount, 0),
      byReason,
      lastGapAt: nullableString(firstRow(this.#db, `SELECT MAX(observed_at) AS value FROM observations ${where.sql}`, where.params)?.value),
    };
  }

  async queryResources(filter: DashboardFilter): Promise<ResourceView> {
    assertOpen(this.#closed);
    return queryResources(this.#db, filter);
  }

  async queryResourceCoverage(filter: DashboardFilter): Promise<ResourceCoverageView> {
    assertOpen(this.#closed);
    return queryResourceCoverage(this.#db, filter);
  }

  async queryContentAnalytics(query: ContentQuery): Promise<ContentReport> {
    return this.#readContent(query, input => buildContentAnalytics(query, input));
  }

  async queryContentTimelines(request: ContentTimelineRequest): Promise<ContentTimelines> {
    return this.#readContent(request.query, input => buildContentTimelines(request, input));
  }

  #readContent<T>(query: ContentQuery, build: (input: ContentInput) => T): T {
    assertOpen(this.#closed);
    const db = this.#db;
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    const filter = query.filter;
    if (filter.machineId !== undefined) { clauses.push("o.machine_id = ?"); values.push(filter.machineId); }
    if (filter.projectCwd !== undefined) { clauses.push("o.project_cwd = ?"); values.push(filter.projectCwd); }
    if (filter.sessionId !== undefined) { clauses.push("o.session_id IS ?"); values.push(filter.sessionId); }
    if (filter.runId !== undefined) { clauses.push("o.run_id IS ?"); values.push(filter.runId); }
    const where = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
    if (!this.#readOnly) db.exec("BEGIN");
    try {
      const skills: ContentFact<ContentSkillEvidence>[] = query.content === "resources" ? [] : db.prepare(`SELECT o.* FROM observations o
        WHERE o.evidence_kind IN ('read-result', 'read-attempt', 'skill-invocation', 'command-intent', 'wrapper-observed')${where}`)
        .all(...values).map(contentSkillFact);
      const resourceFacts = filter.source === undefined ? [...readResourceAccessFacts(db, filter, { kind: "content", selection: query.selection, measure: query.measure })] : [];
      const resources = () => resourceFacts;
      const coverageStatement = db.prepare(`SELECT e.machine_id, e.source_id, e.payload FROM observations o JOIN resource_events e
        ON e.machine_id = o.machine_id AND e.source_id = o.source_id AND e.observation_id = o.id
        WHERE o.evidence_kind = 'tool-coverage'${where}`);
      const coverage = function* (): Iterable<ContentFact<ToolCoverageEvidence>> {
        if (filter.source !== undefined) return;
        for (const row of coverageStatement.iterate(...values)) {
          const observation = parseObservation(JSON.parse(requireString(row.payload, "tool coverage payload")));
          if (observation.evidence.kind !== "tool-coverage") throw new Error("Invalid stored tool coverage");
          yield { ...observation, evidence: observation.evidence, machineId: parseMachineId(row.machine_id), sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id) };
        }
      };
      const resourceProjects = filter.source === undefined && query.measure !== "toolActivity" ? readResourceProjectFacets(db, filter) : [];
      const result = build({ skills, resources, resourceProjects, coverage });
      if (!this.#readOnly) db.exec("COMMIT");
      return result;
    } catch (error) {
      if (!this.#readOnly) rollbackBestEffort(db);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#db.close();
  }

  #write(observations: readonly Observation[]): CaptureWriteSummary {
    let accepted = 0;
    let duplicate = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    if (this.#db.prepare("SELECT kind FROM database_state WHERE singleton = 1").get()?.kind !== "local") {
      throw new Error("Database mode changed. Local capture requires a separate database.");
    }
    for (const observation of observations) {
      if (observation.id.startsWith("native:")) {
        const canonical = observation.id.startsWith("native:tool:") && observation.evidence.kind === "resource-access"
          ? { ...observation, evidence: { ...observation.evidence, resource: { ...observation.evidence.resource, observedPath: observation.evidence.resource.canonicalPath } } }
          : observation;
        const receiptValue = canonical.host === "pi" && canonical.id.startsWith("native:tool:") ? piToolReceipt(canonical) : canonical;
        const digest = createHash("sha256").update(serializeObservation({ ...receiptValue, observedAt: "" })).digest("hex");
        const receipt = this.#db.prepare("SELECT digest FROM native_receipts WHERE id = ?").get(observation.id);
        if (receipt) {
          if (receipt.digest !== digest) throw new Error("Conflicting native occurrence");
          duplicate += 1;
          continue;
        }
        this.#db.prepare("INSERT INTO native_receipts (id, digest) VALUES (?, ?)").run(observation.id, digest);
      }
      if (!insertObservation(this.#db, LOCAL_IDENTITY, observation, null)) {
        duplicate += 1;
        continue;
      }
      accepted += 1;
      if (this.#enrollment) {
        const payload = serializeObservation(observation);
        this.#db.prepare(`INSERT INTO delivery_outbox (source_id, observation_id, payload, payload_bytes, captured_at, protocol_version)
          VALUES (?, ?, ?, ?, ?, ?)`).run(this.#enrollment.sourceId, observation.id, payload, Buffer.byteLength(payload), new Date().toISOString(), observationProtocolVersion(observation));
      }
    }
    this.#db.exec("COMMIT");
    secureDatabaseFiles(this.#databasePath);
    return { accepted, duplicate, dropped: 0 };
  }
}

function piToolReceipt(observation: Observation): Observation {
  let evidence: Observation["evidence"];
  switch (observation.evidence.kind) {
    case "resource-access":
      if (observation.evidence.mechanism !== "host-tool") return observation;
      evidence = { ...observation.evidence, model: null, process: null };
      break;
    case "read-result":
    case "read-attempt":
    case "tool-coverage":
      evidence = { ...observation.evidence, model: null };
      break;
    default: return observation;
  }
  return { ...observation, evidence, scope: {
    ...observation.scope, sessionFile: null, segmentId: observation.scope.sessionId ?? observation.scope.segmentId,
    segmentReason: "unknown", runId: null, turnId: null, leafId: null,
  } };
}

function insertObservation(db: DatabaseSync, source: SourceIdentity | typeof LOCAL_IDENTITY, observation: Observation, digest: string | null): boolean {
  const result = db.prepare(`INSERT INTO observations (
    host, machine_id, source_id, digest, id, producer_id, sequence, observed_at, project_cwd, session_id, session_file,
    segment_id, segment_reason, run_id, turn_id, leaf_id, evidence_kind, skill_name, skill_path, skill_version,
    source, wrapper_source, tool_call_id, outcome, model_provider, model_id, dropped, gap_reason
  ) VALUES (${Array(28).fill("?").join(",")}) ON CONFLICT(machine_id, source_id, id) DO NOTHING`)
    .run(observation.host ?? "unknown", source.machineId, source.sourceId, digest, ...flattenObservation(observation).values);
  if (numberValue(result.changes) === 0) return false;
  recordResourceObservation(db, source, observation);
  if (observation.evidence.kind === "catalog-snapshot") {
    const upsert = db.prepare(`INSERT INTO catalog_skills (
      host, machine_id, source_id, project_cwd, skill_name, skill_path, skill_version, first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(host, machine_id, source_id, project_cwd, skill_name, skill_path) DO UPDATE SET
      skill_version = CASE WHEN excluded.last_observed_at > catalog_skills.last_observed_at
        OR (excluded.last_observed_at = catalog_skills.last_observed_at
          AND json_array(excluded.skill_version) > json_array(catalog_skills.skill_version))
        THEN excluded.skill_version ELSE catalog_skills.skill_version END,
      first_observed_at = MIN(catalog_skills.first_observed_at, excluded.first_observed_at),
      last_observed_at = MAX(catalog_skills.last_observed_at, excluded.last_observed_at)`);
    for (const skill of observation.evidence.skills) {
      upsert.run(observation.host ?? "unknown", source.machineId, source.sourceId, observation.scope.projectCwd, skill.name, skill.canonicalPath,
        skill.version, observation.observedAt, observation.observedAt);
    }
  }
  return true;
}

function configureWriter(db: DatabaseSync, kind: "local" | "aggregate", retries: number, enrollment?: CaptureEnrollment): void {
  execWithBusyRetry(db, "BEGIN IMMEDIATE", retries);
  try {
    const state = db.prepare("SELECT * FROM database_state WHERE singleton = 1").get();
    if (!state) throw new Error("Missing database identity");
    if (state.kind !== kind) {
      const populated = count(db, "SELECT COUNT(*) AS value FROM observations", []) > 0
        || count(db, "SELECT COUNT(*) AS value FROM catalog_skills", []) > 0;
      if (kind !== "aggregate" || populated || state.source_id !== null) {
        throw new Error("Database mode mismatch. Use a separate database for aggregate storage.");
      }
      db.prepare("UPDATE database_state SET kind = 'aggregate' WHERE singleton = 1").run();
    }
    if (enrollment) {
      if (state.source_id === null) {
        db.prepare("UPDATE database_state SET source_id = ?, collector_origin = ? WHERE singleton = 1")
          .run(enrollment.sourceId, enrollment.collectorOrigin);
      } else {
        assertEnrollment(state, enrollment);
      }
    }
    db.exec("COMMIT");
  } catch (error) { rollbackBestEffort(db); throw error; }
}

function assertEnrollment(state: Record<string, unknown>, enrollment: CaptureEnrollment): void {
  if (state.kind !== "local" || state.source_id !== enrollment.sourceId || state.collector_origin !== enrollment.collectorOrigin) {
    throw new Error("Capture enrollment does not match this database. Use a separate database for another source or collector origin.");
  }
}

export type DeliveryCandidate =
  | { kind: "ready"; observation: Observation; payloadBytes: number }
  | { kind: "oversized"; observationId: Observation["id"]; payloadBytes: number };
export type DeliveryBlockReason = "oversized" | "invalid" | "conflict";
export type DeliverySettlement =
  | { kind: "committed"; observationIds: readonly Observation["id"][] }
  | { kind: "blocked"; observationIds: readonly Observation["id"][]; reason: DeliveryBlockReason };
export type DeliveryStatus = { pendingCount: number; pendingBytes: number; oldestPendingAt: string | null; blockedCount: number; heldCount: number };
export interface RelayStore {
  selectPending(args: { maxCount: number; maxPayloadBytes: number; maxVersion: ProtocolVersion }): Promise<readonly DeliveryCandidate[]>;
  recordReceiverVersion(version: ProtocolVersion): Promise<void>;
  settle(args: { settlement: DeliverySettlement; signal?: AbortSignal }): Promise<void>;
  queryStatus(): Promise<DeliveryStatus>;
  close(): Promise<void>;
}
export type RelayStoreOpenResult = { kind: "missing" } | { kind: "not-enrolled" } | { kind: "ready"; store: RelayStore };

export function openRelayStore(args: { databasePath: string; enrollment: CaptureEnrollment }): RelayStoreOpenResult {
  const enrollment = validateEnrollment(args.enrollment);
  if (!existsSync(args.databasePath)) return { kind: "missing" };
  const db = new DatabaseSync(args.databasePath, { timeout: DEFAULT_BUSY_TIMEOUT_MS, allowExtension: false });
  try {
    if (userVersion(db) === 1) { db.close(); return { kind: "not-enrolled" }; }
    assertReadableSchema(db);
    const state = db.prepare("SELECT * FROM database_state WHERE singleton = 1").get();
    if (!state || state.kind !== "local") throw new Error("Relay requires a local capture database");
    if (state.source_id === null) { db.close(); return { kind: "not-enrolled" }; }
    assertEnrollment(state, enrollment);
    return { kind: "ready", store: new SqliteRelayStore(db, enrollment.sourceId) };
  } catch (error) { db.close(); throw error; }
}

class SqliteRelayStore implements RelayStore {
  #closed = false;
  constructor(readonly db: DatabaseSync, readonly sourceId: SourceId) {}

  async selectPending(args: { maxCount: number; maxPayloadBytes: number; maxVersion: ProtocolVersion }): Promise<readonly DeliveryCandidate[]> {
    assertOpen(this.#closed);
    if (!Number.isSafeInteger(args.maxCount) || args.maxCount <= 0 || !Number.isSafeInteger(args.maxPayloadBytes) || args.maxPayloadBytes <= 0) {
      throw new Error("Delivery selection limits must be positive safe integers");
    }
    const result: DeliveryCandidate[] = [];
    let bytes = 0;
    const rows = this.db.prepare(`SELECT observation_id, payload_bytes FROM delivery_outbox
      WHERE source_id = ? AND blocked_reason IS NULL AND protocol_version <= ? ORDER BY captured_at, observation_id LIMIT ?`).all(this.sourceId, args.maxVersion, args.maxCount);
    for (const row of rows) {
      const observationId = requireString(row.observation_id, "observation_id");
      const payloadBytes = numberValue(row.payload_bytes);
      if (payloadBytes > args.maxPayloadBytes) {
        result.push({ kind: "oversized", observationId, payloadBytes });
        continue;
      }
      if (bytes + payloadBytes > args.maxPayloadBytes) break;
      const payload = this.db.prepare(`SELECT payload FROM delivery_outbox WHERE source_id = ? AND observation_id = ? AND blocked_reason IS NULL`)
        .get(this.sourceId, observationId);
      if (!payload) continue;
      result.push({ kind: "ready", observation: parseObservation(JSON.parse(requireString(payload.payload, "payload"))), payloadBytes });
      bytes += payloadBytes;
    }
    return result;
  }

  async settle(args: { settlement: DeliverySettlement; signal?: AbortSignal }): Promise<void> {
    await retryTransaction(this.db, () => {
      assertOpen(this.#closed);
      const settlement = args.settlement;
      const statement = settlement.kind === "committed"
        ? this.db.prepare("DELETE FROM delivery_outbox WHERE source_id = ? AND observation_id = ?")
        : this.db.prepare("UPDATE delivery_outbox SET blocked_reason = ? WHERE source_id = ? AND observation_id = ? AND blocked_reason IS NULL");
      for (const id of settlement.observationIds) {
        if (settlement.kind === "committed") statement.run(this.sourceId, id);
        else statement.run(settlement.reason, this.sourceId, id);
      }
    }, args.signal);
  }

  async recordReceiverVersion(version: ProtocolVersion): Promise<void> {
    await retryTransaction(this.db, () => {
      assertOpen(this.#closed);
      this.db.prepare("UPDATE database_state SET receiver_protocol_version = ? WHERE singleton = 1").run(version);
    });
  }

  async queryStatus(): Promise<DeliveryStatus> {
    assertOpen(this.#closed);
    const row = this.db.prepare(`SELECT COUNT(*) AS pending, COALESCE(SUM(payload_bytes), 0) AS bytes,
      MIN(captured_at) AS oldest, COUNT(blocked_reason) AS blocked,
      COUNT(*) FILTER (WHERE blocked_reason IS NULL AND protocol_version > (SELECT COALESCE(receiver_protocol_version, ?) FROM database_state WHERE singleton = 1)) AS held
      FROM delivery_outbox WHERE source_id = ?`).get(BASELINE_PROTOCOL_VERSION, this.sourceId);
    return { pendingCount: numberValue(row?.pending), pendingBytes: numberValue(row?.bytes), oldestPendingAt: nullableString(row?.oldest),
      blockedCount: numberValue(row?.blocked), heldCount: numberValue(row?.held) };
  }

  async close(): Promise<void> { if (!this.#closed) { this.#closed = true; this.db.close(); } }
}

export type IngestResult =
  | { kind: "committed"; accepted: number; duplicate: number }
  | { kind: "conflict"; observationIds: readonly Observation["id"][] }
  | { kind: "unavailable"; reason: "busy" | "cancelled" | "storage-error" };
export type StaticRegistration = { source: SourceIdentity; tokenDigest: TokenDigest };
export type RegistrationResult = { kind: "registered"; source: SourceIdentity } | { kind: "refused" | "limited" };
export interface AggregateStore {
  register(args: { sourceId: SourceId; tokenDigest: TokenDigest; openEnrollment: boolean; signal?: AbortSignal }): Promise<RegistrationResult>;
  authenticate(tokenDigest: TokenDigest): SourceIdentity | undefined;
  ingest(args: { source: SourceIdentity; observations: readonly Observation[]; signal?: AbortSignal }): Promise<IngestResult>;
  close(): Promise<void>;
}

export function openAggregateStore(args: { databasePath: string; staticRegistrations?: readonly StaticRegistration[] }): AggregateStore {
  if (args.databasePath !== ":memory:") createPrivateDirectory(dirname(args.databasePath));
  const db = new DatabaseSync(args.databasePath, { timeout: DEFAULT_BUSY_TIMEOUT_MS, allowExtension: false });
  try {
    execWithBusyRetry(db, "PRAGMA journal_mode = WAL", DEFAULT_BUSY_RETRIES);
    execWithBusyRetry(db, "PRAGMA synchronous = FULL", DEFAULT_BUSY_RETRIES);
    migrate(db, DEFAULT_BUSY_RETRIES);
    configureWriter(db, "aggregate", DEFAULT_BUSY_RETRIES);
    secureDatabaseFiles(args.databasePath);
    return new SqliteAggregateStore(db, args.staticRegistrations ?? []);
  } catch (error) { db.close(); throw error; }
}

class IngestConflict extends Error {
  constructor(readonly observationIds: readonly string[]) { super("Conflicting observation identity"); }
}

class SqliteAggregateStore implements AggregateStore {
  #closed = false;
  #registrations: number[] = [];
  readonly #statisticsTimer: NodeJS.Timeout;
  constructor(readonly db: DatabaseSync, readonly staticRegistrations: readonly StaticRegistration[]) {
    for (const entry of staticRegistrations) {
      validateNetworkIdentity(entry.source);
      if (db.prepare("SELECT 1 FROM registered_sources WHERE source_id = ? OR token_digest = ?")
        .get(entry.source.sourceId, entry.tokenDigest)) throw new Error("Static and managed identities conflict");
      if (db.prepare("SELECT 1 FROM observations WHERE source_id = ? AND machine_id != ? UNION SELECT 1 FROM catalog_skills WHERE source_id = ? AND machine_id != ?")
        .get(entry.source.sourceId, entry.source.machineId, entry.source.sourceId, entry.source.machineId)) throw new Error("Static and historical identities conflict");
    }
    this.#maintainStatistics();
    this.#statisticsTimer = setInterval(() => this.#maintainStatistics(), STATISTICS_INTERVAL_MS).unref();
  }

  authenticate(tokenDigest: TokenDigest): SourceIdentity | undefined {
    assertOpen(this.#closed);
    const fixed = this.staticRegistrations.find(entry => entry.tokenDigest === tokenDigest);
    if (fixed) return fixed.source;
    const row = this.db.prepare("SELECT source_id, machine_id FROM registered_sources WHERE token_digest = ?").get(tokenDigest);
    return row ? validateNetworkIdentity({ sourceId: parseSourceId(row.source_id), machineId: parseMachineId(row.machine_id) }) : undefined;
  }

  async register(args: { sourceId: SourceId; tokenDigest: TokenDigest; openEnrollment: boolean; signal?: AbortSignal }): Promise<RegistrationResult> {
    const source = validateNetworkIdentity({ sourceId: parseSourceId(args.sourceId), machineId: parseMachineId(`managed-${args.sourceId}`) });
    if (!/^[a-f0-9]{64}$/.test(args.tokenDigest)) throw new Error("Invalid token digest");
    return retryTransaction(this.db, () => {
      assertOpen(this.#closed);
      const existing = this.db.prepare("SELECT * FROM registered_sources WHERE source_id = ? OR token_digest = ?").all(source.sourceId, args.tokenDigest);
      if (existing.length > 0) {
        const row = existing[0];
        return existing.length === 1 && row?.source_id === source.sourceId && row.token_digest === args.tokenDigest && row.machine_id === source.machineId
          ? { kind: "registered", source } : { kind: "refused" };
      }
      if (!args.openEnrollment || this.staticRegistrations.some(entry => entry.source.sourceId === source.sourceId || entry.tokenDigest === args.tokenDigest)
        || this.db.prepare("SELECT 1 FROM observations WHERE source_id = ? UNION SELECT 1 FROM catalog_skills WHERE source_id = ?").get(source.sourceId, source.sourceId)) return { kind: "refused" };
      const now = Date.now();
      this.#registrations = this.#registrations.filter(time => now - time < 60_000);
      if (this.#registrations.length >= ENROLLMENTS_PER_MINUTE || count(this.db, "SELECT COUNT(*) AS value FROM registered_sources", []) >= MAX_DYNAMIC_SOURCES) return { kind: "limited" };
      this.db.prepare("INSERT INTO registered_sources (source_id, machine_id, token_digest) VALUES (?, ?, ?)").run(source.sourceId, source.machineId, args.tokenDigest);
      this.#registrations.push(now);
      return { kind: "registered", source };
    }, args.signal);
  }

  async ingest(args: { source: SourceIdentity; observations: readonly Observation[]; signal?: AbortSignal }): Promise<IngestResult> {
    const source = validateNetworkIdentity(args.source);
    const observations = args.observations.map(parseObservation);
    try {
      return await retryTransaction(this.db, () => {
        assertOpen(this.#closed);
        let accepted = 0;
        let duplicate = 0;
        const conflicts: string[] = [];
        const existingId = this.db.prepare(`SELECT id, digest FROM observations
          WHERE machine_id = ? AND source_id = ? AND id = ?`);
        const existingSequence = this.db.prepare(`SELECT id, digest FROM observations
          WHERE machine_id = ? AND source_id = ? AND producer_id = ? AND sequence = ? LIMIT 2`);
        for (const observation of observations) {
          const digest = createHash("sha256").update(JSON.stringify([source.machineId, source.sourceId, serializeObservation(observation)])).digest("hex");
          const byId = existingId.get(source.machineId, source.sourceId, observation.id);
          const matches = existingSequence.all(source.machineId, source.sourceId, observation.producerId, observation.sequence);
          if (byId && !matches.some(match => match.id === byId.id)) matches.push(byId);
          if (matches.length > 0) {
            if (matches.length === 1 && matches[0]?.id === observation.id && matches[0]?.digest === digest) duplicate += 1;
            else conflicts.push(observation.id);
          } else {
            insertObservation(this.db, source, observation, digest);
            accepted += 1;
          }
        }
        if (conflicts.length > 0) throw new IngestConflict([...new Set(conflicts)]);
        return { kind: "committed", accepted, duplicate };
      }, args.signal);
    } catch (error) {
      if (error instanceof IngestConflict) return { kind: "conflict", observationIds: error.observationIds };
      return { kind: "unavailable", reason: args.signal?.aborted ? "cancelled" : isBusyError(error) ? "busy" : "storage-error" };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#statisticsTimer);
    this.db.close();
  }

  #maintainStatistics(): void {
    try { this.db.exec("PRAGMA optimize = 0x10012"); }
    catch (error) {
      if (!isBusyError(error)) process.emitWarning("Hotplate planner statistics maintenance failed", { code: "HOTPLATE_STATISTICS_MAINTENANCE" });
    }
  }
}

async function retryTransaction<T>(db: DatabaseSync, operation: () => T, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = operation();
      signal?.throwIfAborted();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackBestEffort(db);
      if (!isBusyError(error) || attempt >= DEFAULT_BUSY_RETRIES) throw error;
      await delay(Math.min(5 * (attempt + 1), 25), undefined, { signal });
    }
  }
}

type FlattenedObservation = {
  values: readonly SqlValue[];
};

function flattenObservation(observation: Observation): FlattenedObservation {
  const base: SqlValue[] = [
    observation.id,
    observation.producerId,
    observation.sequence,
    observation.observedAt,
    observation.scope.projectCwd,
    observation.scope.sessionId,
    observation.scope.sessionFile,
    observation.scope.segmentId,
    observation.scope.segmentReason,
    observation.scope.runId,
    observation.scope.turnId,
    observation.scope.leafId,
    observation.evidence.kind,
  ];

  switch (observation.evidence.kind) {
    case "command-intent":
      return { values: [...base, observation.evidence.skillName, null, null, observation.evidence.source, null, null, null, null, null, null, null] };
    case "wrapper-observed":
      return {
        values: [
          ...base,
          observation.evidence.skill.name,
          observation.evidence.skill.canonicalPath,
          observation.evidence.skill.version,
          null,
          observation.evidence.wrapperSource,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      };
    case "read-attempt":
    case "skill-invocation":
    case "read-result":
      return {
        values: [
          ...base,
          observation.evidence.skill.name,
          observation.evidence.skill.canonicalPath,
          observation.evidence.skill.version,
          null,
          null,
          observation.evidence.toolCallId,
          observation.evidence.kind === "read-attempt" ? null : observation.evidence.outcome,
          observation.evidence.model?.provider ?? null,
          observation.evidence.model?.id ?? null,
          null,
          null,
        ],
      };
    case "catalog-snapshot":
    case "inventory-snapshot":
    case "observer-coverage":
      return { values: [...base, null, null, null, null, null, null, null, null, null, null, null] };
    case "tool-coverage":
    case "resource-access":
      return { values: [...base, null, null, null, null, null, observation.evidence.operationId,
        observation.evidence.outcome === "unknown" ? null : observation.evidence.outcome,
        observation.evidence.model?.provider ?? null, observation.evidence.model?.id ?? null, null, null] };
    case "capture-gap":
      return { values: [...base, null, null, null, null, null, null, null, null, null, observation.evidence.dropped, observation.evidence.reason] };
    default: {
      const _exhaustive: never = observation.evidence;
      return _exhaustive;
    }
  }
}

function migrate(db: DatabaseSync, busyRetries: number): void {
  if (userVersion(db) === SCHEMA_VERSION) return;
  execWithBusyRetry(db, "BEGIN IMMEDIATE", busyRetries);
  try {
    // Recheck under the writer lock: another process can finish the migration first.
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported Hotplate schema version ${version}`);
    if (version === SCHEMA_VERSION) { db.exec("COMMIT"); return; }
    if (version < 2) {
      if (version === 1) {
        db.exec("ALTER TABLE observations RENAME TO observations_v1; ALTER TABLE catalog_skills RENAME TO catalog_skills_v1");
      }
      db.exec(`
    CREATE TABLE observations (
      machine_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      digest TEXT,
      id TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      observed_at TEXT NOT NULL,
      project_cwd TEXT NOT NULL,
      session_id TEXT,
      session_file TEXT,
      segment_id TEXT NOT NULL,
      segment_reason TEXT NOT NULL CHECK(segment_reason IN ('startup', 'reload', 'new', 'resume', 'fork', 'branch', 'unknown')),
      run_id TEXT,
      turn_id TEXT,
      leaf_id TEXT,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('command-intent', 'wrapper-observed', 'read-result', 'catalog-snapshot', 'capture-gap')),
      skill_name TEXT,
      skill_path TEXT,
      skill_version TEXT,
      source TEXT CHECK(source IS NULL OR source IN ('interactive', 'rpc', 'extension')),
      wrapper_source TEXT CHECK(wrapper_source IS NULL OR wrapper_source IN ('expanded-prompt', 'unknown-pasted-or-transformed')),
      tool_call_id TEXT,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('success', 'error')),
      model_provider TEXT,
      model_id TEXT,
      dropped INTEGER CHECK(dropped IS NULL OR dropped >= 0),
      gap_reason TEXT CHECK(gap_reason IS NULL OR gap_reason IN ('queue-overflow', 'db-busy', 'db-error', 'shutdown-deadline', 'invalid-observation')),
      PRIMARY KEY (machine_id, source_id, id)
    ) STRICT;

    CREATE TABLE catalog_skills (
      machine_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_cwd TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_path TEXT NOT NULL,
      skill_version TEXT,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      PRIMARY KEY (machine_id, source_id, project_cwd, skill_name, skill_path)
    ) STRICT;

    CREATE TABLE database_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      kind TEXT NOT NULL CHECK(kind IN ('local', 'aggregate')),
      source_id TEXT,
      collector_origin TEXT,
      CHECK((source_id IS NULL) = (collector_origin IS NULL))
    ) STRICT;
    INSERT INTO database_state VALUES (1, 'local', NULL, NULL);
    CREATE TABLE delivery_outbox (
      source_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
      captured_at TEXT NOT NULL,
      blocked_reason TEXT CHECK(blocked_reason IN ('oversized', 'invalid', 'conflict')),
      PRIMARY KEY (source_id, observation_id)
    ) STRICT;
    CREATE INDEX delivery_pending_idx ON delivery_outbox(source_id, blocked_reason, captured_at);
    CREATE UNIQUE INDEX aggregate_sequence_idx ON observations(machine_id, source_id, producer_id, sequence) WHERE digest IS NOT NULL;
    `);
      if (version === 1) {
        db.exec(`INSERT INTO observations SELECT 'local', 'local', NULL, * FROM observations_v1;
        INSERT INTO catalog_skills SELECT 'local', 'local', * FROM catalog_skills_v1;
        DROP TABLE observations_v1; DROP TABLE catalog_skills_v1;`);
      }
      db.exec(`
    CREATE INDEX IF NOT EXISTS observations_time_idx ON observations(observed_at);
    CREATE INDEX IF NOT EXISTS observations_scope_idx ON observations(machine_id, source_id, project_cwd, session_id, segment_id, run_id, observed_at);
    CREATE INDEX IF NOT EXISTS observations_skill_idx ON observations(machine_id, source_id, skill_name, skill_path, evidence_kind);
    CREATE INDEX IF NOT EXISTS observations_model_idx ON observations(machine_id, model_provider, model_id, evidence_kind);
    CREATE INDEX IF NOT EXISTS observations_source_idx ON observations(source, evidence_kind);
    `);
    }
    if (version < 3) db.exec(`CREATE TABLE registered_sources (
      source_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    `);
    if (version < 4) {
      const schema = requireString(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get()?.sql, "observation schema");
      db.exec("ALTER TABLE observations RENAME TO observations_previous");
      db.exec(schema.replace("'read-result',", "'read-result', 'read-attempt', 'skill-invocation',"));
      db.exec("ALTER TABLE observations ADD COLUMN host TEXT NOT NULL DEFAULT 'unknown'; INSERT INTO observations SELECT *, 'unknown' FROM observations_previous; DROP TABLE observations_previous");
      db.exec("CREATE UNIQUE INDEX aggregate_sequence_idx ON observations(machine_id, source_id, producer_id, sequence) WHERE digest IS NOT NULL");
      db.exec(`CREATE INDEX observations_time_idx ON observations(observed_at);
        CREATE INDEX observations_scope_idx ON observations(host, machine_id, source_id, project_cwd, session_id, segment_id, run_id, observed_at);
        CREATE INDEX observations_skill_idx ON observations(host, machine_id, source_id, skill_name, skill_path, evidence_kind);
        CREATE INDEX observations_model_idx ON observations(host, machine_id, model_provider, model_id, evidence_kind);
        CREATE INDEX observations_source_idx ON observations(source, evidence_kind);`);
      db.exec("ALTER TABLE catalog_skills RENAME TO catalog_previous");
      db.exec(`CREATE TABLE catalog_skills (host TEXT NOT NULL, machine_id TEXT NOT NULL, source_id TEXT NOT NULL, project_cwd TEXT NOT NULL, skill_name TEXT NOT NULL, skill_path TEXT NOT NULL, skill_version TEXT, first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, PRIMARY KEY(host, machine_id, source_id, project_cwd, skill_name, skill_path)) STRICT; INSERT INTO catalog_skills SELECT 'unknown', * FROM catalog_previous; DROP TABLE catalog_previous; CREATE TABLE native_receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;`);
    }
    if (version < 5) {
      const resourceSchema = requireString(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get()?.sql, "observation schema");
      db.exec("ALTER TABLE observations RENAME TO observations_previous");
      db.exec(resourceSchema.replace("'read-result',", "'read-result', 'resource-access', 'inventory-snapshot', 'observer-coverage',"));
      db.exec(`INSERT INTO observations SELECT * FROM observations_previous; DROP TABLE observations_previous;
        CREATE UNIQUE INDEX aggregate_sequence_idx ON observations(machine_id, source_id, producer_id, sequence) WHERE digest IS NOT NULL;
        CREATE INDEX observations_time_idx ON observations(observed_at);
        CREATE INDEX observations_scope_idx ON observations(host, machine_id, source_id, project_cwd, session_id, segment_id, run_id, observed_at);
        CREATE INDEX observations_skill_idx ON observations(host, machine_id, source_id, skill_name, skill_path, evidence_kind);
        CREATE INDEX observations_model_idx ON observations(host, machine_id, model_provider, model_id, evidence_kind);
        CREATE INDEX observations_source_idx ON observations(source, evidence_kind);`);
      createResourceSchema(db);
    }
    if (version < 7) {
      const schema = requireString(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get()?.sql, "observation schema");
      const resourceSchema = requireString(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_events'").get()?.sql, "resource event schema");
      const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations' AND sql IS NOT NULL").all()
        .map(row => requireString(row.sql, "observation index"));
      db.exec("ALTER TABLE resource_events RENAME TO resource_events_previous; ALTER TABLE observations RENAME TO observations_previous");
      db.exec(schema.replace("'observer-coverage'", "'observer-coverage', 'tool-coverage'"));
      db.exec("INSERT INTO observations SELECT * FROM observations_previous");
      db.exec(resourceSchema);
      db.exec(`INSERT INTO resource_events SELECT * FROM resource_events_previous;
        DROP TABLE resource_events_previous; DROP TABLE observations_previous;`);
      for (const index of indexes) db.exec(index);
    }
    if (version < 9) {
      const columns = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (!columns("delivery_outbox").has("protocol_version")) db.exec("ALTER TABLE delivery_outbox ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK(protocol_version BETWEEN 1 AND 5)");
      if (!columns("database_state").has("receiver_protocol_version")) {
        db.exec("ALTER TABLE database_state ADD COLUMN receiver_protocol_version INTEGER CHECK(receiver_protocol_version IS NULL OR receiver_protocol_version BETWEEN 1 AND 5)");
      }
      const update = db.prepare("UPDATE delivery_outbox SET protocol_version = ? WHERE source_id = ? AND observation_id = ?");
      for (const row of db.prepare("SELECT source_id, observation_id, payload FROM delivery_outbox").all()) {
        update.run(observationProtocolVersion(parseObservation(JSON.parse(requireString(row.payload, "payload")))), requireString(row.source_id, "source_id"), requireString(row.observation_id, "observation_id"));
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS observations_sequence_lookup_idx ON observations(machine_id, source_id, producer_id, sequence);
      CREATE INDEX IF NOT EXISTS observations_evidence_time_idx ON observations(evidence_kind, observed_at);`);
    const analyticsTables = ["resource_access_facts", "filesystem_access_buckets", "observer_coverage_facts", "inventory_scan_facts", "inventory_location_variants", "inventory_location_buckets"];
    if (version < 9 || analyticsTables.some(name => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))) createAnalyticsReadModel(db);
    createSharedInventory(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    rollbackBestEffort(db);
    throw error;
  }
}

function assertReadableSchema(db: DatabaseSync): void {
  const version = userVersion(db);
  if (version >= 1 && version < SCHEMA_VERSION) {
    throw new Error("Hotplate database requires an upgrade. Open it with the current capture command or openHotplateStore before reading it.");
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Hotplate schema version ${version}`);
  }
}

function userVersion(db: DatabaseSync): number {
  return numberValue(db.prepare("PRAGMA user_version").get()?.user_version);
}

function observationWhere(filter: DashboardFilter, suffixes: readonly string[] = []): { sql: string; params: SqlValue[] } {
  const clauses: string[] = ["1 = 1"];
  const params: SqlValue[] = [];

  addSharedObservationFilters(clauses, params, filter);
  if (filter.source !== undefined) {
    clauses.push("source = ?");
    params.push(filter.source);
  }
  if (filter.modelSelection !== undefined) {
    clauses.push("evidence_kind IN ('read-result', 'read-attempt', 'skill-invocation')");
    if (filter.modelSelection.kind === "unknown") clauses.push("model_provider IS NULL AND model_id IS NULL");
    else {
      clauses.push("model_provider = ? AND model_id = ?");
      params.push(filter.modelSelection.model.provider, filter.modelSelection.model.id);
    }
  }
  if (filter.modelSelection === undefined && filter.modelProvider !== undefined) {
    if (filter.modelProvider === null) clauses.push("model_provider IS NULL");
    else {
      clauses.push("model_provider = ?");
      params.push(filter.modelProvider);
    }
  }
  if (filter.modelSelection === undefined && filter.modelId !== undefined) {
    if (filter.modelId === null) clauses.push("model_id IS NULL");
    else {
      clauses.push("model_id = ?");
      params.push(filter.modelId);
    }
  }

  return { sql: `WHERE ${clauses.join(" AND ")} ${suffixes.join(" ")}`, params };
}

function chainBaseWhere(filter: ChainFilter): { sql: string; params: SqlValue[] } {
  const clauses: string[] = ["1 = 1"];
  const params: SqlValue[] = [];
  addSharedObservationFilters(clauses, params, filter);
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function addSharedObservationFilters(clauses: string[], params: SqlValue[], filter: DashboardFilter): void {
  if (filter.host !== undefined) { clauses.push("host = ?"); params.push(filter.host); }
  if (filter.machineId !== undefined) {
    clauses.push("machine_id = ?");
    params.push(filter.machineId);
  }
  if (filter.projectCwd !== undefined) {
    clauses.push("project_cwd = ?");
    params.push(filter.projectCwd);
  }
  if (filter.sessionId !== undefined) {
    if (filter.sessionId === null) clauses.push("session_id IS NULL");
    else {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
  }
  if (filter.runId !== undefined) {
    if (filter.runId === null) clauses.push("run_id IS NULL");
    else {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
  }
  if (filter.fromObservedAt !== undefined) {
    clauses.push("observed_at >= ?");
    params.push(filter.fromObservedAt);
  }
  if (filter.toObservedAt !== undefined) {
    clauses.push("observed_at <= ?");
    params.push(filter.toObservedAt);
  }
}

function catalogWhereClause(filter: DashboardFilter): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (filter.host !== undefined) { clauses.push("host = ?"); params.push(filter.host); }
  if (filter.machineId !== undefined) {
    clauses.push("machine_id = ?");
    params.push(filter.machineId);
  }
  if (filter.projectCwd !== undefined) {
    clauses.push("project_cwd = ?");
    params.push(filter.projectCwd);
  }
  if (filter.fromObservedAt !== undefined) {
    clauses.push("last_observed_at >= ?");
    params.push(filter.fromObservedAt);
  }
  if (filter.toObservedAt !== undefined) {
    clauses.push("first_observed_at <= ?");
    params.push(filter.toObservedAt);
  }
  return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

type MutableSkillTableRow = SkillTableRow & { host: HostId; skillInvocationCount: number; readAttemptCount: number };

function getSkillRow(rows: Map<string, MutableSkillTableRow>, host: HostId, machineId: MachineId, skillName: string, canonicalPath: string | null, version: string | null): MutableSkillTableRow {
  const key = skillKey(host, machineId, skillName, canonicalPath);
  const existing = rows.get(key);
  if (existing) {
    if (!existing.cataloged && existing.version === null && version !== null) existing.version = version;
    return existing;
  }

  const row: MutableSkillTableRow = {
    host,
    machineId,
    skillName,
    canonicalPath,
    version,
    cataloged: false,
    skillInvocationCount: 0,
    readAttemptCount: 0,
    commandIntentCount: 0,
    interactiveCommandIntentCount: 0,
    rpcCommandIntentCount: 0,
    extensionCommandIntentCount: 0,
    wrapperObservedCount: 0,
    successfulReadCount: 0,
    failedReadCount: 0,
    readResultCount: 0,
    uniqueObservedRunActivations: 0,
    lastObservedAt: null,
  };
  rows.set(key, row);
  return row;
}

function toSkillTableRow(row: MutableSkillTableRow): SkillTableRow {
  return { ...row };
}

function addActivation(activations: Set<string>, row: MutableSkillTableRow, source: Record<string, unknown>): void {
  if (source.run_id === null && source.host !== "unknown" && source.host !== "pi") return;
  activations.add(JSON.stringify([
    skillKey(row.host, row.machineId, row.skillName, row.canonicalPath),
    source.machine_id, source.source_id, source.project_cwd,
    source.session_id, source.segment_id, source.run_id,
  ]));
}

function skillKey(host: HostId, machineId: MachineId, skillName: string, canonicalPath: string | null): string {
  return JSON.stringify([host, machineId, skillName, canonicalPath]);
}

type MutableChainRun = {
  host: HostId;
  machineId: MachineId;
  sourceId: SkillChainRun["sourceId"];
  sessionId: string | null;
  segmentId: string;
  runId: string | null;
  projectCwd: string;
  steps: SkillChainStep[];
  filteredGap: number;
};

function getChainRun(runs: Map<string, MutableChainRun>, row: Record<string, unknown>): MutableChainRun {
  const projectCwd = requireString(row.project_cwd, "project_cwd");
  const sessionId = nullableString(row.session_id);
  const segmentId = requireString(row.segment_id, "segment_id");
  const runId = nullableString(row.run_id);
  const machineId = parseMachineId(row.machine_id);
  const sourceId = row.source_id === LOCAL_SOURCE_ID ? LOCAL_SOURCE_ID : parseSourceId(row.source_id);
  const host = parseHostId(row.host);
  const key = JSON.stringify([host, machineId, sourceId, projectCwd, sessionId, segmentId, runId, runId === null && host !== "unknown" && host !== "pi" ? row.id : null]);
  const existing = runs.get(key);
  if (existing) {
    return existing;
  }
  const created: MutableChainRun = { host, machineId, sourceId, projectCwd, sessionId, segmentId, runId, steps: [], filteredGap: 0 };
  runs.set(key, created);
  return created;
}

function addChainObservation(run: MutableChainRun, observation: ChainObservation, turnId: string | null, leafId: string | null): void {
  const last = run.steps.at(-1);
  const sameReadTurn = turnId !== null && last?.kind === "observations" && last.turnId === turnId
    && observation.evidence.kind === "read-result" && last.items.every(item => item.evidence.kind === "read-result");
  if (last?.kind === "observations" && sameReadTurn) {
    run.steps[run.steps.length - 1] = { ...last, items: [...last.items, observation] };
    return;
  }

  run.steps.push({ kind: "observations", observedAt: observation.observedAt, turnId, leafId, items: [observation] });
}

function flushFilteredGap(run: MutableChainRun): void {
  if (run.filteredGap === 0) {
    return;
  }
  run.steps.push({ kind: "gap", observedAt: null, omitted: run.filteredGap, reason: "filtered-intermediates" });
  run.filteredGap = 0;
}

function toSkillChainRun(run: MutableChainRun): SkillChainRun {
  return {
    host: run.host,
    machineId: run.machineId,
    sourceId: run.sourceId,
    projectCwd: run.projectCwd,
    sessionId: run.sessionId,
    segmentId: run.segmentId,
    runId: run.runId,
    steps: run.steps,
  };
}

function chainEvidenceIncluded(evidence: ChainObservation["evidence"], filter: ChainFilter): boolean {
  if (filter.skillName !== undefined && evidenceSkillName(evidence) !== filter.skillName) {
    return false;
  }

  if (evidence.kind === "command-intent") {
    if (filter.modelSelection !== undefined) return false;
    if (filter.includeCommandIntent === false) return false;
    if (filter.modelProvider !== undefined && filter.modelProvider !== null) return false;
    if (filter.modelId !== undefined && filter.modelId !== null) return false;
    return filter.source === undefined || evidence.source === filter.source;
  }

  if (evidence.kind === "wrapper-observed") {
    if (filter.modelSelection !== undefined) return false;
    if (filter.includeWrapperObserved === false) return false;
    return filter.source === undefined
      && (filter.modelProvider === undefined || filter.modelProvider === null)
      && (filter.modelId === undefined || filter.modelId === null);
  }

  if (evidence.kind === "read-attempt" ? filter.includeReadAttempt === false : evidence.kind === "skill-invocation" ? filter.includeSkillInvocation === false : filter.includeReadResult === false) return false;
  if (filter.source !== undefined) return false;
  if (filter.modelSelection !== undefined) {
    return filter.modelSelection.kind === "unknown" ? evidence.model === null
      : evidence.model?.provider === filter.modelSelection.model.provider && evidence.model.id === filter.modelSelection.model.id;
  }
  if (filter.modelProvider !== undefined) {
    if (filter.modelProvider === null && evidence.model !== null) return false;
    if (filter.modelProvider !== null && evidence.model?.provider !== filter.modelProvider) return false;
  }
  if (filter.modelId !== undefined) {
    if (filter.modelId === null && evidence.model !== null) return false;
    if (filter.modelId !== null && evidence.model?.id !== filter.modelId) return false;
  }
  return true;
}

function evidenceSkillName(evidence: ChainObservation["evidence"]): string {
  switch (evidence.kind) {
    case "command-intent":
      return evidence.skillName;
    case "wrapper-observed":
    case "read-result":
    case "skill-invocation":
    case "read-attempt":
      return evidence.skill.name;
    default: {
      const _exhaustive: never = evidence;
      return _exhaustive;
    }
  }
}

function evidenceFromRow(row: Record<string, unknown>): ChainObservation["evidence"] {
  const kind = requireString(row.evidence_kind, "evidence_kind");
  if (kind === "command-intent") {
    return { kind, skillName: requireString(row.skill_name, "skill_name"), source: requireInputSource(row.source) };
  }
  if (kind === "wrapper-observed") {
    return { kind, skill: skillFromRow(row), wrapperSource: requireWrapperSource(row.wrapper_source) };
  }
  if (kind === "read-attempt") { return { kind, skill: skillFromRow(row), toolCallId: requireString(row.tool_call_id, "tool_call_id"), model: modelFromColumns(row.model_provider, row.model_id) }; }
  if (kind === "skill-invocation") { return { kind, skill: { name: requireString(row.skill_name, "skill_name"), canonicalPath: nullableString(row.skill_path), version: nullableString(row.skill_version) }, toolCallId: requireString(row.tool_call_id, "tool_call_id"), outcome: requireOutcome(row.outcome), model: modelFromColumns(row.model_provider, row.model_id) }; }
  if (kind === "read-result") {
    return {
      kind,
      skill: skillFromRow(row),
      toolCallId: requireString(row.tool_call_id, "tool_call_id"),
      outcome: requireOutcome(row.outcome),
      model: modelFromColumns(row.model_provider, row.model_id),
    };
  }
  throw new Error(`Unsupported chain evidence kind ${kind}`);
}

function contentSkillFact(row: Record<string, unknown>): ContentFact<ContentSkillEvidence> {
  const evidence = evidenceFromRow(row);
  const observation = parseObservation({
    id: row.id, producerId: row.producer_id, sequence: row.sequence, host: row.host, observedAt: row.observed_at, evidence,
    scope: { projectCwd: row.project_cwd, sessionId: row.session_id, sessionFile: row.session_file, segmentId: row.segment_id,
      segmentReason: row.segment_reason, runId: row.run_id, turnId: row.turn_id, leafId: row.leaf_id },
  });
  return { ...observation, evidence, machineId: parseMachineId(row.machine_id), sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id) };
}

function skillFromRow(row: Record<string, unknown>): SkillRef {
  return {
    name: requireString(row.skill_name, "skill_name"),
    canonicalPath: requireString(row.skill_path, "skill_path"),
    version: nullableString(row.skill_version),
  };
}

function modelFromColumns(provider: unknown, id: unknown): ModelRef {
  const modelProvider = nullableString(provider);
  const modelId = nullableString(id);
  if (modelProvider === null || modelId === null) {
    return null;
  }
  return { provider: modelProvider, id: modelId };
}

function firstRow(db: DatabaseSync, sql: string, params: readonly SqlValue[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...params);
}

function count(db: DatabaseSync, sql: string, params: readonly SqlValue[]): number {
  return numberValue(firstRow(db, sql, params)?.value);
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string`);
  }
  return value;
}

function requireInputSource(value: unknown): InputSource {
  if (isInputSource(value)) {
    return value;
  }
  throw new Error("Expected input source");
}

function requireGapReason(value: unknown): GapReason {
  if (isGapReason(value)) {
    return value;
  }
  throw new Error("Expected gap reason");
}

function requireWrapperSource(value: unknown): "expanded-prompt" | "unknown-pasted-or-transformed" {
  if (value === "expanded-prompt" || value === "unknown-pasted-or-transformed") {
    return value;
  }
  throw new Error("Expected wrapper source");
}

function requireOutcome(value: unknown): "success" | "error" {
  if (value === "success" || value === "error") {
    return value;
  }
  throw new Error("Expected read outcome");
}

function latestTime(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function nullLastCompare(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function observationCount(input: Observation | readonly Observation[]): number {
  return Array.isArray(input) ? input.length : 1;
}

function boundedBusyTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_BUSY_TIMEOUT_MS;
  }
  return Math.max(0, Math.min(Math.floor(value), DEFAULT_BUSY_TIMEOUT_MS));
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function secureDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }
  chmodBestEffort(databasePath, 0o600);
  chmodBestEffort(`${databasePath}-wal`, 0o600);
  chmodBestEffort(`${databasePath}-shm`, 0o600);
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {}
}

function rollbackBestEffort(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {}
}

function execWithBusyRetry(db: DatabaseSync, sql: string, retries: number): void {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === retries) {
        throw error;
      }
      sleepSync(Math.min(5 * (attempt + 1), 25));
    }
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Hotplate store is closed");
  }
}

function isBusyError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}
