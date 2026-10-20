import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { captureFact, type CaptureFact } from "../src/capture.js";
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
  assert.equal(facts.length, 3);
  for (const fact of facts) {
    assert.ok(fact.evidence.kind === "resource-access" || fact.evidence.kind === "tool-coverage");
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
  assert.equal(parseCodexHook({ ...hook, tool_input: { command: `sed -n '1,20p' '${reference}'` } }, undefined, env).length, 2);
  for (const command of [`cat '${reference}' && true`, `cat $(echo '${reference}')`, `cat '${reference}' | head`, `cat '${reference}' > output`]) {
    assert.deepEqual(parseCodexHook({ ...hook, tool_input: { command } }, undefined, env).map((fact) => fact.evidence.kind), ["tool-coverage"]);
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

test("the native CLI merges alias operands within an operation and continues to the next file", async (t) => {
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
    assert.equal(rows.find((row) => row.resource.canonicalPath === data.reference)?.attemptCount, 1);
    assert.equal(rows.find((row) => row.resource.canonicalPath === data.principle)?.attemptCount, 1);
  } finally { await store.close(); }
  await delay(100);
});

test("every native read adapter gates legacy and resource facts with the same project scope", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const project = join(data.directory, "project");
  const cwd = join(project, "src");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(project, ".git"));
  const env = { ...data.env, HOME: join(data.directory, "home"), CODEX_HOME: join(data.directory, "codex"), HOTPLATE_RESOURCE_ROOTS: "" };
  for (const host of ["codex", "claude-code", "opencode-v1", "opencode-v2"] as const) {
    const providerDirectory = host === "codex" ? ".agents" : host === "claude-code" ? ".claude" : ".opencode";
    const root = join(project, providerDirectory, "skills");
    const skill = join(root, "example", "SKILL.md");
    const hidden = join(root, "example", ".artifacts", "guide.md");
    const outside = join(data.directory, `${host}-outside`, "SKILL.md");
    const ancestor = join(data.directory, providerDirectory, "skills", "outside-boundary", "SKILL.md");
    const excluded = [".git", ".jj", "node_modules"]
      .map((segment) => join(root, "example", segment, "nested", "SKILL.md"));
    if (host === "claude-code") excluded.push(join(root, ".trash", "retired", "SKILL.md"));
    for (const path of [skill, hidden, outside, ancestor, ...excluded]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "BODY_CANARY"); }
    const escape = join(root, "example", "escape");
    if (host !== "opencode-v2") symlinkSync(dirname(outside), escape);
    const read = (path: string): readonly CaptureFact[] => {
      const hook = { hook_event_name: "PostToolUse", session_id: "scope-session", cwd, tool_use_id: "read", tool_response: "OUTPUT_CANARY" };
      if (host === "codex") return parseCodexHook({ ...hook, tool_name: "Bash", tool_input: { command: `cat ${path}` } }, undefined, env);
      if (host === "claude-code") return parseClaudeCodeHook({ ...hook, tool_name: "Read", tool_input: { file_path: path } }, undefined, env);
      const context = { projectCwd: cwd, env };
      return host === "opencode-v1"
        ? extractOpenCodeV1Facts({ tool: "read", sessionID: "scope-session", callID: "read", args: { filePath: path } }, { output: "OUTPUT_CANARY" }, context)
        : extractOpenCodeV2Facts({ tool: "read", sessionID: "scope-session", id: "read", input: { path }, status: "completed", result: {} }, context);
    };
    assert.deepEqual(read(skill).map((fact) => fact.evidence.kind), [host === "codex" ? "read-attempt" : "read-result", "resource-access", "tool-coverage"], host);
    assert.equal(read(join(root, "missing", "SKILL.md")).length, 3, `${host} missing in-scope skill`);
    assert.deepEqual(read(hidden).map((fact) => fact.evidence.kind), ["resource-access", "tool-coverage"], `${host} hidden artifact`);
    for (const path of [outside, ancestor, ...excluded, join(escape, "SKILL.md")]) {
      assert.deepEqual(read(path).map((fact) => fact.evidence.kind), ["tool-coverage"], `${host}: ${path}`);
    }
  }
});

test("Pi admits catalog packages, fallback reads and wrappers without granting raw paths authority", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const project = join(data.directory, "project");
  const marker = join(project, ".agents", "skills", "example", "SKILL.md");
  const catalogPath = join(data.directory, "catalog-package", "SKILL.md");
  const standalone = join(data.directory, "file-catalog", "standalone.md");
  const sibling = join(dirname(standalone), "sibling.md");
  const excluded = join(dirname(marker), "node_modules", "hidden", "SKILL.md");
  const outside = join(data.directory, "source", "SKILL.md");
  const missing = join(project, ".agents", "skills", "missing", "SKILL.md");
  for (const path of [marker, catalogPath, standalone, sibling, excluded, outside]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "PRIVATE_CANARY"); }
  const escape = join(dirname(marker), "nested-link");
  symlinkSync(dirname(outside), escape);
  const env = { ...data.env, HOTPLATE_RESOURCE_ROOTS: "" };
  const collector = new HotplateCollector({ env, openStore: () => openHotplateStore({ databasePath: data.databasePath }) });
  const ctx = { cwd: project, sessionManager: { getLeafId: () => "leaf", getSessionId: () => "pi-scope", getSessionFile: () => undefined }, ui: { setStatus: () => {} } };
  await collector.sessionStart({ type: "session_start", reason: "startup" }, ctx, () => [
    { name: "skill:catalog-name", source: "skill", sourceInfo: createSyntheticSourceInfo(catalogPath, { source: "test" }) },
    { name: "skill:standalone", source: "skill", sourceInfo: createSyntheticSourceInfo(standalone, { source: "test" }) },
    { name: "skill:excluded", source: "skill", sourceInfo: createSyntheticSourceInfo(excluded, { source: "test" }) },
  ]);
  for (const [index, path] of [marker, catalogPath, standalone, missing, outside, sibling, excluded, join(escape, "SKILL.md")].entries()) {
    collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: `read-${index}`, input: { path }, content: [], details: undefined, isError: path === missing }, ctx);
    collector.messageEnd({ type: "message_end", message: { role: "user", content: `<skill name="wrapper" location="${path}">PRIVATE_CANARY</skill>`, timestamp: Date.now() } });
  }
  rmSync(catalogPath);
  collector.toolResult({ type: "tool_result", toolName: "read", toolCallId: "catalog-file-removed", input: { path: catalogPath }, content: [], details: undefined, isError: true }, ctx);
  await collector.shutdown("quit", ctx);
  const store = openHotplateStore({ databasePath: data.databasePath });
  try {
    const overview = await store.queryOverview({ sessionId: "pi-scope" });
    assert.equal(overview.catalogSkillCount, 2);
    assert.equal(overview.successfulReadCount, 3);
    assert.equal(overview.failedReadCount, 2);
    assert.equal(overview.wrapperObservedCount, 4);
    const skills = (await store.querySkillTable({ sessionId: "pi-scope" })).rows;
    assert.equal(skills.find((row) => row.skillName === "catalog-name")?.successfulReadCount, 1);
    assert.equal(skills.find((row) => row.skillName === "catalog-name")?.failedReadCount, 1);
    const resources = (await store.queryResources({ sessionId: "pi-scope" })).rows;
    assert.deepEqual(resources.map((row) => row.resource.canonicalPath).sort(), [marker, catalogPath, standalone, missing].sort());
  } finally { await store.close(); }
});

test("OpenCode v2 rejects invalid catalog paths without losing named invocation evidence", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const marker = join(data.root, "example", "SKILL.md");
  const excluded = join(data.root, "example", "node_modules", "hidden", "SKILL.md");
  for (const path of [marker, excluded]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "body"); }
  const missing = join(data.directory, "uncataloged", "SKILL.md");
  const event = { tool: "skill", sessionID: "catalog-session", id: "call", input: { id: "named" }, status: "completed", result: {} };
  for (const path of [marker, excluded, missing]) {
    const facts = extractOpenCodeV2Facts(event, { projectCwd: data.directory, env: data.env, skills: [{ id: "named", name: "named", path }] });
    assert.equal(facts.length, 1);
    const evidence = facts[0]?.evidence;
    assert.equal(evidence?.kind, "skill-invocation");
    if (evidence?.kind === "skill-invocation") {
      assert.equal(evidence.skill.name, "named");
      assert.equal(evidence.skill.canonicalPath, path === marker ? marker : null);
    }
  }
});

test("OpenCode v2 advertises a standalone catalog entrypoint without authorizing its siblings", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const entrypoint = join(data.directory, "catalog", "standalone.md");
  const sibling = join(dirname(entrypoint), "source.md");
  mkdirSync(dirname(entrypoint));
  writeFileSync(entrypoint, "body");
  writeFileSync(sibling, "body");
  const context = { projectCwd: data.directory, env: data.env, skills: [{ id: "named", name: "named", path: entrypoint }] };
  const invocation = extractOpenCodeV2Facts({ tool: "skill", sessionID: "catalog-session", id: "invoke", input: { id: "named" }, status: "completed", result: {} }, context)[0];
  assert.equal(invocation?.evidence.kind, "skill-invocation");
  if (invocation?.evidence.kind === "skill-invocation") assert.equal(invocation.evidence.skill.canonicalPath, entrypoint);
  const read = (path: string) => extractOpenCodeV2Facts({ tool: "read", sessionID: "catalog-session", id: "read", input: { path }, status: "completed", result: {} }, context);
  assert.deepEqual(read(entrypoint).map((fact) => fact.evidence.kind), ["resource-access", "tool-coverage"]);
  assert.deepEqual(read(sibling).map((fact) => fact.evidence.kind), ["tool-coverage"]);
});

test("the local OpenCode capture worker rechecks serialized file evidence and advertised package proof", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const marker = join(data.root, "example", "SKILL.md");
  const excluded = join(data.root, "example", ".git", "hidden", "SKILL.md");
  const outside = join(data.directory, "checkout", "SKILL.md");
  for (const path of [marker, excluded, outside]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "body"); }
  const unproven = join(data.directory, "without-marker");
  mkdirSync(unproven);
  writeFileSync(join(unproven, "reference.md"), "body");
  const standalone = join(data.directory, "catalog", "entry.md");
  const sibling = join(dirname(standalone), "sibling.md");
  mkdirSync(dirname(standalone));
  writeFileSync(standalone, "body");
  writeFileSync(sibling, "body");
  for (const host of ["opencode-v1", "opencode-v2"] as const) {
    const sessionId = `worker-${host}`;
    const advertisedRoots = [unproven];
    const advertisements = [{ kind: "package", path: standalone, host, sessionId }] as const;
    await runSessionInventory({ host, sessionId, cwd: data.directory, advertisedRoots, advertisements }, data.env);
    const base = { host, sessionId, actorId: sessionId, occurrenceId: "call", observedAt: "2026-10-18T00:00:00.000Z",
      scope: { projectCwd: data.directory, sessionId, sessionFile: null, segmentId: sessionId, segmentReason: "unknown", runId: null, turnId: null, leafId: null } } satisfies Omit<CaptureFact, "evidence">;
    const facts: CaptureFact[] = [marker, excluded, outside].flatMap((path, index) => [
      { ...base, occurrenceId: `legacy-${index}`, evidence: { kind: "read-result", skill: { name: "example", canonicalPath: path, version: null }, toolCallId: `legacy-${index}`, outcome: "success", model: null } },
      { ...base, occurrenceId: `resource-${index}`, evidence: { kind: "resource-access", resource: { filesystemId: "forged", canonicalPath: outside, observedPath: path, rootPath: data.directory, kind: "file", ownerSkillPath: outside }, operationId: `resource-${index}`, mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" } },
    ]);
    facts.push({ ...base, occurrenceId: "invocation", evidence: { kind: "skill-invocation", skill: { name: "named", canonicalPath: excluded, version: null }, toolCallId: "invocation", outcome: "success", model: null } });
    facts.push({ ...base, occurrenceId: "standalone-invocation", evidence: { kind: "skill-invocation", skill: { name: "standalone", canonicalPath: standalone, version: null }, toolCallId: "standalone-invocation", outcome: "success", model: null } });
    facts.push({ ...base, occurrenceId: "catalog", evidence: { kind: "catalog-snapshot", skills: [marker, excluded, outside, standalone, sibling].map((canonicalPath) => ({ name: canonicalPath === standalone ? "standalone" : "example", canonicalPath, version: null })) } });
    facts.push({ ...base, occurrenceId: "unproven", evidence: { kind: "resource-access", resource: { filesystemId: "forged", canonicalPath: join(unproven, "reference.md"), observedPath: join(unproven, "reference.md"), rootPath: unproven, kind: "reference", ownerSkillPath: null }, operationId: "unproven", mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" } });
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/integrations/command.js", import.meta.url)), "--worker", host], { env: data.env, stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? done() : reject(new Error(stderr)));
      child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: data.directory, advertised_roots: advertisedRoots, advertisements, facts }));
    });
    const store = openHotplateStore({ databasePath: data.databasePath });
    try {
      const overview = await store.queryOverview({ host, sessionId });
      assert.equal(overview.readResultCount, 1, host);
      assert.equal(overview.skillInvocationCount, 2, host);
      assert.equal(overview.catalogSkillCount, 2, host);
      const rows = (await store.queryResources({ sessionId })).rows;
      const reads = rows.filter((row) => row.successfulReadCount > 0);
      assert.equal(reads.length, 1, host);
      assert.equal(reads[0]?.resource.canonicalPath, marker);
      assert.equal(reads[0]?.resource.filesystemId, "fixture");
      assert.equal(reads[0]?.resource.rootPath, data.root);
      assert.equal((await store.querySkillTable({ sessionId })).rows.find((row) => row.skillName === "named")?.canonicalPath, null);
      assert.equal((await store.querySkillTable({ sessionId })).rows.find((row) => row.skillName === "standalone")?.canonicalPath, standalone);
      assert.equal(rows.some((row) => row.resource.canonicalPath.startsWith(unproven)), false);
      assert.equal(rows.some((row) => row.resource.canonicalPath === sibling), false);
    } finally { await store.close(); }
  }
});
