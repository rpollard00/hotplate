import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProcessIdentity, readProcessIdentity, resolveProcessAttribution } from "../src/process-attribution.js";
import { discoverResourceRoots, qualifyResource, saveResourceRoots } from "../src/resource-paths.js";
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
  const registry = join(directory, ".local", "state", "hotplate", "advertised-roots");
  const roots = [join(directory, "custom-catalog")];
  for (const path of roots) { mkdirSync(path); writeFileSync(join(path, "SKILL.md"), "fixture"); }
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

test("registry reads ignore stale records without mutation and explicit pruning removes them", (t) => {
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
  assert.equal(existsSync(path), true);
  readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env, pruneExpired: true });
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
    assert.equal(existsSync(join(data.registry, liveFile)), true);
    readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env, pruneExpired: true });
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
  assert.equal(discoverResourceRoots({ cwd: project, env: data.env, project: { host: "codex", boundary: { kind: "infer" } } }).find((entry) => entry.path === root)?.scope, "project");
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
    assert.deepEqual(facts.map(fact => fact.evidence.kind), ["resource-access", "tool-coverage"]);
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

test("an isolated OpenCode v1 environment shares account roots and process identity with the watcher", { skip: process.platform !== "linux", timeout: 10000 }, async (t) => {
  const data = fixture();
  const watcherEnv = { ...data.env, XDG_CONFIG_HOME: join(data.directory, "account-config") };
  const configuredRoot = join(data.directory, "configured-skills");
  mkdirSync(configuredRoot);
  saveResourceRoots([configuredRoot], watcherEnv);
  const publisherEnv = { ...watcherEnv, XDG_CONFIG_HOME: join(data.directory, "opencode-v1-config"), XDG_STATE_HOME: join(data.directory, "opencode-v1-state") };
  const script = `import { registerHarnessProcess, readProcessIdentity } from ${JSON.stringify(new URL("../src/process-attribution.js", import.meta.url).href)};
    import { readResourceConfiguration } from ${JSON.stringify(new URL("../src/resource-paths.js", import.meta.url).href)};
    import { publishResourceRoots } from ${JSON.stringify(new URL("../src/resource-root-registry.js", import.meta.url).href)};
    import { integrationSettingsPath } from ${JSON.stringify(new URL("../src/integrations/native-settings.js", import.meta.url).href)};
    const identity = readProcessIdentity(process.pid);
    const registration = registerHarnessProcess({ host: "opencode-v1", binding: { kind: "shared" }, source: "in-process" });
    const published = publishResourceRoots({ host: "opencode-v1", sessionId: "v1-session", filesystemId: process.env.HOTPLATE_FILESYSTEM_ID, roots: JSON.parse(process.argv[1]) });
    process.stdout.write(JSON.stringify({ identity, registration, published, configuration: readResourceConfiguration(), settings: integrationSettingsPath() }) + "\\n");
    process.stdin.resume();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(data.roots)], { env: publisherEnv, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; rmSync(data.directory, { recursive: true, force: true }); });
  const output = await once(child.stdout, "data");
  const result: unknown = JSON.parse(String(output[0]));
  assert.ok(result && typeof result === "object" && "identity" in result && "registration" in result && "published" in result && "configuration" in result && "settings" in result);
  assert.equal(result.published, true);
  assert.ok(result.registration);
  const identity = parseProcessIdentity(result.identity);
  assert.ok(identity);
  assert.deepEqual(result.configuration, { path: join(data.directory, ".config", "hotplate", "resources.json"), roots: [configuredRoot] });
  assert.equal(result.settings, join(data.directory, ".config", "hotplate", "integrations.json"));
  const advertisements = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: watcherEnv });
  assert.equal(advertisements[0]?.host, "opencode-v1");
  assert.deepEqual(advertisements[0]?.process, identity);
  assert.deepEqual(advertisements[0]?.roots, data.roots);
  assert.deepEqual(resolveProcessAttribution(identity, { env: watcherEnv }), { kind: "harness", host: "opencode-v1", sessionId: null, actorId: null, projectCwd: null });
  const discovered = discoverResourceRoots({ cwd: data.directory, env: watcherEnv });
  assert.equal(discovered.find(root => root.path === configuredRoot)?.origin, "configured");
  assert.equal(discovered.find(root => root.path === data.roots[0])?.origin, "host");
  assert.equal(existsSync(join(publisherEnv.XDG_STATE_HOME, "hotplate")), false);
  assert.equal(existsSync(join(publisherEnv.XDG_CONFIG_HOME, "hotplate")), false);
});

test("an explicit advertised-root registry remains isolated across harness environments", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const isolated = { ...data.env, HOTPLATE_RESOURCE_REGISTRY: join(data.directory, "isolated-registry") };
  assert.equal(publishResourceRoots({ host: "opencode-v1", sessionId: "isolated", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env: isolated }), true);
  assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }), []);
  assert.equal(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: { ...isolated, XDG_STATE_HOME: join(data.directory, "another-xdg") } }).length, 1);
  assert.equal(statSync(isolated.HOTPLATE_RESOURCE_REGISTRY).mode & 0o777, 0o700);
  for (const override of ["", "relative-registry"]) {
    const env = { ...data.env, HOTPLATE_RESOURCE_REGISTRY: override };
    assert.equal(publishResourceRoots({ host: "opencode-v1", sessionId: "invalid", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, env }), false);
    assert.deepEqual(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env }), []);
  }
});

test("native inventory advertises harness-specific account roots without renewing imported roots", async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const project = join(data.directory, "v1-project");
  const projectRoot = join(project, ".opencode", "skills");
  const watcherProject = join(data.directory, "watcher-project");
  const accountRoot = join(data.directory, "opencode-v1-config", "opencode", "skills");
  const importedRoot = join(data.directory, "another-project", ".agents", "skills");
  for (const root of [projectRoot, accountRoot, importedRoot]) {
    mkdirSync(join(root, "example"), { recursive: true });
    writeFileSync(join(root, "example", "SKILL.md"), "fixture");
  }
  mkdirSync(watcherProject);
  assert.equal(publishResourceRoots({ host: "codex", sessionId: "other-session", origin: "conventional",
    filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: [importedRoot], env: data.env }), true);
  const publisherEnv = { ...data.env, XDG_CONFIG_HOME: join(data.directory, "opencode-v1-config"), XDG_STATE_HOME: join(data.directory, "opencode-v1-state") };
  await runSessionInventory({ host: "opencode-v1", sessionId: "v1-session", cwd: project, harnessProcess: readProcessIdentity(process.pid) }, publisherEnv);
  const advertisement = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env })
    .find(entry => entry.host === "opencode-v1" && entry.origin === "conventional");
  assert.deepEqual(advertisement?.roots, [accountRoot, projectRoot].sort());
  const discovered = discoverResourceRoots({ cwd: watcherProject, env: data.env });
  for (const path of [accountRoot, projectRoot]) {
    const root = discovered.find(entry => entry.path === path);
    assert.equal(root?.origin, "conventional");
    assert.equal(root?.scope, "unassigned");
  }
});

test("version two registrations retain project authority and reject retargeted installation anchors", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const project = join(data.directory, "project");
  const collection = join(project, ".agents/skills");
  const target = join(data.directory, "target");
  const replacement = join(data.directory, "replacement");
  for (const path of [collection, target, replacement]) mkdirSync(path, { recursive: true });
  writeFileSync(join(target, "reference.md"), "body");
  symlinkSync(target, join(collection, "installed"));
  const selected = discoverResourceRoots({ cwd: project, env: data.env, project: { host: "codex", boundary: { kind: "reported", path: project } } })
    .filter(root => root.scope === "project");
  assert.equal(selected.length, 2);
  assert.equal(publishResourceRoots({ host: "codex", sessionId: "project", origin: "conventional", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID,
    roots: selected.map(root => root.path), rootDescriptors: selected, env: data.env }), true);
  const registration = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env })[0];
  assert.equal(registration?.version, 2);
  const watched = discoverResourceRoots({ cwd: data.directory, env: data.env });
  assert.ok(qualifyResource({ path: join(target, "reference.md"), cwd: data.directory, roots: watched }));
  assert.ok(watched.every(root => root.scope === "unassigned"));
  rmSync(join(collection, "installed"));
  symlinkSync(replacement, join(collection, "installed"));
  const changed = discoverResourceRoots({ cwd: data.directory, env: data.env });
  assert.equal(qualifyResource({ path: join(target, "reference.md"), cwd: data.directory, roots: changed }), null);
});

test("legacy records cannot promote checkouts or ownerless host declarations to resource scope", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const checkout = join(data.directory, "checkout");
  const ownerless = join(data.directory, "ownerless");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(ownerless);
  publishResourceRoots({ host: "codex", sessionId: "old-host", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: [checkout, ownerless], env: data.env });
  publishResourceRoots({ host: "codex", sessionId: "old-convention", origin: "conventional", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: [checkout], env: data.env });
  assert.deepEqual(discoverResourceRoots({ cwd: data.directory, env: data.env }), []);
  const selected = discoverResourceRoots({ cwd: data.directory, env: data.env, advertisements: [{ kind: "collection", path: ownerless, host: "codex", sessionId: "explicit", source: "host-configuration" }] });
  assert.equal(publishResourceRoots({ host: "codex", sessionId: "explicit", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID,
    roots: selected.map(root => root.path), rootDescriptors: selected, env: data.env }), true);
  assert.equal(discoverResourceRoots({ cwd: data.directory, env: data.env }).find(root => root.path === ownerless)?.scope, "unassigned");
});

test("publication prunes expired records while discovery leaves the registry unchanged", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  publishResourceRoots({ host: "codex", sessionId: "stale", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, process: null, env: data.env });
  const filename = readdirSync(data.registry)[0];
  assert.ok(filename);
  const path = join(data.registry, filename);
  const registration = readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env })[0];
  assert.ok(registration);
  writeFileSync(path, JSON.stringify({ ...registration, advertisedAt: Date.now() - 400000, expiresAt: Date.now() - 100000 }));
  const before = readFileSync(path, "utf8");
  discoverResourceRoots({ cwd: data.directory, env: data.env });
  assert.equal(readFileSync(path, "utf8"), before);
  publishResourceRoots({ host: "codex", sessionId: "current", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, roots: data.roots, process: null, env: data.env });
  assert.equal(existsSync(path), false);
  assert.equal(readRegisteredRoots({ filesystemId: data.env.HOTPLATE_FILESYSTEM_ID, env: data.env }).length, 1);
});

test("registered package proof is revalidated when its marker disappears", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const path = data.roots[0];
  assert.ok(path);
  const selected = discoverResourceRoots({ cwd: data.directory, env: data.env, advertisements: [{ kind: "package", path, host: "opencode-v2", sessionId: "catalog" }] });
  assert.equal(publishResourceRoots({ host: "opencode-v2", sessionId: "catalog", filesystemId: data.env.HOTPLATE_FILESYSTEM_ID,
    roots: selected.map(root => root.path), rootDescriptors: selected, env: data.env }), true);
  rmSync(join(path, "SKILL.md"));
  assert.deepEqual(discoverResourceRoots({ cwd: data.directory, env: data.env }), []);
  assert.ok(qualifyResource({ path: join(path, "SKILL.md"), cwd: data.directory, roots: selected }));
});
