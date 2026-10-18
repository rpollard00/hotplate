import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HotplateCollector } from "../src/collector/collector.js";
import { skillFromReadPath, skillWrappersFromPrompt } from "../src/collector/skills.js";
import { openHotplateReadStore, openHotplateStore } from "../src/store.js";

async function fixture(run: (path: string, ctx: ReturnType<typeof context>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-lifecycle-"));
  try { await run(join(dir, "data.sqlite"), context(dir)); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function context(cwd: string) {
  const statuses: string[] = [];
  return {
    cwd, statuses,
    sessionManager: { getLeafId: () => "leaf", getSessionId: () => "session", getSessionFile: () => undefined },
    ui: { setStatus: (_key: string, text: string | undefined) => { if (text) statuses.push(text); } },
  };
}
async function overview(path: string) {
  const open = openHotplateReadStore({ databasePath: path });
  assert.equal(open.kind, "ready");
  if (open.kind !== "ready") throw new Error("Missing fixture database");
  try { return await open.store.queryOverview({}); } finally { await open.store.close(); }
}
function input(collector: HotplateCollector, ctx: ReturnType<typeof context>) {
  collector.input({ type: "input", text: "/skill:alpha", source: "interactive" }, ctx);
}

test("overflow preserves the full loss count through shutdown", async () => {
  await fixture(async (path, ctx) => {
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => openHotplateStore({ databasePath: path }) });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    for (let i = 0; i < 3_500; i++) input(collector, ctx);
    await collector.shutdown("quit", ctx);
    const result = await overview(path);
    assert.equal(result.commandIntentCount, 999);
    assert.equal(result.droppedObservationCount, 2_501);
    assert.ok(ctx.statuses.some(text => text.includes("incomplete")));
  });
});

test("an input at flush finalization drains before shutdown", async () => {
  await fixture(async (path, ctx) => {
    const store = openHotplateStore({ databasePath: path });
    const record = store.record.bind(store);
    let scheduled = false;
    let closed: Promise<void> | undefined;
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => store });
    store.record = (observations, options) => {
      const result = record(observations, options);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => queueMicrotask(() => {
          input(collector, ctx);
          closed = collector.shutdown("quit", ctx);
        }));
      }
      return result;
    };
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    await nextTick();
    assert.ok(closed);
    await closed;
    assert.equal((await overview(path)).commandIntentCount, 1);
  });
});

test("shutdown awaits the active SQLite retry before closing", async () => {
  await fixture(async (path, ctx) => {
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => openHotplateStore({ databasePath: path }) });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    const lock = new DatabaseSync(path);
    lock.exec("BEGIN IMMEDIATE");
    input(collector, ctx);
    await nextTick();
    const release = setTimeout(() => { lock.exec("ROLLBACK"); lock.close(); }, 35);
    try {
      await collector.shutdown("quit", ctx);
      await collector.shutdown("quit", ctx);
      assert.equal((await overview(path)).commandIntentCount, 1);
    } finally { clearTimeout(release); if (lock.isOpen) { lock.exec("ROLLBACK"); lock.close(); } }
  });
});

test("default lock contention is bounded and gaps survive a later session", async t => {
  await fixture(async (path, ctx) => {
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => openHotplateStore({ databasePath: path }) });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    const lock = new DatabaseSync(path);
    lock.exec("BEGIN IMMEDIATE");
    input(collector, ctx);
    const started = performance.now();
    await collector.shutdown("quit", ctx);
    const elapsed = performance.now() - started;
    lock.exec("ROLLBACK"); lock.close();
    t.diagnostic(`Default busy timeout/retries drained in ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 700);
    await collector.sessionStart({ type: "session_start", reason: "reload" }, ctx, () => []);
    await collector.shutdown("quit", ctx);
    assert.equal((await overview(path)).droppedObservationCount, 2);
  });
});

test("store writes honor cancellation between lock retries", async () => {
  await fixture(async (path) => {
    const store = openHotplateStore({ databasePath: path });
    const controller = new AbortController();
    const lock = new DatabaseSync(path);
    lock.exec("BEGIN IMMEDIATE");
    try {
      const pending = store.record({ id: "cancelled", producerId: "test", sequence: 1, observedAt: new Date().toISOString(),
        scope: { projectCwd: "/test", sessionId: null, sessionFile: null, segmentId: "a", segmentReason: "startup", runId: null, turnId: null, leafId: null },
        evidence: { kind: "command-intent", skillName: "alpha", source: "interactive" } }, { signal: controller.signal });
      controller.abort();
      const result = await pending;
      assert.deepEqual(result, { accepted: 0, duplicate: 0, dropped: 1 });
    } finally { lock.exec("ROLLBACK"); lock.close(); await store.close(); }
  });
});

test("database startup failure is visible and never escapes a pi handler", async () => {
  await fixture(async (path, ctx) => {
    let unavailable = true;
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => {
      if (unavailable) throw new Error("private database failure detail");
      return openHotplateStore({ databasePath: path });
    } });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    input(collector, ctx);
    assert.ok(ctx.statuses.some(text => text.includes("incomplete")));
    assert.ok(ctx.statuses.every(text => !text.includes("private")));
    unavailable = false;
    await collector.sessionStart({ type: "session_start", reason: "reload" }, ctx, () => []);
    await collector.shutdown("quit", ctx);
    assert.equal((await overview(path)).droppedObservationCount, 2);
  });
});

test("run, branch and session boundaries do not attach later intent to a previous run", async () => {
  await fixture(async (path, ctx) => {
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => openHotplateStore({ databasePath: path }) });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    collector.beforeAgentStart("start", ctx);
    collector.messageEnd({ type: "message_end", message: { role: "user", content: '<skill name="alpha" location="/skills/alpha/SKILL.md">\nx\n</skill>', timestamp: Date.now() } });
    collector.agentEnd();
    input(collector, ctx);
    collector.sessionTree({ type: "session_tree", oldLeafId: "leaf", newLeafId: "other" }, ctx);
    input(collector, ctx);
    await collector.sessionStart({ type: "session_start", reason: "fork" }, ctx, () => []);
    input(collector, ctx);
    await collector.shutdown("quit", ctx);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT run_id, segment_id FROM observations WHERE evidence_kind = 'command-intent'").all();
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => row.run_id === null));
      assert.equal(new Set(rows.map(row => row.segment_id)).size, 3);
    } finally { db.close(); }
  });
});

test("model attribution follows each assistant call and repeated reads stay separate", async () => {
  await fixture(async (path, ctx) => {
    const collector = new HotplateCollector({ env: { HOME: ctx.cwd }, openStore: () => openHotplateStore({ databasePath: path }) });
    await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
    collector.beforeAgentStart("run", ctx);
    for (const index of [0, 1]) {
      collector.turnStart({ type: "turn_start", turnIndex: index, timestamp: Date.now() }, ctx);
      collector.messageEnd({ type: "message_end", message: {
        role: "assistant", api: "test", provider: "local", model: `requested-${index}`, responseModel: `actual-${index}`,
        content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "/skills/alpha/SKILL.md" } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      } });
      collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: `call-${index}`, input: { path: "/skills/alpha/SKILL.md" }, content: [], details: undefined, isError: false }, ctx);
    }
    await collector.shutdown("quit", ctx);
    const open = openHotplateReadStore({ databasePath: path });
    assert.equal(open.kind, "ready");
    if (open.kind !== "ready") return;
    try {
      const result = await open.store.queryOverview({});
      assert.equal(result.successfulReadCount, 2);
      assert.equal(result.uniqueObservedSkillRunActivations, 1);
      assert.deepEqual((await open.store.queryModelMatrix({})).rows.map(row => row.model?.id).sort(), ["actual-0", "actual-1"]);
    } finally { await open.store.close(); }
  });
});

test("skill identity expands pi path prefixes without hashing arbitrary wrapper files", async () => {
  const catalog = { byPath: new Map(), skills: [] };
  assert.equal(skillFromReadPath("@~/.agents/skills/alpha/SKILL.md", "/project", catalog)?.canonicalPath, join(homedir(), ".agents/skills/alpha/SKILL.md"));
  await fixture(async (path) => {
    await writeFile(path, "private unrelated content");
    const wrapper = skillWrappersFromPrompt(`<skill name="x" location="${path}">\nx\n</skill>`);
    assert.equal(wrapper[0]?.version, null);
  });
});

test("the CLI works through a symlink", async () => {
  await fixture(async (path) => {
    const executable = `${path}.cli`;
    await symlink(fileURLToPath(new URL("../src/cli.js", import.meta.url)), executable);
    const result = await promisify(execFile)(process.execPath, [executable, "--help"]);
    assert.match(result.stdout, /Hotplate dashboard/);
  });
});
