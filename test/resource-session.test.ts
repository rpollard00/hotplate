import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { readProcessIdentity } from "../src/process-attribution.js";
import { discoverResourceRoots } from "../src/resource-paths.js";
import { runSessionInventory, type SessionInventoryRequest } from "../src/resource-session.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "skills");
  mkdirSync(root);
  for (let index = 0; index < 200; index += 1) writeFileSync(join(root, `reference-${index}.md`), "fixture");
  const databasePath = join(directory, "capture.sqlite");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, CODEX_HOME: join(directory, "codex"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    HOTPLATE_DB: databasePath, HOTPLATE_RESOURCE_ROOTS: root, HOTPLATE_PROCESS_REGISTRY: join(directory, "registry"),
    HOTPLATE_FILESYSTEM_ID: "session-fixture", HOTPLATE_DISABLED: "0" };
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_RESOURCES_CONFIG;
  const cache = join(directory, "cache", "hotplate", "session-inventory");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  return { directory, databasePath, env, cache };
}

function slot(data: ReturnType<typeof fixture>, request: SessionInventoryRequest) {
  const roots = discoverResourceRoots({ cwd: request.cwd, env: data.env });
  const key = createHash("sha256").update(JSON.stringify([data.databasePath, "local", request.host, request.sessionId, request.cwd, roots])).digest("hex");
  return { lease: join(data.cache, `${key}.lease`), completed: join(data.cache, `${key}.complete`) };
}

function inventoryCounts(databasePath: string, sessionId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`SELECT json_extract(payload, '$.evidence.phase') AS phase, COUNT(*) AS count
      FROM resource_events WHERE json_extract(payload, '$.scope.sessionId') = ?
      AND json_extract(payload, '$.evidence.phase') IN ('started', 'complete') GROUP BY phase ORDER BY phase`).all(sessionId)
      .map(row => [row.phase, row.count]);
  } finally { db.close(); }
}

async function runConcurrent(t: TestContext, request: SessionInventoryRequest, env: NodeJS.ProcessEnv) {
  const script = `import { runSessionInventory } from ${JSON.stringify(new URL("../src/resource-session.js", import.meta.url).href)};
    process.once("message", async () => {
      try { await runSessionInventory(JSON.parse(process.argv[1])); }
      catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
      finally { process.disconnect(); }
    });
    process.send("ready");`;
  const workers = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request)], {
      env, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error(stderr || "Inventory worker exited before readiness")));
    });
    const finished = new Promise<{ code: number | null; stderr: string }>(resolve => {
      child.once("close", code => resolve({ code, stderr }));
    });
    return { child, ready, finished };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send("run");
  const outcomes = await Promise.all(workers.map(worker => worker.finished));
  assert.ok(outcomes.every(outcome => outcome.code === 0), JSON.stringify(outcomes));
}

test("concurrent native processes reclaim expired leases without duplicate scans or deleting replacements", { timeout: 30000 }, async t => {
  const data = fixture(t);
  for (let round = 0; round < 12; round += 1) {
    const request: SessionInventoryRequest = { host: "claude-code", sessionId: `session-${round}`, cwd: data.directory };
    const paths = slot(data, request);
    writeFileSync(paths.lease, JSON.stringify({ token: randomUUID(), createdAt: 0, process: null }), { mode: 0o600 });
    await runConcurrent(t, request, data.env);
    assert.deepEqual(inventoryCounts(data.databasePath, request.sessionId), [["complete", 1], ["started", 1]], `round ${round}`);
    assert.equal(existsSync(paths.lease), false);
    assert.equal(existsSync(paths.completed), true);
  }
});

test("a completed inventory releases a supplied owned lease without rescanning", async t => {
  const data = fixture(t);
  const request: SessionInventoryRequest = { host: "codex", sessionId: "completed", cwd: data.directory };
  await runSessionInventory(request, data.env);
  const paths = slot(data, request);
  const leaseToken = randomUUID();
  writeFileSync(paths.lease, JSON.stringify({ token: leaseToken, createdAt: Date.now(), process: readProcessIdentity(process.pid) }), { mode: 0o600 });
  await runSessionInventory({ ...request, leaseToken }, data.env);
  assert.equal(existsSync(paths.lease), false);
  assert.deepEqual(inventoryCounts(data.databasePath, request.sessionId), [["complete", 1], ["started", 1]]);
});

test("a stale worker cannot release another process lease", async t => {
  const data = fixture(t);
  const request: SessionInventoryRequest = { host: "codex", sessionId: "replacement", cwd: data.directory };
  const paths = slot(data, request);
  const owner = JSON.stringify({ token: randomUUID(), createdAt: Date.now(), process: readProcessIdentity(process.pid) });
  writeFileSync(paths.lease, owner, { mode: 0o600 });
  await runSessionInventory({ ...request, leaseToken: randomUUID() }, data.env);
  assert.equal(readFileSync(paths.lease, "utf8"), owner);
  assert.equal(existsSync(paths.completed), false);
});
