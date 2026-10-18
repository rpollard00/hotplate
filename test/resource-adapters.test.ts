import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureFact } from "../src/capture.js";
import { HotplateCollector } from "../src/collector/collector.js";
import { parseClaudeCodeHook } from "../src/integrations/claude-code.js";
import { parseCodexHook } from "../src/integrations/codex.js";
import { extractOpenCodeV1Facts } from "../src/integrations/opencode/v1.js";
import { extractOpenCodeV2Facts } from "../src/integrations/opencode/v2.js";
import { runSessionInventory } from "../src/resource-session.js";
import { openHotplateStore } from "../src/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-adapters-"));
  const root = join(directory, "content");
  const reference = join(root, "references", "guide with spaces.md");
  const principle = join(root, "principle.md");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, "PRIVATE_CONTENT_CANARY");
  writeFileSync(principle, "PRIVATE_CONTENT_CANARY");
  const databasePath = join(directory, "capture.sqlite");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), HOTPLATE_DB: databasePath, HOTPLATE_RESOURCE_ROOTS: root,
    HOTPLATE_PROCESS_REGISTRY: join(directory, "registry"), HOTPLATE_FILESYSTEM_ID: "fixture", HOTPLATE_DISABLED: "0" };
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_RESOURCES_CONFIG;
  return { directory, root, reference, principle, databasePath, env };
}

test("Codex literal multi-file reads create separate retry-safe resource attempts", async (t) => {
  const fixtureData = fixture();
  t.after(() => rmSync(fixtureData.directory, { recursive: true, force: true }));
  const { directory, reference, principle, env } = fixtureData;
  const hook = { hook_event_name: "PostToolUse", session_id: "session", cwd: directory, tool_use_id: "operation", tool_name: "Bash", tool_response: "OUTPUT_CANARY" };
  const facts = parseCodexHook({ ...hook, tool_input: { command: `cat '${reference}' '${principle}'` } }, "2026-10-18T00:00:00.000Z", env);
  assert.equal(facts.length, 2);
  for (const fact of facts) {
    assert.equal(fact.evidence.kind, "resource-access");
    assert.deepEqual(await captureFact({ fact, env }), { kind: "recorded", accepted: 1, duplicate: 0, dropped: 0 });
    assert.deepEqual(await captureFact({ fact, env }), { kind: "recorded", accepted: 0, duplicate: 1, dropped: 0 });
  }
  const store = openHotplateStore({ databasePath: fixtureData.databasePath });
  try {
    const rows = (await store.queryResources({})).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.attemptCount === 1 && row.successfulReadCount === 0));
  } finally { await store.close(); }
  assert.equal(JSON.stringify(facts).includes("CANARY"), false);
  assert.equal(parseCodexHook({ ...hook, tool_input: { command: `sed -n '1,20p' '${reference}'` } }, undefined, env).length, 1);
  for (const command of [`cat '${reference}' && true`, `cat $(echo '${reference}')`, `cat '${reference}' | head`, `cat '${reference}' > output`]) {
    assert.deepEqual(parseCodexHook({ ...hook, tool_input: { command } }, undefined, env), []);
  }
});

test("Claude and OpenCode capture references and failures with explicit or unknown sessions", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const hook = { hook_event_name: "PostToolUseFailure", cwd: data.directory, tool_use_id: "call", tool_name: "Read", tool_input: { file_path: data.reference } };
  const unknown = parseClaudeCodeHook(hook, undefined, data.env)[0];
  assert.equal(unknown?.sessionId, null);
  assert.equal(unknown?.evidence.kind, "resource-access");
  if (unknown?.evidence.kind === "resource-access") {
    assert.equal(unknown.evidence.attribution, "harness");
    assert.equal(unknown.evidence.outcome, "error");
  }
  const context = { projectCwd: data.directory, env: data.env };
  const first = extractOpenCodeV1Facts({ tool: "read", sessionID: "session", callID: "call", args: { filePath: data.reference } }, { output: "OUTPUT_CANARY" }, context);
  const second = extractOpenCodeV2Facts({ tool: "read", sessionID: "session", id: "call", input: { path: data.reference }, status: "error", error: {} }, context);
  assert.equal(first[0]?.evidence.kind, "resource-access");
  assert.equal(second[0]?.evidence.kind, "resource-access");
  assert.equal(JSON.stringify([first, second]).includes("CANARY"), false);
});

test("Pi startup inventories resources and records non-SKILL reads in the session", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const store = openHotplateStore({ databasePath: data.databasePath });
  const collector = new HotplateCollector({ env: data.env, openStore: () => store });
  const ctx = { cwd: data.directory, sessionManager: { getLeafId: () => "leaf", getSessionId: () => "pi-session", getSessionFile: () => undefined }, ui: { setStatus: () => {} } };
  await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => []);
  collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: "read-reference", input: { path: data.reference }, content: [], details: undefined, isError: false }, ctx);
  await collector.shutdown("quit", ctx);
  const open = openHotplateStore({ databasePath: data.databasePath });
  try {
    const rows = (await open.queryResources({ sessionId: "pi-session" })).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.resource.canonicalPath === data.reference)?.successfulReadCount, 1);
    assert.ok(rows.every((row) => row.lastInventoriedAt !== null));
    assert.equal((await open.queryOverview({})).readResultCount, 0);
  } finally { await open.close(); }
});

test("native hooks launch one durable session inventory across a concurrent tool burst", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const payload = { hook_event_name: "PostToolUse", session_id: "session", cwd: data.directory, tool_use_id: "call", tool_name: "Bash", tool_input: { command: "true" } };
  const invoke = () => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "capture", "claude-code"], { env: data.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 && !stderr.includes("unavailable") ? done() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(payload));
  });
  await Promise.all([invoke(), invoke(), invoke(), invoke()]);
  const completed = (): number => {
    try {
      const db = new DatabaseSync(data.databasePath, { readOnly: true });
      try { return Number(db.prepare("SELECT count(*) AS count FROM resource_events WHERE json_extract(payload, '$.evidence.phase') = 'complete'").get()?.count); }
      finally { db.close(); }
    } catch { return 0; }
  };
  const deadline = Date.now() + 5000;
  while (completed() === 0 && Date.now() < deadline) await delay(25);
  assert.equal(completed(), 1);
  await invoke();
  await delay(100);
  assert.equal(completed(), 1);
});

test("incomplete session inventory remains retryable after a missing root appears", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const missing = join(data.directory, "later");
  const env = { ...data.env, HOTPLATE_RESOURCE_ROOTS: missing };
  const request = { host: "codex", sessionId: "retry-session", cwd: data.directory } as const;
  await runSessionInventory(request, env);
  mkdirSync(missing);
  writeFileSync(join(missing, "reference.md"), "body");
  await runSessionInventory(request, env);
  await runSessionInventory(request, env);
  const db = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM resource_events WHERE json_extract(payload, '$.evidence.phase') = 'incomplete'").get()?.count, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM resource_events WHERE json_extract(payload, '$.evidence.phase') = 'complete'").get()?.count, 1);
  } finally { db.close(); }
});

test("OpenCode v2 advertised custom skill roots qualify references and inventory session scope", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const custom = join(data.directory, "custom-skills", "example");
  const marker = join(custom, "SKILL.md");
  const reference = join(custom, "references", "guide.md");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(marker, "body");
  writeFileSync(reference, "body");
  const facts = extractOpenCodeV2Facts({ tool: "read", sessionID: "catalog-session", id: "call", input: { path: reference }, status: "completed", result: {} }, {
    projectCwd: data.directory, env: data.env, skills: [{ id: "example", name: "example", path: marker }],
  });
  assert.equal(facts[0]?.evidence.kind, "resource-access");
  if (facts[0]?.evidence.kind === "resource-access") assert.equal(facts[0].evidence.resource.canonicalPath, reference);
  await runSessionInventory({ host: "opencode-v2", sessionId: "catalog-session", cwd: data.directory, advertisedRoots: [custom] }, data.env);
  const db = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    const advertised = db.prepare("SELECT count(*) AS count FROM resource_events WHERE json_extract(payload, '$.evidence.phase') = 'complete' AND json_extract(payload, '$.evidence.origin') = 'host' AND json_extract(payload, '$.evidence.scope') = 'session'").get()?.count;
    assert.equal(advertised, 1);
  } finally { db.close(); }
});

test("the native CLI retains physical and alias read operands and continues to the next file", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const alias = join(data.root, "reference-alias.md");
  symlinkSync(data.reference, alias);
  const payload = { hook_event_name: "PostToolUse", session_id: "alias-session", cwd: data.directory, tool_use_id: "alias-operation",
    tool_name: "Bash", tool_response: "PRIVATE_BODY_CANARY", tool_input: { command: `cat '${data.reference}' '${alias}' '${data.principle}'` } };
  const invoke = () => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "capture", "codex"], { env: data.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 && !stderr.includes("unavailable") ? done() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(payload));
  });
  await invoke();
  await invoke();
  const store = openHotplateStore({ databasePath: data.databasePath });
  try {
    const rows = (await store.queryResources({ sessionId: "alias-session" })).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.resource.canonicalPath === data.reference)?.attemptCount, 2);
    assert.equal(rows.find((row) => row.resource.canonicalPath === data.principle)?.attemptCount, 1);
  } finally { await store.close(); }
  await delay(100);
});
