import { DatabaseSync } from "node:sqlite";

export function removeAnalyticsProjectionSchema(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS inventory_scan_current; DROP TABLE IF EXISTS inventory_location_current; DROP TABLE IF EXISTS inventory_membership_members;
    DROP TABLE IF EXISTS inventory_scan_facts; DROP TABLE IF EXISTS inventory_memberships; DROP TABLE IF EXISTS filesystem_access_buckets; DROP TABLE IF EXISTS resource_access_facts;
    DROP TABLE IF EXISTS observer_coverage_facts;
    DROP TABLE IF EXISTS inventory_location_buckets; DROP TABLE IF EXISTS inventory_location_variants;`);
}

export function createLegacyDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        producer_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        observed_at TEXT NOT NULL,
        project_cwd TEXT NOT NULL,
        session_id TEXT,
        session_file TEXT,
        segment_id TEXT NOT NULL,
        segment_reason TEXT NOT NULL CHECK(segment_reason IN ('startup','reload','new','resume','fork','branch','unknown')),
        run_id TEXT,
        turn_id TEXT,
        leaf_id TEXT,
        evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('command-intent','wrapper-observed','read-result','catalog-snapshot','capture-gap')),
        skill_name TEXT,
        skill_path TEXT,
        skill_version TEXT,
        source TEXT CHECK(source IS NULL OR source IN ('interactive','rpc','extension')),
        wrapper_source TEXT CHECK(wrapper_source IS NULL OR wrapper_source IN ('expanded-prompt','unknown-pasted-or-transformed')),
        tool_call_id TEXT,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('success','error')),
        model_provider TEXT,
        model_id TEXT,
        dropped INTEGER CHECK(dropped IS NULL OR dropped >= 0),
        gap_reason TEXT CHECK(gap_reason IS NULL OR gap_reason IN ('queue-overflow','db-busy','db-error','shutdown-deadline','invalid-observation'))
      ) STRICT;
      CREATE TABLE catalog_skills (
        project_cwd TEXT NOT NULL, skill_name TEXT NOT NULL, skill_path TEXT NOT NULL, skill_version TEXT,
        first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
        PRIMARY KEY(project_cwd, skill_name, skill_path)
      ) STRICT;
      CREATE INDEX observations_time_idx ON observations(observed_at);
      CREATE INDEX observations_scope_idx ON observations(project_cwd, session_id, segment_id, run_id, observed_at);
      CREATE INDEX observations_skill_idx ON observations(skill_name, skill_path, evidence_kind);
      CREATE INDEX observations_model_idx ON observations(model_provider, model_id, evidence_kind);
      CREATE INDEX observations_source_idx ON observations(source, evidence_kind);
      INSERT INTO observations (id, producer_id, sequence, observed_at, project_cwd, segment_id, segment_reason, evidence_kind)
        VALUES ('legacy-catalog', 'legacy', 0, '2026-01-01T00:00:00.000Z', '/legacy', 'segment', 'startup', 'catalog-snapshot');
      INSERT INTO catalog_skills VALUES ('/legacy', 'alpha', '/skills/alpha', 'v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
  } finally { db.close(); }
}
