import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { isResourceEvidence } from "./observation.js";
import type { InventorySnapshotEvidence, ResourceLocation } from "./resource-domain.js";

const PAGE_BYTES = 4096;
const DEFAULT_STAGE_BYTES = 256 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

type TerminalEvidence = Extract<InventorySnapshotEvidence, { phase: "complete" | "incomplete" }>;
export type SnapshotDigest = Readonly<{ sha256: string }>;
type StagedSnapshot = {
  key: string;
  terminal: TerminalEvidence;
  digest: SnapshotDigest;
  frames(): Generator<InventorySnapshotEvidence>;
};

export type InventoryStageOptions = {
  stagingDirectory?: string;
  maxStagedBytes?: number;
};

export function createInventoryStage(options: InventoryStageOptions = {}): {
  append(evidence: InventorySnapshotEvidence): void;
  snapshots(): Generator<StagedSnapshot>;
  hasRoot(key: string): boolean;
  close(): void;
} {
  const maxBytes = options.maxStagedBytes ?? DEFAULT_STAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < PAGE_BYTES) throw new Error("Invalid inventory staging byte limit.");
  const directory = mkdtempSync(join(options.stagingDirectory ?? tmpdir(), "hotplate-inventory-"));
  let database: DatabaseSync | null = null;
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, "stage.sqlite");
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    database = new DatabaseSync(path, { allowExtension: false });
    return openDisposableStage(database, directory, maxBytes);
  } catch (error) {
    try { database?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
    throw error;
  }
}

function openDisposableStage(db: DatabaseSync, directory: string, maxBytes: number): ReturnType<typeof createInventoryStage> {
  db.exec(`
    PRAGMA page_size = ${PAGE_BYTES};
    PRAGMA max_page_count = ${Math.floor(maxBytes / PAGE_BYTES)};
    PRAGMA cache_size = -1024;
    PRAGMA mmap_size = 0;
    PRAGMA temp_store = FILE;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY,
      root_key TEXT NOT NULL UNIQUE,
      scan_id TEXT NOT NULL UNIQUE,
      frame_count INTEGER NOT NULL DEFAULT 0,
      resource_count INTEGER NOT NULL DEFAULT 0,
      terminal_sequence INTEGER
    );
    CREATE TABLE frames (
      snapshot_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, sequence)
    ) WITHOUT ROWID;
    CREATE TABLE resources (
      snapshot_id INTEGER NOT NULL,
      digest TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, digest, sequence)
    ) WITHOUT ROWID;
  `);
  const insertSnapshot = db.prepare("INSERT INTO snapshots (root_key, scan_id) VALUES (?, ?)");
  const findSnapshot = db.prepare("SELECT id, frame_count, resource_count, terminal_sequence FROM snapshots WHERE scan_id = ?");
  const insertFrame = db.prepare("INSERT INTO frames VALUES (?, ?, ?)");
  const insertResource = db.prepare("INSERT INTO resources VALUES (?, ?, ?)");
  const updateSnapshot = db.prepare("UPDATE snapshots SET frame_count = ?, resource_count = ?, terminal_sequence = ? WHERE id = ?");
  const findFrame = db.prepare("SELECT payload FROM frames WHERE snapshot_id = ? AND sequence = ?");
  const readFrames = db.prepare("SELECT payload FROM frames WHERE snapshot_id = ? ORDER BY sequence");
  const readHashes = db.prepare("SELECT digest FROM resources WHERE snapshot_id = ? ORDER BY digest, sequence");
  const findRoot = db.prepare("SELECT 1 FROM snapshots WHERE root_key = ?");
  let bytes = 0;

  return {
    append(evidence) {
      const payload = JSON.stringify(evidence);
      const frameBytes = Buffer.byteLength(payload);
      if (frameBytes > MAX_FRAME_BYTES) throw new Error("Inventory staging frame exceeds the byte limit.");
      const key = JSON.stringify([evidence.filesystemId, evidence.rootPath]);
      const addedBytes = frameBytes + evidence.resources.length * 64
        + (evidence.phase === "started" ? Buffer.byteLength(key) + Buffer.byteLength(evidence.scanId) : 0);
      if (addedBytes > maxBytes - bytes) throw new Error("Inventory staging exceeds the byte limit.");
      db.exec("BEGIN");
      try {
        if (evidence.phase === "started") insertSnapshot.run(key, evidence.scanId);
        const row = findSnapshot.get(evidence.scanId);
        if (!row || row.terminal_sequence !== null) throw new Error("Invalid inventory staging sequence.");
        const id = integerColumn(row.id);
        const sequence = integerColumn(row.frame_count);
        let resourceCount = integerColumn(row.resource_count);
        const terminal = evidence.phase === "complete" || evidence.phase === "incomplete";
        if ((evidence.phase === "started" && sequence !== 0)
          || (evidence.phase === "batch" && evidence.batchIndex !== sequence - 1)
          || (terminal && evidence.batchCount !== sequence - 1)) throw new Error("Invalid inventory staging sequence.");
        insertFrame.run(id, sequence, payload);
        for (const resource of evidence.resources) {
          insertResource.run(id, resourceDigest(resource), resourceCount);
          resourceCount += 1;
        }
        updateSnapshot.run(sequence + 1, resourceCount, terminal ? sequence : null, id);
        db.exec("COMMIT");
        bytes += addedBytes;
      } catch (error) {
        // SQLITE_FULL can roll back the transaction itself.
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    *snapshots() {
      if (db.prepare("SELECT 1 FROM snapshots WHERE terminal_sequence IS NULL LIMIT 1").get()) {
        throw new Error("Inventory staging has an unfinished snapshot.");
      }
      for (const row of db.prepare("SELECT id, root_key, resource_count, terminal_sequence FROM snapshots ORDER BY id").iterate()) {
        const id = integerColumn(row.id);
        const terminalRow = findFrame.get(id, integerColumn(row.terminal_sequence));
        const terminal = parseFrame(terminalRow?.payload);
        if (terminal.phase !== "complete" && terminal.phase !== "incomplete") throw new Error("Invalid inventory staging terminal.");
        const hash = createHash("sha256");
        hashPart(hash, JSON.stringify([terminal.origin, terminal.scope, terminal.phase, terminal.error]));
        for (const resource of readHashes.iterate(id)) hashPart(hash, textColumn(resource.digest));
        hashPart(hash, String(integerColumn(row.resource_count)));
        yield {
          key: textColumn(row.root_key),
          terminal,
          digest: { sha256: hash.digest("hex") },
          *frames() {
            for (const frame of readFrames.iterate(id)) yield parseFrame(frame.payload);
          },
        };
      }
    },
    hasRoot(key) { return findRoot.get(key) !== undefined; },
    close() {
      try { db.close(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    },
  };
}

function resourceDigest(resource: ResourceLocation): string {
  return createHash("sha256").update(JSON.stringify([
    resource.filesystemId, resource.canonicalPath, resource.observedPath,
    resource.rootPath, resource.kind, resource.ownerSkillPath,
  ])).digest("hex");
}

function hashPart(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(`${Buffer.byteLength(value)}:`).update(value);
}

function parseFrame(value: SQLOutputValue | undefined): InventorySnapshotEvidence {
  const parsed: unknown = JSON.parse(textColumn(value));
  if (!isResourceEvidence(parsed) || parsed.kind !== "inventory-snapshot") throw new Error("Invalid inventory staging frame.");
  return parsed;
}

function textColumn(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid inventory staging text.");
  return value;
}

function integerColumn(value: SQLOutputValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid inventory staging integer.");
  return value;
}
