import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContentFact } from "./content-analytics.js";
import type { InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";
import { isResourceLocation, parseMachineId, parseObservation, parseSourceId } from "./observation.js";

type Source = Pick<ContentFact, "machineId" | "sourceId">;

export function createSharedInventory(db: DatabaseSync): void {
  db.exec(`CREATE TABLE inventory_memberships (
    id TEXT PRIMARY KEY, canonical TEXT NOT NULL
  ) STRICT;
  CREATE TABLE inventory_membership_members (
    membership_id TEXT NOT NULL REFERENCES inventory_memberships(id),
    variant_id INTEGER NOT NULL REFERENCES inventory_location_variants(id),
    PRIMARY KEY(membership_id, variant_id)
  ) STRICT;
  ALTER TABLE inventory_scan_facts ADD COLUMN membership_id TEXT REFERENCES inventory_memberships(id);
  ALTER TABLE inventory_scan_facts ADD COLUMN positive_projection INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE inventory_scan_current (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, filesystem_id TEXT NOT NULL, root_path TEXT NOT NULL, scan_id TEXT NOT NULL,
    first_at TEXT NOT NULL, first_producer TEXT NOT NULL, first_sequence INTEGER NOT NULL, first_observation TEXT NOT NULL,
    started_at TEXT, completed_at TEXT, membership_id TEXT REFERENCES inventory_memberships(id),
    PRIMARY KEY(machine_id, source_id, filesystem_id, root_path, scan_id)
  ) STRICT;
  CREATE INDEX inventory_scan_complete_current_idx ON inventory_scan_current (
    machine_id, source_id, filesystem_id, root_path, completed_at DESC,
    first_at, first_producer, first_sequence, first_observation, membership_id
  ) WHERE membership_id IS NOT NULL;
  CREATE INDEX inventory_scan_uncertain_current_idx ON inventory_scan_current (
    machine_id, source_id, filesystem_id, root_path, COALESCE(started_at, first_at) DESC
  ) WHERE membership_id IS NULL;
  CREATE TABLE inventory_location_current (
    machine_id TEXT NOT NULL, source_id TEXT NOT NULL, host TEXT NOT NULL, visibility TEXT NOT NULL,
    variant_id INTEGER NOT NULL REFERENCES inventory_location_variants(id), first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    producer_id TEXT NOT NULL, sequence INTEGER NOT NULL, observation_id TEXT NOT NULL, resource_order INTEGER NOT NULL,
    PRIMARY KEY(machine_id, source_id, host, visibility, variant_id)
  ) STRICT;
  INSERT INTO inventory_location_current
    WITH ranked AS (SELECT *, MIN(first_at) OVER (PARTITION BY machine_id, source_id, host, visibility, variant_id) AS first_seen,
      ROW_NUMBER() OVER (PARTITION BY machine_id, source_id, host, visibility, variant_id
        ORDER BY last_at DESC, producer_id DESC, sequence DESC, observation_id DESC, resource_order DESC) AS position
      FROM inventory_location_buckets)
    SELECT machine_id, source_id, host, visibility, variant_id, first_seen, last_at, producer_id, sequence, observation_id, resource_order
      FROM ranked WHERE position = 1;`);
  for (const row of db.prepare(`SELECT machine_id, source_id, MIN(metadata_json) AS metadata_json FROM inventory_scan_facts
    GROUP BY machine_id, source_id, filesystem_id, root_path, scan_id`).iterate()) {
    const observation = parseObservation(JSON.parse(string(row.metadata_json)));
    if (observation.evidence.kind !== "inventory-snapshot") throw new Error("Invalid inventory frame");
    refreshInventoryMembership(db, { machineId: parseMachineId(row.machine_id), sourceId: row.source_id === "local" ? "local" : parseSourceId(row.source_id) }, observation.evidence);
  }
}

export function refreshInventoryMembership(db: DatabaseSync, source: Source, identity: InventorySnapshotEvidence): void {
  const keys = [source.machineId, source.sourceId, identity.filesystemId, identity.rootPath, identity.scanId];
  const predicate = "machine_id = ? AND source_id = ? AND filesystem_id = ? AND root_path = ? AND scan_id = ?";
  const frames = db.prepare(`SELECT metadata_json, batch_digest FROM inventory_scan_facts WHERE ${predicate}
    ORDER BY observed_at, producer_id, sequence, observation_id`).all(...keys);
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let firstOrder: ReturnType<typeof parseObservation> | undefined;
  let complete: number | null = null;
  let invalid = false;
  const batches = new Map<number, string>();
  let first: InventorySnapshotEvidence | undefined;
  for (const row of frames) {
    const observation = parseObservation(JSON.parse(string(row.metadata_json)));
    const evidence = observation.evidence;
    if (evidence.kind !== "inventory-snapshot") throw new Error("Invalid inventory frame");
    first ??= evidence;
    firstOrder ??= observation;
    if (first.origin !== evidence.origin || first.scope !== evidence.scope) invalid = true;
    switch (evidence.phase) {
      case "started": startedAt ??= observation.observedAt; break;
      case "batch": {
        const digest = string(row.batch_digest);
        if (batches.has(evidence.batchIndex) && batches.get(evidence.batchIndex) !== digest) invalid = true;
        batches.set(evidence.batchIndex, digest);
        break;
      }
      case "complete":
        if (complete !== null && complete !== evidence.batchCount) invalid = true;
        complete = evidence.batchCount;
        completedAt = observation.observedAt;
        break;
      case "incomplete": invalid = true; break;
      default: { const exhaustive: never = evidence; return exhaustive; }
    }
  }
  db.prepare(`UPDATE inventory_scan_facts SET membership_id = NULL WHERE ${predicate} AND membership_id IS NOT NULL`).run(...keys);
  if (!firstOrder) throw new Error("Missing inventory frame");
  const order = firstOrder;
  const publish = (membership: string | null) => db.prepare(`INSERT INTO inventory_scan_current VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, source_id, filesystem_id, root_path, scan_id) DO UPDATE SET
      first_at = excluded.first_at, first_producer = excluded.first_producer, first_sequence = excluded.first_sequence,
      first_observation = excluded.first_observation, started_at = excluded.started_at, completed_at = excluded.completed_at, membership_id = excluded.membership_id`)
    .run(...keys, order.observedAt, order.producerId, order.sequence, order.id, startedAt, completedAt, membership);
  if (startedAt === null || invalid || complete === null || batches.size !== complete) { publish(null); return; }
  for (let i = 0; i < complete; i += 1) if (!batches.has(i)) { publish(null); return; }
  const locations = new Set<string>();
  for (const row of db.prepare(`SELECT DISTINCT j.value AS location FROM inventory_scan_facts s JOIN resource_events e
    ON e.machine_id = s.machine_id AND e.source_id = s.source_id AND e.observation_id = s.observation_id
    JOIN json_each(e.payload, '$.evidence.resources') j
    WHERE s.machine_id = ? AND s.source_id = ? AND s.filesystem_id = ? AND s.root_path = ? AND s.scan_id = ? AND s.phase = 'batch'`).iterate(...keys)) {
    const resource: unknown = JSON.parse(string(row.location));
    if (!isResourceLocation(resource)) throw new Error("Invalid inventory member");
    locations.add(canonicalLocation(resource));
  }
  const members = [...locations].sort();
  const canonical = JSON.stringify(["inventory-membership-v1", ...keys.slice(0, 4), members]);
  const id = createHash("sha256").update(canonical).digest("hex");
  const existing = db.prepare("SELECT canonical FROM inventory_memberships WHERE id = ?").get(id);
  if (existing) {
    if (existing.canonical !== canonical) throw new Error("Inventory membership digest collision");
  } else {
    db.prepare("INSERT INTO inventory_memberships VALUES (?, ?)").run(id, canonical);
    const variant = db.prepare("INSERT INTO inventory_location_variants(location) VALUES (?) ON CONFLICT(location) DO UPDATE SET location = excluded.location RETURNING id");
    const insert = db.prepare("INSERT INTO inventory_membership_members VALUES (?, ?)");
    for (const member of members) {
      const row = variant.get(member);
      if (typeof row?.id !== "number") throw new Error("Invalid inventory variant");
      insert.run(id, row.id);
    }
  }
  db.prepare(`UPDATE inventory_scan_facts SET membership_id = ? WHERE ${predicate} AND phase = 'complete'`).run(id, ...keys);
  publish(id);
}

function canonicalLocation(resource: ResourceLocation): string {
  return JSON.stringify({ filesystemId: resource.filesystemId, canonicalPath: resource.canonicalPath, observedPath: resource.observedPath,
    rootPath: resource.rootPath, kind: resource.kind, ownerSkillPath: resource.ownerSkillPath });
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid inventory string"); return value; }
