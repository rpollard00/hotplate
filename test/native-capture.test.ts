import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { captureFact, parseCaptureFact, type CaptureFact } from "../src/capture.js";
import { openHotplateStore } from "../src/store.js";

function fact(): CaptureFact {
  return {
    host: "claude-code", sessionId: "session", actorId: "actor", occurrenceId: "tool",
    observedAt: "2026-01-01T00:00:00.000Z",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "session", segmentReason: "unknown", runId: null, turnId: null, leafId: null },
    evidence: { kind: "skill-invocation", skill: { name: "test", canonicalPath: null, version: null }, toolCallId: "tool", outcome: "success", model: null },
  };
}

test("native receipts survive restart, deduplicate retries, reject conflicts and separate hosts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-native-"));
  const env = { HOTPLATE_DB: join(dir, "capture.sqlite") };
  try {
    assert.deepEqual(await captureFact({ fact: fact(), env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    assert.deepEqual(await captureFact({ fact: { ...fact(), observedAt: "2026-02-01T00:00:00.000Z" }, env }), { kind: "recorded", accepted: 0, duplicate: 1, dropped: 0 });
    assert.deepEqual(await captureFact({ fact: { ...fact(), scope: { ...fact().scope, projectCwd: "/conflict" } }, env }), { kind: "recorded", accepted: 0, duplicate: 0, dropped: 1 });
    await captureFact({ fact: { ...fact(), host: "opencode-v1" }, env });
    const store = openHotplateStore({ databasePath: env.HOTPLATE_DB });
    try {
      assert.equal((await store.queryOverview({})).observationCount, 2);
      assert.equal((await store.queryOverview({})).successfulReadCount, 0);
      assert.equal((await store.queryOverview({})).skillInvocationCount, 2);
      assert.equal((await store.querySkillTable({})).rows.length, 2);
      assert.equal((await store.queryOverview({ host: "claude-code" })).observationCount, 1);
      assert.equal((await store.queryOverview({})).firstObservedAt, fact().observedAt);
    } finally { await store.close(); }
    const db = new DatabaseSync(env.HOTPLATE_DB);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_receipts").get()?.count, 2);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native capture atomically retains one outbox payload and excludes unknown runs from activation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-native-"));
  try {
    const databasePath = join(dir, "capture.sqlite");
    const config = join(dir, "account.json");
    await writeFile(config, JSON.stringify({ databasePath, sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://collector.example", tokenFile: "./token" }));
    const env = { HOTPLATE_CONFIG: config };
    const read: CaptureFact = { ...fact(), evidence: { kind: "read-result", skill: { name: "test", canonicalPath: "/skills/test/SKILL.md", version: null }, toolCallId: "tool", outcome: "success", model: null } };
    await Promise.all(Array.from({ length: 8 }, () => captureFact({ fact: read, env })));
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observations").get()?.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get()?.count, 1);
    db.close();
    const store = openHotplateStore({ databasePath });
    try { assert.equal((await store.queryOverview({})).uniqueObservedSkillRunActivations, 0); }
    finally { await store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native boundary strips raw fields and disabled capture does not create a database", async () => {
  const clean = parseCaptureFact({ ...fact(), prompt: "PRIVATE_CANARY", scope: { ...fact().scope, output: "PRIVATE_CANARY" } });
  assert.ok(!JSON.stringify(clean).includes("PRIVATE_CANARY"));
  assert.deepEqual(await captureFact({ fact: fact(), env: { HOTPLATE_DISABLED: "1", HOTPLATE_CONFIG: "" } }), { kind: "disabled" });
  await assert.rejects(captureFact({ fact: fact(), env: { HOTPLATE_CONFIG: "" } }), /Invalid account configuration/);
});


test("independent hook processes commit one receipt and lock failure stays bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-native-process-"));
  const env = { HOTPLATE_DB: join(dir, "capture.sqlite") };
  try {
    const moduleUrl = new URL("../src/capture.js", import.meta.url).href;
    const script = `import { captureFact } from ${JSON.stringify(moduleUrl)}; await captureFact(${JSON.stringify({ fact: fact(), env })});`;
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", data => { stderr += String(data); });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    const db = new DatabaseSync(env.HOTPLATE_DB);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_receipts").get()?.count, 1);
    db.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    await assert.rejects(captureFact({ fact: { ...fact(), occurrenceId: "locked" }, env }));
    assert.ok(performance.now() - started < 2000);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_receipts").get()?.count, 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("read attempts remain separate from successful reads and activations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-attempt-"));
  const env = { HOTPLATE_DB: join(dir, "capture.sqlite") };
  try {
    const attempt: CaptureFact = { ...fact(), host: "codex", evidence: { kind: "read-attempt", skill: { name: "test", canonicalPath: "/skills/test/SKILL.md", version: null }, toolCallId: "tool", model: null } };
    await captureFact({ fact: attempt, env });
    const store = openHotplateStore({ databasePath: env.HOTPLATE_DB });
    try {
      const overview = await store.queryOverview({});
      assert.equal(overview.readAttemptCount, 1);
      assert.equal(overview.readResultCount, 0);
      assert.equal(overview.uniqueObservedSkillRunActivations, 0);
      assert.equal((await store.queryModelMatrix({})).rows.length, 0);
      assert.equal((await store.querySkillTable({})).rows[0]?.readAttemptCount, 1);
      assert.equal((await store.querySkillChain({})).runs.length, 1);
    } finally { await store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native capture rejects wire-incompatible metadata before database or outbox mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-native-bounds-"));
  const databasePath = join(dir, "capture.sqlite");
  const config = join(dir, "account.json");
  const skill = { name: "test", canonicalPath: "/skills/test/SKILL.md", version: null };
  const invalid: CaptureFact[] = [
    { ...fact(), evidence: { kind: "command-intent", skillName: "x".repeat(8193), source: "interactive" } },
    { ...fact(), evidence: { kind: "command-intent", skillName: "é".repeat(4097), source: "interactive" } },
    { ...fact(), actorId: "é".repeat(4097) },
    { ...fact(), scope: { ...fact().scope, projectCwd: "x".repeat(8193) } },
    { ...fact(), evidence: { kind: "catalog-snapshot", skills: Array.from({ length: 2001 }, () => skill) } },
  ];
  try {
    await writeFile(config, JSON.stringify({ databasePath, sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://collector.example", tokenFile: "./token" }));
    const env = { HOTPLATE_CONFIG: config };
    for (const input of invalid) {
      await assert.rejects(captureFact({ fact: input, env }));
      await assert.rejects(stat(databasePath), { code: "ENOENT" });
    }
    await captureFact({ fact: fact(), env });
    for (const input of invalid) await assert.rejects(captureFact({ fact: input, env }));
    const db = new DatabaseSync(databasePath);
    try {
      for (const table of ["observations", "native_receipts", "delivery_outbox"]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 1);
      }
    } finally { db.close(); }
    assert.doesNotThrow(() => parseCaptureFact({ ...fact(), evidence: { kind: "command-intent", skillName: "é".repeat(4096), source: "interactive" } }));
    assert.doesNotThrow(() => parseCaptureFact({ ...fact(), evidence: { kind: "catalog-snapshot", skills: Array.from({ length: 2000 }, () => skill) } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
