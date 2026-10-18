import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProcessIdentity } from "../src/process-attribution.js";
import { discoverResourceRoots } from "../src/resource-paths.js";
import { publishResourceRoots, readRegisteredRoots } from "../src/resource-root-registry.js";
import { runSessionInventory } from "../src/resource-session.js";
import { inventoryResources } from "../src/resource-inventory.js";
import { openResourceRecorder } from "../src/resource-capture.js";
import { openHotplateStore } from "../src/store.js";
import { parseClaudeCodeHook } from "../src/integrations/claude-code.js";
import { captureFact } from "../src/capture.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-root-registry-"));
  const env = { HOME: directory, XDG_STATE_HOME: join(directory, "state"), HOTPLATE_FILESYSTEM_ID: "fixture-namespace", HOTPLATE_DB: join(directory, "capture.sqlite") };
  const registry = join(env.XDG_STATE_HOME, "hotplate", "advertised-roots");
  const roots = [join(directory, "custom-catalog")];
  for (const path of roots) mkdirSync(path);
  return { directory, env, registry, roots };
}

test("watch discovery sees live catalog roots without assigning availability to another session", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  assert.equal(publishResourceRoots({ host: "opencode-v2", sessionId: "session-a", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env: data.env }), true);
  const watcherRoots = discoverResourceRoots({ cwd: join(data.directory, "other-project"), env: data.env });
  assert.equal(watcherRoots.find((root) => root.path === data.roots[0])?.scope, "unassigned");
  assert.equal(watcherRoots.find((root) => root.path === data.roots[0])?.origin, "host");
  const sessionRoots = discoverResourceRoots({ cwd: data.directory, env: data.env, advertisedRoots: data.roots });
  assert.equal(sessionRoots.find((root) => root.path === data.roots[0])?.scope, "session");
  const registered = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env });
  assert.equal(registered[0]?.sessionId, "session-a");
  assert.equal(registered[0]?.host, "opencode-v2");
  assert.equal(registered[0]?.process?.pid, process.platform === "linux" ? process.pid : undefined);
  const file = readdirSync(data.registry)[0];
  assert.ok(file);
  assert.equal(statSync(join(data.registry, file)).mode & 0o777, 0o600);
  assert.deepEqual(readRegisteredRoots({ filesystemId: "other-namespace", env: data.env }), []);
});

test("malformed and public registrations never qualify resource roots", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  publishResourceRoots({ host: "pi", sessionId: "session", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env: data.env });
  const filename = readdirSync(data.registry)[0];
  assert.ok(filename);
  const path = join(data.registry, filename);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace(JSON.stringify(data.roots[0]), JSON.stringify("relative-root")));
  assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }), []);
  writeFileSync(path, original);
  chmodSync(path, 0o644);
  assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }), []);
  assert.equal(discoverResourceRoots({ cwd: data.directory, env: data.env }).some((root) => root.path === data.roots[0]), false);
});

test("expired roots and reused process identities are removed instead of trusted", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  publishResourceRoots({ host: "pi", sessionId: "expired", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, process: null, env: data.env });
  const filename = readdirSync(data.registry)[0];
  assert.ok(filename);
  const path = join(data.registry, filename);
  const registration = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env })[0];
  assert.ok(registration);
  writeFileSync(path, JSON.stringify({ ...registration, advertisedAt: Date.now() - 400000, expiresAt: Date.now() - 100000 }));
  assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }), []);
  assert.equal(existsSync(path), false);
  const identity = readProcessIdentity(process.pid);
  if (identity) {
    publishResourceRoots({ host: "pi", sessionId: "reused", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env: data.env });
    const liveFile = readdirSync(data.registry)[0];
    assert.ok(liveFile);
    const live = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env })[0];
    assert.ok(live);
    writeFileSync(join(data.registry, liveFile), JSON.stringify({ ...live, process: { ...identity, startTicks: `${BigInt(identity.startTicks) + 1n}` } }));
    assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }), []);
    assert.equal(existsSync(join(data.registry, liveFile)), false);
  }
});

test("session discovery publishes another project's conventional roots to account watching", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const project = join(data.directory, "project-b");
  const root = join(project, ".agents", "skills");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "reference.md"), "body");
  const watcherCwd = join(data.directory, "project-a");
  assert.equal(discoverResourceRoots({ cwd: watcherCwd, env: data.env }).some((entry) => entry.path === root), false);
  await runSessionInventory({ host: "codex", sessionId: "project-b-session", cwd: project, harnessProcess: readProcessIdentity(process.pid) }, data.env);
  const discovered = discoverResourceRoots({ cwd: watcherCwd, env: data.env }).find((entry) => entry.path === root);
  assert.equal(discovered?.origin, "conventional");
  assert.equal(discovered?.scope, "unassigned");
  assert.equal(discoverResourceRoots({ cwd: project, env: data.env }).find((entry) => entry.path === root)?.scope, "project");
});

test("cross-project discovery enables global inventory and reads without inventing scoped availability", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const projectA = join(data.directory, "project-a");
  const projectB = join(data.directory, "project-b");
  const root = join(projectB, ".agents/skills");
  const path = join(root, "reference.md");
  mkdirSync(projectA);
  mkdirSync(root, { recursive: true });
  writeFileSync(path, "private body");
  await runSessionInventory({ host: "codex", sessionId: "session-b", cwd: projectB, harnessProcess: readProcessIdentity(process.pid) }, data.env);
  const roots = discoverResourceRoots({ cwd: projectA, env: data.env });
  const recorder = openResourceRecorder({ cwd: projectA, env: data.env });
  const now = Date.now();
  const end = new Date(now + 1000).toISOString();
  try {
    await inventoryResources({ roots, record: evidence => recorder.record({ evidence }) });
    for (const at of [now, now + 1000]) await recorder.record({ observedAt: new Date(at).toISOString(), evidence: {
      kind: "observer-coverage", observerId: "watcher", mechanism: "fanotify", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID,
      rootPaths: [root], heartbeatMs: 1000, status: "active", reason: null,
    } });
  } finally { await recorder.close(); }
  const store = openHotplateStore({ databasePath: data.env.HOTPLATE_DB });
  try {
    for (const filter of [{}, { projectCwd: projectB }, { sessionId: "session-b" }]) {
      const rows = (await store.queryResources({ ...filter, toObservedAt: end })).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.presence, "present");
      assert.equal(rows[0]?.observation, "not-observed");
    }
    for (const filter of [{ projectCwd: projectA }, { sessionId: "session-a" }, { host: "claude-code" as const }, { runId: "run-a" }]) {
      assert.equal((await store.queryResources({ ...filter, toObservedAt: end })).rows.length, 0);
    }
    const facts = parseClaudeCodeHook({ hook_event_name: "PostToolUse", session_id: "session-a", cwd: projectA,
      tool_use_id: "cross-project-read", tool_name: "Read", tool_input: { file_path: path } }, new Date(now + 500).toISOString(), data.env);
    assert.equal(facts.length, 1);
    for (const fact of facts) await captureFact({ fact, env: data.env });
    const read = (await store.queryResources({ projectCwd: projectA, sessionId: "session-a", toObservedAt: end })).rows[0];
    assert.equal(read?.successfulReadCount, 1);
    assert.equal(read?.observation, "observed");
    assert.equal(read?.firstInventoriedAt, null);
  } finally { await store.close(); }
});

test("disabled capture publishes no catalog or project root state", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const env = { ...data.env, HOTPLATE_DISABLED: "true" };
  assert.equal(publishResourceRoots({ host: "pi", sessionId: "disabled", filesystemId: env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env }), false);
  await runSessionInventory({ host: "codex", sessionId: "disabled", cwd: data.directory, advertisedRoots: data.roots }, env);
  assert.equal(existsSync(data.registry), false);
  assert.equal(existsSync(data.env.HOTPLATE_DB), false);
});
