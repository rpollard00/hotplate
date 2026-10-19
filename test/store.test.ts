import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  openHotplateReadStore,
  openHotplateStore,
  resolveHotplateDatabasePath,
  type Observation,
} from "../src/index.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-core-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function observation(overrides: Partial<Observation> & Pick<Observation, "id" | "evidence">): Observation {
  return {
    producerId: "producer-a",
    sequence: Number.parseInt(overrides.id.replace(/\D/g, ""), 10) || 0,
    observedAt: "2026-01-01T00:00:00.000Z",
    scope: {
      projectCwd: "/workspace/a",
      sessionId: "session-a",
      sessionFile: "/sessions/a.jsonl",
      segmentId: "segment-a",
      segmentReason: "startup",
      runId: "run-a",
      turnId: "turn-a",
      leafId: "leaf-a",
    },
    ...overrides,
  };
}

function skill(name = "alpha") {
  return { name, canonicalPath: `/skills/${name}/SKILL.md`, version: "v1" };
}

test("path resolution and migrations do not create a missing read-only database", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "data", "analytics.sqlite");
    assert.equal(resolveHotplateDatabasePath({ env: { HOTPLATE_DB: dbPath }, homeDir: dir }), dbPath);
    assert.deepEqual(openHotplateReadStore({ databasePath: dbPath }), { kind: "missing", databasePath: dbPath });

    const store = openHotplateStore({ databasePath: dbPath });
    assert.equal((await store.queryOverview({})).observationCount, 0);
    await store.close();

    const mode = (await stat(dbPath)).mode & 0o777;
    assert.equal(mode & 0o077, 0);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
    db.close();

    const read = openHotplateReadStore({ databasePath: dbPath });
    assert.equal(read.kind, "ready");
    if (read.kind === "ready") {
      assert.equal((await read.store.queryOverview({})).observationCount, 0);
      await read.store.close();
    }
  });
});

test("record is idempotent and query views keep evidence classes separate", async () => {
  await withTempDir(async (dir) => {
    const store = openHotplateStore({ databasePath: join(dir, "analytics.sqlite") });
    const observations: Observation[] = [
      observation({
        id: "obs-1",
        evidence: { kind: "catalog-snapshot", skills: [skill("alpha"), skill("unused")] },
      }),
      observation({
        id: "obs-2",
        observedAt: "2026-01-01T00:00:01.000Z",
        evidence: { kind: "command-intent", skillName: "alpha", source: "rpc" },
      }),
      observation({
        id: "obs-3",
        observedAt: "2026-01-01T00:00:02.000Z",
        evidence: { kind: "wrapper-observed", skill: skill("alpha"), wrapperSource: "expanded-prompt" },
      }),
      observation({
        id: "obs-4",
        observedAt: "2026-01-01T00:00:03.000Z",
        evidence: {
          kind: "read-result",
          skill: skill("alpha"),
          toolCallId: "tool-alpha",
          outcome: "success",
          model: { provider: "openai", id: "gpt-4.1" },
        },
      }),
      observation({
        id: "obs-5",
        observedAt: "2026-01-01T00:00:04.000Z",
        evidence: {
          kind: "read-result",
          skill: skill("unused"),
          toolCallId: "tool-unused",
          outcome: "error",
          model: null,
        },
      }),
      observation({
        id: "obs-6",
        observedAt: "2026-01-01T00:00:05.000Z",
        evidence: { kind: "capture-gap", dropped: 3, reason: "queue-overflow" },
      }),
    ];

    assert.deepEqual(await store.record(observations), { accepted: 6, duplicate: 0, dropped: 0 });
    const repeatedObservation = observations[3];
    assert.ok(repeatedObservation);
    assert.deepEqual(await store.record(repeatedObservation), { accepted: 0, duplicate: 1, dropped: 0 });

    const overview = await store.queryOverview({ projectCwd: "/workspace/a" });
    assert.equal(overview.observationCount, 6);
    assert.equal(overview.commandIntentCount, 1);
    assert.equal(overview.rpcCommandIntentCount, 1);
    assert.equal(overview.wrapperObservedCount, 1);
    assert.equal(overview.readResultCount, 2);
    assert.equal(overview.successfulReadCount, 1);
    assert.equal(overview.failedReadCount, 1);
    assert.equal(overview.uniqueObservedSkillRunActivations, 1);
    assert.equal(overview.catalogSkillCount, 2);
    assert.equal(overview.captureGapCount, 1);
    assert.equal(overview.droppedObservationCount, 3);

    const table = await store.querySkillTable({ projectCwd: "/workspace/a" });
    const alpha = table.rows.find((row) => row.skillName === "alpha" && row.canonicalPath === "/skills/alpha/SKILL.md");
    assert.ok(alpha);
    assert.equal(alpha.cataloged, true);
    assert.equal(alpha.wrapperObservedCount, 1);
    assert.equal(alpha.successfulReadCount, 1);
    assert.equal(alpha.uniqueObservedRunActivations, 1);

    const intentOnly = table.rows.find((row) => row.skillName === "alpha" && row.canonicalPath === null);
    assert.ok(intentOnly);
    assert.equal(intentOnly.commandIntentCount, 1);
    assert.equal(intentOnly.rpcCommandIntentCount, 1);

    const matrix = await store.queryModelMatrix({ modelProvider: "openai" });
    assert.equal(matrix.rows.length, 1);
    assert.equal(matrix.rows[0]?.skillName, "alpha");
    assert.equal(matrix.rows[0]?.successfulReadCount, 1);

    const health = await store.queryCaptureHealth({});
    assert.equal(health.captureGapCount, 1);
    assert.equal(health.droppedObservationCount, 3);
    assert.equal(health.byReason[0]?.reason, "queue-overflow");

    await store.close();
    await store.close();
  });
});

test("skill chains split by session segment run and show filtered intermediates", async () => {
  await withTempDir(async (dir) => {
    const store = openHotplateStore({ databasePath: join(dir, "analytics.sqlite") });
    await store.record([
      observation({ id: "chain-1", evidence: { kind: "wrapper-observed", skill: skill("alpha"), wrapperSource: "expanded-prompt" } }),
      observation({
        id: "chain-2",
        observedAt: "2026-01-01T00:00:01.000Z",
        evidence: { kind: "wrapper-observed", skill: skill("beta"), wrapperSource: "expanded-prompt" },
      }),
      observation({
        id: "chain-3",
        observedAt: "2026-01-01T00:00:02.000Z",
        scope: {
          projectCwd: "/workspace/a",
          sessionId: "session-a",
          sessionFile: "/sessions/a.jsonl",
          segmentId: "segment-a",
          segmentReason: "startup",
          runId: "run-b",
          turnId: "turn-b",
          leafId: "leaf-a",
        },
        evidence: { kind: "wrapper-observed", skill: skill("alpha"), wrapperSource: "expanded-prompt" },
      }),
    ]);

    const chain = await store.querySkillChain({ projectCwd: "/workspace/a", skillName: "alpha" });
    assert.equal(chain.runs.length, 2);
    const runA = chain.runs.find((run) => run.runId === "run-a");
    assert.ok(runA);
    assert.equal(runA.steps.length, 2);
    assert.equal(runA.steps[0]?.kind, "observations");
    assert.equal(runA.steps[1]?.kind, "gap");
    assert.equal(runA.steps[1]?.kind === "gap" ? runA.steps[1].reason : null, "filtered-intermediates");

    const runB = chain.runs.find((run) => run.runId === "run-b");
    assert.ok(runB);
    assert.equal(runB.steps.length, 1);
    await store.close();
  });
});

test("lock contention returns dropped observations without throwing", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "analytics.sqlite");
    const store = openHotplateStore({ databasePath: dbPath, busyTimeoutMs: 1, busyRetries: 0 });
    const lock = new DatabaseSync(dbPath, { timeout: 1 });
    lock.exec("BEGIN EXCLUSIVE");
    const summary = await store.record(
      observation({ id: "locked-1", evidence: { kind: "wrapper-observed", skill: skill("alpha"), wrapperSource: "expanded-prompt" } }),
    );
    assert.deepEqual(summary, { accepted: 0, duplicate: 0, dropped: 1 });
    lock.exec("ROLLBACK");
    lock.close();
    await store.close();
  });
});

test("separate child processes write observations to one SQLite file", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "analytics.sqlite");
    const workerPath = fileURLToPath(new URL("./fixtures/concurrency-worker.js", import.meta.url));
    const workers = [0, 1, 2, 3].map((worker) =>
      runWorker(workerPath, [dbPath, `producer-${worker}`, String(worker * 100), "20"]),
    );
    const outputs = await Promise.all(workers);
    for (const output of outputs) {
      assert.equal(output.accepted, 20);
      assert.equal(output.dropped, 0);
    }

    const store = openHotplateStore({ databasePath: dbPath });
    const overview = await store.queryOverview({ projectCwd: "/tmp/hotplate-project" });
    assert.equal(overview.successfulReadCount, 80);
    assert.equal(overview.uniqueObservedSkillRunActivations, 4);
    await store.close();
  });
});

function runWorker(workerPath: string, args: readonly string[]): Promise<{ accepted: number; duplicate: number; dropped: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (isSummary(parsed)) {
          resolve(parsed);
          return;
        }
        reject(new Error(`Worker returned invalid summary: ${stdout}`));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isSummary(value: unknown): value is { accepted: number; duplicate: number; dropped: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "accepted" in value &&
    "duplicate" in value &&
    "dropped" in value &&
    typeof value.accepted === "number" &&
    typeof value.duplicate === "number" &&
    typeof value.dropped === "number"
  );
}
