import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTick } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createReadTool, type MessageEndEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { CaptureWriteSummary, Observation } from "../src/domain.js";
import { captureFact, type CaptureFact } from "../src/capture.js";
import { HotplateCollector } from "../src/collector/collector.js";
import { parseObservation } from "../src/observation.js";
import { openHotplateStore } from "../src/store.js";

type Write = { facts: readonly Observation[]; summary: CaptureWriteSummary };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-pi-replay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "skills");
  const skill = join(root, "example", "SKILL.md");
  mkdirSync(join(root, "example"), { recursive: true });
  writeFileSync(skill, "# Replay fixture\n");
  const databasePath = join(directory, "capture.sqlite");
  const env = { HOME: join(directory, "home"), HOTPLATE_DB: databasePath, HOTPLATE_RESOURCE_ROOTS: root,
    HOTPLATE_PROCESS_REGISTRY: join(directory, "processes"), HOTPLATE_RESOURCE_REGISTRY: join(directory, "roots"),
    HOTPLATE_FILESYSTEM_ID: "pi-replay" };
  let instance = 0;
  const create = () => {
    instance += 1;
    const current = instance;
    const writes: Write[] = [];
    const collector = new HotplateCollector({ env, now: () => new Date(`2026-10-20T00:00:0${current}.000Z`), openStore: () => {
      const store = openHotplateStore({ databasePath });
      const record = store.record.bind(store);
      store.record = async (input, options) => {
        const summary = await record(input, options);
        writes.push({ facts: "evidence" in input ? [input] : input, summary });
        return summary;
      };
      return store;
    } });
    const context = { cwd: directory, sessionManager: { getLeafId: () => `leaf-${current}`, getSessionId: () => "same-pi-session",
      getSessionFile: () => join(directory, `session-${current}.jsonl`) }, ui: { setStatus() {} } };
    return { collector, context, writes };
  };
  return { directory, databasePath, skill, env, create };
}
function assistant(id: string, name: string): MessageEndEvent {
  return { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }],
    provider: "fixture", model: "first-model", api: "pi-messages", stopReason: "toolUse", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
}
function operation(event: Observation): string | null {
  const evidence = event.evidence;
  if (evidence.kind === "resource-access" || evidence.kind === "tool-coverage") return evidence.operationId;
  if (evidence.kind === "read-result") return evidence.toolCallId;
  return null;
}
function storedResources(databasePath: string): Map<string, string> {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return new Map(db.prepare("SELECT observation_id,payload FROM resource_events WHERE observation_id LIKE 'native:tool:%'").all()
      .map(row => [String(row.observation_id), String(row.payload)]));
  } finally { db.close(); }
}

for (const kind of ["opaque", "read"] as const) {
  test(`Pi ${kind} callbacks replay after collector recreation without dropping a fresh operation in the same batch`, async t => {
    const data = fixture(t);
    const callback: ToolResultEvent = kind === "read"
      ? { type: "tool_result", toolName: "read", toolCallId: "replayed", input: { path: data.skill, offset: 1, limit: 2 }, content: [], details: undefined, isError: false }
      : { type: "tool_result", toolName: "bash", toolCallId: "replayed", input: { command: "python3 opaque.py" }, content: [], details: undefined, isError: false };
    const first = data.create();
    await first.collector.sessionStart({ type: "session_start", reason: "startup" }, first.context, () => []);
    await nextTick();
    first.collector.beforeAgentStart("read", first.context);
    first.collector.messageEnd(assistant("replayed", callback.toolName));
    first.collector.toolResult(callback, first.context);
    await first.collector.shutdown("reload", first.context);
    const original = storedResources(data.databasePath);
    assert.equal(original.size, kind === "read" ? 2 : 1);
    const second = data.create();
    await second.collector.sessionStart({ type: "session_start", reason: "reload" }, second.context, () => []);
    await nextTick();
    second.collector.beforeAgentStart("replay", second.context);
    second.collector.toolResult(callback, second.context);
    second.collector.toolResult({ ...callback, toolCallId: "fresh" }, second.context);
    await second.collector.shutdown("quit", second.context);
    const mixed = second.writes.find(write => write.facts.some(fact => operation(fact) === "replayed") && write.facts.some(fact => operation(fact) === "fresh"));
    assert.ok(mixed);
    assert.deepEqual(mixed.summary, { accepted: kind === "read" ? 3 : 1, duplicate: kind === "read" ? 3 : 1, dropped: 0 });
    assert.ok(second.writes.every(write => write.summary.dropped === 0));
    const replay = mixed.facts.find(fact => operation(fact) === "replayed");
    assert.ok(replay);
    const firstReplay = first.writes.flatMap(write => write.facts).find(fact => fact.id === replay.id);
    assert.ok(firstReplay);
    assert.notEqual(replay.scope.segmentId, firstReplay.scope.segmentId);
    assert.notEqual(replay.scope.runId, firstReplay.scope.runId);
    assert.notEqual(replay.scope.sessionFile, firstReplay.scope.sessionFile);
    assert.ok("model" in replay.evidence && replay.evidence.model === null);
    assert.ok("model" in firstReplay.evidence && firstReplay.evidence.model?.id === "first-model");
    const after = storedResources(data.databasePath);
    assert.equal(after.size, original.size * 2);
    for (const [id, payload] of original) assert.equal(after.get(id), payload);
    const store = openHotplateStore({ databasePath: data.databasePath });
    try { assert.equal((await store.queryCaptureHealth({})).captureGapCount, 0); }
    finally { await store.close(); }
  });
}

test("Pi receipt comparison ignores process attribution but still rejects changed outcomes, targets and portions", async t => {
  const data = fixture(t);
  const first = data.create();
  await first.collector.sessionStart({ type: "session_start", reason: "startup" }, first.context, () => []);
  first.collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: "semantic", input: { path: data.skill, offset: 1, limit: 2 }, content: [], details: undefined, isError: false }, first.context);
  await first.collector.shutdown("quit", first.context);
  const stored = [...storedResources(data.databasePath).values()].map(payload => parseObservation(JSON.parse(payload)));
  const read = stored.find(event => event.evidence.kind === "resource-access");
  assert.ok(read?.evidence.kind === "resource-access" && read.evidence.mechanism === "host-tool" && read.evidence.access === "read" && read.evidence.toolRead);
  const store = openHotplateStore({ databasePath: data.databasePath });
  try {
    assert.deepEqual(await store.record({ ...read, evidence: { ...read.evidence, process: { bootId: "restarted", pid: 12345, startTicks: "99" }, model: { provider: "fixture", id: "later-model" } } }), { accepted: 0, duplicate: 1, dropped: 0 });
    for (const changed of [
      { ...read, evidence: { ...read.evidence, outcome: "error" } },
      { ...read, evidence: { ...read.evidence, resource: { ...read.evidence.resource, canonicalPath: join(data.directory, "different.md") } } },
      { ...read, evidence: { ...read.evidence, toolRead: { ...read.evidence.toolRead, requested: { kind: "lines", start: 4, count: 2 } } } },
    ] satisfies Observation[]) assert.deepEqual(await store.record(changed), { accepted: 0, duplicate: 0, dropped: 1 });
  } finally { await store.close(); }
  const native: CaptureFact = { host: "claude-code", sessionId: "same-pi-session", actorId: "actor", occurrenceId: "semantic", observedAt: read.observedAt, scope: read.scope, evidence: read.evidence };
  assert.deepEqual(await captureFact({ fact: native, env: data.env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
  assert.deepEqual(await captureFact({ fact: { ...native, scope: { ...native.scope, segmentId: "different-native-segment" } }, env: data.env }), { kind: "recorded", accepted: 0, duplicate: 0, dropped: 1 });
});

test("actual Pi reads with at prefixes and Unicode spaces reach collector resource evidence", async t => {
  const data = fixture(t);
  const reference = join(data.directory, "skills", "example", "guide with spaces.md");
  writeFileSync(reference, "Pi normalized reference\n");
  const running = data.create();
  await running.collector.sessionStart({ type: "session_start", reason: "startup" }, running.context, () => []);
  const read = createReadTool(data.directory);
  for (const [id, inputPath, canonicalPath] of [
    ["at-prefix", `@${data.skill}`, data.skill],
    ["unicode-spaces", `@${reference.replaceAll(" ", "\u00a0")}`, reference],
  ] as const) {
    const input = { path: inputPath };
    const result = await read.execute(id, input);
    assert.ok(result.content.some(block => block.type === "text" && block.text.includes(id === "at-prefix" ? "Replay fixture" : "Pi normalized reference")));
    running.collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: id, input,
      content: result.content, details: result.details, isError: false }, running.context);
    await nextTick();
    const fact = running.writes.flatMap(write => write.facts).find(event => event.evidence.kind === "resource-access" && event.evidence.operationId === id);
    assert.ok(fact?.evidence.kind === "resource-access");
    assert.equal(fact.evidence.resource.canonicalPath, canonicalPath);
    assert.equal(fact.evidence.outcome, "success");
  }
  await running.collector.shutdown("quit", running.context);
  const store = openHotplateStore({ databasePath: data.databasePath });
  try {
    assert.equal((await store.queryResources({})).rows.filter(row => row.successfulReadCount === 1).length, 2);
    assert.equal((await store.queryCaptureHealth({})).captureGapCount, 0);
  } finally { await store.close(); }
});
