import { existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import type {
  CaptureHealthReasonRow,
  CaptureHealthView,
  CaptureWriteSummary,
  ChainFilter,
  ChainObservation,
  DashboardFilter,
  Evidence,
  GapReason,
  HotplateStore,
  InputSource,
  ModelMatrixRow,
  ModelMatrixView,
  ModelRef,
  Observation,
  OverviewView,
  SegmentReason,
  SkillChainRun,
  SkillChainStep,
  SkillChainView,
  SkillRef,
  SkillTableRow,
  SkillTableView,
} from "./domain.js";

const SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 25;
const DEFAULT_BUSY_RETRIES = 3;

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

export function openHotplateStore(options: OpenHotplateStoreOptions = {}): HotplateStore {
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

class SqliteHotplateStore implements HotplateStore {
  readonly #db: DatabaseSync;
  readonly #databasePath: string;
  readonly #readOnly: boolean;
  readonly #busyRetries: number;
  #closed = false;

  constructor(options: { db: DatabaseSync; databasePath: string; readOnly: boolean; busyRetries: number }) {
    this.#db = options.db;
    this.#databasePath = options.databasePath;
    this.#readOnly = options.readOnly;
    this.#busyRetries = options.busyRetries;
    try {
      execWithBusyRetry(this.#db, "PRAGMA foreign_keys = ON", this.#busyRetries);
      if (!this.#readOnly) {
        execWithBusyRetry(this.#db, "PRAGMA journal_mode = WAL", this.#busyRetries);
        execWithBusyRetry(this.#db, "PRAGMA synchronous = NORMAL", this.#busyRetries);
        migrate(this.#db, this.#busyRetries);
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

  async record(input: Observation | readonly Observation[]): Promise<CaptureWriteSummary> {
    if (this.#closed || this.#readOnly) {
      return { accepted: 0, duplicate: 0, dropped: observationCount(input) };
    }

    const observations = Array.isArray(input) ? input : [input];
    const valid: Observation[] = [];
    let invalid = 0;
    for (const observation of observations) {
      if (isObservation(observation)) {
        valid.push(observation);
      } else {
        invalid += 1;
      }
    }

    if (valid.length === 0) {
      return { accepted: 0, duplicate: 0, dropped: invalid };
    }

    for (let attempt = 0; attempt <= this.#busyRetries; attempt += 1) {
      try {
        const written = this.#write(valid);
        return { ...written, dropped: invalid };
      } catch (error) {
        rollbackBestEffort(this.#db);
        if (!isBusyError(error) || attempt === this.#busyRetries) {
          return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
        }
        await delay(Math.min(5 * (attempt + 1), 25));
      }
    }

    return { accepted: 0, duplicate: 0, dropped: valid.length + invalid };
  }

  async queryOverview(filter: DashboardFilter): Promise<OverviewView> {
    assertOpen(this.#closed);
    const where = observationWhere(filter);
    const skillRunWhere = observationWhere(filter, ["AND evidence_kind IN ('wrapper-observed', 'read-result')"]);
    const catalogWhere = catalogWhereClause(filter);

    return {
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
          FROM observations ${skillRunWhere.sql} AND skill_name IS NOT NULL AND (evidence_kind != 'read-result' OR outcome = 'success')
          GROUP BY skill_name, skill_path, project_cwd, session_id, segment_id, run_id
        )`,
        skillRunWhere.params,
      ),
      catalogSkillCount: count(this.#db, `SELECT COUNT(*) AS value FROM catalog_skills ${catalogWhere.sql}`, catalogWhere.params),
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
      SELECT skill_name, skill_path, skill_version, last_observed_at
      FROM catalog_skills ${catalogWhereClause(filter).sql}
      ORDER BY skill_name, skill_path
    `).all(...catalogWhereClause(filter).params);

    for (const row of catalog) {
      const skillName = requireString(row.skill_name, "skill_name");
      const canonicalPath = requireString(row.skill_path, "skill_path");
      const entry = getSkillRow(rows, skillName, canonicalPath, nullableString(row.skill_version));
      entry.cataloged = true;
      entry.lastObservedAt = latestTime(entry.lastObservedAt, nullableString(row.last_observed_at));
    }

    const where = observationWhere(filter, ["AND evidence_kind IN ('command-intent', 'wrapper-observed', 'read-result')"]);
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
      const entry = getSkillRow(rows, skillName, canonicalPath, nullableString(row.skill_version));
      entry.lastObservedAt = latestTime(entry.lastObservedAt, requireString(row.observed_at, "observed_at"));

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
      const key = activation.slice(0, activation.indexOf("\u0000"));
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
        skill_name,
        skill_path,
        model_provider,
        model_id,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successful_read_count,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS failed_read_count,
        COUNT(*) AS read_result_count,
        COUNT(DISTINCT CASE WHEN outcome = 'success' THEN json_array(project_cwd, session_id, segment_id, run_id, skill_name, skill_path) END) AS unique_activations
      FROM observations ${where.sql} AND skill_name IS NOT NULL AND skill_path IS NOT NULL
      GROUP BY skill_name, skill_path, model_provider, model_id
      ORDER BY skill_name, skill_path, model_provider, model_id
    `).all(...where.params);

    return {
      rows: rows.map((row): ModelMatrixRow => ({
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
        AND evidence_kind IN ('command-intent', 'wrapper-observed', 'read-result', 'capture-gap')
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

  async close(_options: { deadlineMs?: number } = {}): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#db.close();
  }

  #write(observations: readonly Observation[]): CaptureWriteSummary {
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO observations (
        id, producer_id, sequence, observed_at, project_cwd, session_id, session_file,
        segment_id, segment_reason, run_id, turn_id, leaf_id, evidence_kind, skill_name,
        skill_path, skill_version, source, wrapper_source, tool_call_id, outcome,
        model_provider, model_id, dropped, gap_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertCatalog = this.#db.prepare(`
      INSERT INTO catalog_skills (project_cwd, skill_name, skill_path, skill_version, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_cwd, skill_name, skill_path) DO UPDATE SET
        skill_version = excluded.skill_version,
        last_observed_at = excluded.last_observed_at
    `);

    let accepted = 0;
    let duplicate = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    for (const observation of observations) {
      const flattened = flattenObservation(observation);
      const result = insert.run(...flattened.values);
      if (numberValue(result.changes) === 0) {
        duplicate += 1;
        continue;
      }
      accepted += 1;
      if (observation.evidence.kind === "catalog-snapshot") {
        for (const skill of observation.evidence.skills) {
          upsertCatalog.run(
            observation.scope.projectCwd,
            skill.name,
            skill.canonicalPath,
            skill.version,
            observation.observedAt,
            observation.observedAt,
          );
        }
      }
    }
    this.#db.exec("COMMIT");
    secureDatabaseFiles(this.#databasePath);
    return { accepted, duplicate, dropped: 0 };
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
          observation.evidence.outcome,
          observation.evidence.model?.provider ?? null,
          observation.evidence.model?.id ?? null,
          null,
          null,
        ],
      };
    case "catalog-snapshot":
      return { values: [...base, null, null, null, null, null, null, null, null, null, null, null] };
    case "capture-gap":
      return { values: [...base, null, null, null, null, null, null, null, null, null, observation.evidence.dropped, observation.evidence.reason] };
    default: {
      const _exhaustive: never = observation.evidence;
      return _exhaustive;
    }
  }
}

function migrate(db: DatabaseSync, busyRetries: number): void {
  const version = userVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`Unsupported Hotplate schema version ${version}`);
  }
  if (version === SCHEMA_VERSION) {
    return;
  }

  execWithBusyRetry(db, `
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
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
      gap_reason TEXT CHECK(gap_reason IS NULL OR gap_reason IN ('queue-overflow', 'db-busy', 'db-error', 'shutdown-deadline', 'invalid-observation'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS catalog_skills (
      project_cwd TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_path TEXT NOT NULL,
      skill_version TEXT,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      PRIMARY KEY (project_cwd, skill_name, skill_path)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS observations_time_idx ON observations(observed_at);
    CREATE INDEX IF NOT EXISTS observations_scope_idx ON observations(project_cwd, session_id, segment_id, run_id, observed_at);
    CREATE INDEX IF NOT EXISTS observations_skill_idx ON observations(skill_name, skill_path, evidence_kind);
    CREATE INDEX IF NOT EXISTS observations_model_idx ON observations(model_provider, model_id, evidence_kind);
    CREATE INDEX IF NOT EXISTS observations_source_idx ON observations(source, evidence_kind);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `, busyRetries);
}

function assertReadableSchema(db: DatabaseSync): void {
  const version = userVersion(db);
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
  if (filter.modelProvider !== undefined) {
    if (filter.modelProvider === null) clauses.push("model_provider IS NULL");
    else {
      clauses.push("model_provider = ?");
      params.push(filter.modelProvider);
    }
  }
  if (filter.modelId !== undefined) {
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

type MutableSkillTableRow = SkillTableRow;

function getSkillRow(rows: Map<string, MutableSkillTableRow>, skillName: string, canonicalPath: string | null, version: string | null): MutableSkillTableRow {
  const key = skillKey(skillName, canonicalPath);
  const existing = rows.get(key);
  if (existing) {
    if (existing.version === null && version !== null) {
      existing.version = version;
    }
    return existing;
  }

  const row: MutableSkillTableRow = {
    skillName,
    canonicalPath,
    version,
    cataloged: false,
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
  activations.add([
    skillKey(row.skillName, row.canonicalPath),
    source.project_cwd,
    source.session_id ?? "",
    source.segment_id,
    source.run_id ?? "",
  ].join("\u0000"));
}

function skillKey(skillName: string, canonicalPath: string | null): string {
  return `${skillName}\u001F${canonicalPath ?? ""}`;
}

type MutableChainRun = {
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
  const key = [projectCwd, sessionId ?? "", segmentId, runId ?? ""].join("\u001F");
  const existing = runs.get(key);
  if (existing) {
    return existing;
  }
  const created: MutableChainRun = { projectCwd, sessionId, segmentId, runId, steps: [], filteredGap: 0 };
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
    if (filter.includeCommandIntent === false) return false;
    if (filter.modelProvider !== undefined && filter.modelProvider !== null) return false;
    if (filter.modelId !== undefined && filter.modelId !== null) return false;
    return filter.source === undefined || evidence.source === filter.source;
  }

  if (evidence.kind === "wrapper-observed") {
    if (filter.includeWrapperObserved === false) return false;
    return filter.source === undefined && filter.modelProvider === undefined && filter.modelId === undefined;
  }

  if (filter.includeReadResult === false) return false;
  if (filter.source !== undefined) return false;
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

function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.producerId)) return false;
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) return false;
  if (!isNonEmptyString(value.observedAt)) return false;
  if (!isScope(value.scope)) return false;
  return isEvidence(value.evidence);
}

function isScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.projectCwd)) return false;
  if (!isNullableString(value.sessionId)) return false;
  if (!isNullableString(value.sessionFile)) return false;
  if (!isNonEmptyString(value.segmentId)) return false;
  if (!isSegmentReason(value.segmentReason)) return false;
  if (!isNullableString(value.runId)) return false;
  if (!isNullableString(value.turnId)) return false;
  return isNullableString(value.leafId);
}

function isEvidence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "command-intent":
      return isNonEmptyString(value.skillName) && isInputSource(value.source);
    case "wrapper-observed":
      return isSkillRef(value.skill) && (value.wrapperSource === "expanded-prompt" || value.wrapperSource === "unknown-pasted-or-transformed");
    case "read-result":
      return isSkillRef(value.skill) && isNonEmptyString(value.toolCallId) && (value.outcome === "success" || value.outcome === "error") && isModelRef(value.model);
    case "catalog-snapshot":
      return Array.isArray(value.skills) && value.skills.every(isSkillRef);
    case "capture-gap":
      return typeof value.dropped === "number" && Number.isInteger(value.dropped) && value.dropped >= 0 && isGapReason(value.reason);
    default:
      return false;
  }
}

function isSkillRef(value: unknown): value is SkillRef {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.name) && isNonEmptyString(value.canonicalPath) && isNullableString(value.version);
}

function isModelRef(value: unknown): value is ModelRef {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.provider) && isNonEmptyString(value.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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

function isInputSource(value: unknown): value is InputSource {
  return value === "interactive" || value === "rpc" || value === "extension";
}

function isSegmentReason(value: unknown): value is SegmentReason {
  return value === "startup" || value === "reload" || value === "new" || value === "resume" || value === "fork" || value === "branch" || value === "unknown";
}

function isGapReason(value: unknown): value is GapReason {
  return value === "queue-overflow" || value === "db-busy" || value === "db-error" || value === "shutdown-deadline" || value === "invalid-observation";
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
