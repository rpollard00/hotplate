import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openHotplateReadStore } from "../src/store.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "content");
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, "reference.md"), "CONTENT_MUST_NOT_BE_RECORDED");
  writeFileSync(join(root, ".hidden", "principle.md"), "CONTENT_MUST_NOT_BE_RECORDED");
  const databasePath = join(directory, "capture.sqlite");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    HOTPLATE_DB: databasePath, HOTPLATE_PROCESS_REGISTRY: join(directory, "processes"),
  };
  async function command(args: readonly string[], additionalEnv: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [cli, "resources", ...args], { env: { ...env, ...additionalEnv }, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    return stdout;
  }
  return { directory, root, databasePath, env, command };
}

test("resource CLI persists roots, inventories hidden files, and reconciles deletion without reading bodies", async t => {
  const f = fixture(t);
  await f.command(["add-root", f.root]);
  const config = join(f.directory, ".config/hotplate/resources.json");
  assert.equal(statSync(config).mode & 0o777, 0o600);
  const scan = await f.command(["scan"], { XDG_CONFIG_HOME: join(f.directory, "opencode-v1-config") });
  assert.match(scan, /"fileCount":2/u);
  const listed = await f.command(["list"]);
  assert.ok(listed.includes(".hidden/principle.md"));
  assert.ok(!listed.includes("CONTENT_MUST_NOT_BE_RECORDED"));
  const open = openHotplateReadStore({ databasePath: f.databasePath });
  assert.equal(open.kind, "ready");
  if (open.kind === "ready") {
    try {
      const view = await open.store.queryResources({});
      assert.equal(view.rows.length, 2);
      assert.ok(view.rows.every(row => row.presence === "present" && row.observation === "unknown"));
    } finally { await open.store.close(); }
  }
  unlinkSync(join(f.root, "reference.md"));
  await f.command(["scan"]);
  assert.match(await f.command(["list"]), /"presence":"absent"/u);
  await f.command(["remove-root", f.root]);
  assert.match(await f.command(["scan"]), /"fileCount":0/u);
  assert.match(await f.command(["list"]), /reference\.md/u);
});

test("watch retains inventory and unavailable coverage when helper cannot start, then stops cleanly", async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, [cli, "resources", "watch", "--root", f.root, "--helper", join(f.directory, "missing-helper")], {
    cwd: f.directory, env: f.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const deadline = Date.now() + 5000;
  while (!stderr.includes("helper-unavailable") && Date.now() < deadline && child.exitCode === null) await delay(20);
  assert.match(stderr, /helper-unavailable/u);
  child.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const open = openHotplateReadStore({ databasePath: f.databasePath });
  assert.equal(open.kind, "ready");
  if (open.kind === "ready") {
    try {
      const resources = await open.store.queryResources({});
      assert.equal(resources.rows.length, 2);
      assert.ok(resources.rows.every(row => row.observation === "unknown"));
      assert.ok((await open.store.queryResourceCoverage({})).rows.some(row => row.status === "unavailable"));
    } finally { await open.store.close(); }
  }
});

test("watch exits cleanly when SIGTERM interrupts the initial inventory scan", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  for (let index = 0; index < 2000; index++) writeFileSync(join(f.root, `${index}.md`), "fixture");
  const staging = join(f.directory, "temporary");
  mkdirSync(staging);
  const child = spawn(process.execPath, [cli, "resources", "watch", "--root", f.root, "--helper", join(f.directory, "missing-helper")], {
    cwd: f.directory, env: { ...f.env, TMPDIR: staging }, stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const deadline = Date.now() + 5000;
  while (!readdirSync(staging).some(name => name.startsWith("hotplate-inventory-")) && Date.now() < deadline && child.exitCode === null) await delay(1);
  assert.ok(readdirSync(staging).some(name => name.startsWith("hotplate-inventory-")), "The initial scan must have an open staging directory before SIGTERM");
  assert.equal(child.kill("SIGTERM"), true);
  const [code, signal] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.doesNotMatch(stderr, /aborted|Filesystem observer unavailable/u);
  assert.deepEqual(readdirSync(staging), []);
  const open = openHotplateReadStore({ databasePath: f.databasePath });
  assert.equal(open.kind, "ready");
  if (open.kind === "ready") {
    try {
      assert.equal((await open.store.queryResources({})).rows.length, 0);
      assert.equal((await open.store.queryResourceCoverage({})).rows.length, 0);
    } finally { await open.store.close(); }
  }
});

test("disabled resource capture creates no database", async t => {
  const f = fixture(t);
  assert.match(await f.command(["scan", "--root", f.root], { HOTPLATE_DISABLED: "1" }), /disabled/u);
  assert.equal(existsSync(f.databasePath), false);
});

function treeState(path: string): unknown {
  const stat = lstatSync(path);
  return { path, mode: stat.mode, mtime: stat.mtimeMs, size: stat.size,
    content: stat.isSymbolicLink() ? readlinkSync(path) : stat.isDirectory() ? readdirSync(path).sort().map(name => treeState(join(path, name))) : readFileSync(path, "utf8") };
}

test("preview explains installed aliases and rejected checkout roots without state changes", async t => {
  const f = fixture(t);
  const checkout = join(f.directory, "checkout");
  const installed = join(checkout, "skills");
  const alias = join(f.directory, ".agents/skills/reese");
  for (const path of [join(checkout, ".git"), join(installed, "sample/.artifacts"), join(installed, "sample/node_modules/dependency"), join(f.directory, ".agents/skills"), join(f.directory, ".config/hotplate"), join(f.directory, "roots")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(installed, "sample/SKILL.md"), "private skill body");
  writeFileSync(join(installed, "sample/.artifacts/kept.md"), "private artifact body");
  writeFileSync(join(installed, "sample/node_modules/dependency/SKILL.md"), "excluded");
  writeFileSync(join(checkout, "source.ts"), "excluded source");
  symlinkSync(installed, alias);
  const configPath = join(f.directory, ".config/hotplate/resources.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, roots: [checkout] }));
  writeFileSync(join(f.directory, "roots/stale.json"), "invalid expired registration");
  const before = treeState(f.directory);
  const output = await f.command(["preview", "--helper", join(f.directory, "must-not-start")], {
    HOTPLATE_RESOURCE_REGISTRY: join(f.directory, "roots"), HOTPLATE_CONFIG: join(f.directory, "invalid-account.json"),
    HOTPLATE_INTEGRATION_SETTINGS: join(f.directory, "invalid-selection.json"), HOTPLATE_DISABLED: "1",
  });
  const result = JSON.parse(output);
  assert.equal(result.kind, "preview");
  assert.equal(result.fileCount, 2);
  assert.equal(result.incompleteCount, 0);
  assert.equal(result.truncated, false);
  assert.ok(result.roots.some((root: { path: string; canonicalPath: string }) => root.path === alias && root.canonicalPath === installed));
  assert.ok(result.diagnostics.some((diagnostic: { path: string; reason: string; relatedPaths: string[] }) => diagnostic.path === checkout && diagnostic.reason === "source-root" && diagnostic.relatedPaths.includes(alias)));
  assert.ok(result.roots.every((root: { admission: { exclusions: { segments: string[] } } }) => root.admission.exclusions.segments.includes("node_modules")));
  assert.ok(!output.includes("private skill body"));
  assert.deepEqual(treeState(f.directory), before);
  assert.equal(existsSync(f.databasePath), false);
});

test("preview requires a provider for manual project scope and reports bounded incomplete counts", async t => {
  const f = fixture(t);
  mkdirSync(join(f.directory, ".git"));
  mkdirSync(join(f.directory, ".agents/skills/project"), { recursive: true });
  writeFileSync(join(f.directory, ".agents/skills/project/SKILL.md"), "project");
  const projectEnv = { ...f.env, HOME: join(f.directory, "home") };
  const run = (args: readonly string[]) => spawnSync(process.execPath, [cli, "resources", ...args], { cwd: f.directory, env: projectEnv, encoding: "utf8" });
  const noHost = run(["preview", "--project", f.directory]);
  assert.notEqual(noHost.status, 0);
  assert.match(noHost.stderr, /--project requires --host/u);
  const account = run(["preview"]);
  assert.equal(account.status, 0, account.stderr);
  assert.equal(JSON.parse(account.stdout).fileCount, 0);
  const project = run(["preview", "--project", f.directory, "--host", "codex"]);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(JSON.parse(project.stdout).fileCount, 1);
  const limited = run(["preview", "--root", f.root, "--max-entries", "1"]);
  assert.equal(limited.status, 0, limited.stderr);
  assert.equal(JSON.parse(limited.stdout).truncated, true);
  assert.equal(JSON.parse(limited.stdout).incompleteCount, 1);
  assert.equal(JSON.parse(limited.stdout).scans[0].error, "limit");
  assert.equal(existsSync(f.databasePath), false);
});

test("add-root rejects checkout and home roots before writing configuration", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".git"));
  for (const root of [f.root, f.directory]) {
    const result = spawnSync(process.execPath, [cli, "resources", "add-root", root], { cwd: f.directory, env: f.env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Resource root rejected.*source-root/u);
  }
  assert.equal(existsSync(join(f.directory, ".config/hotplate/resources.json")), false);
  assert.equal(existsSync(f.databasePath), false);
});

test("watch retries a helper that exits while reconciliation continues", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
  const f = fixture(t);
  const starts = join(f.directory, "starts");
  const helper = join(f.directory, "helper.cjs");
  writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(starts)},'start\\n');process.stdout.write('{"type":"ready","scopeVersion":1}\\n');\n`);
  chmodSync(helper, 0o700);
  const child = spawn(process.execPath, [cli, "resources", "watch", "--root", f.root, "--helper", helper, "--interval-ms", "1000"], {
    cwd: f.directory, env: f.env, stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const count = () => existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").length : 0;
  const deadline = Date.now() + 5000;
  while (count() < 2 && Date.now() < deadline && child.exitCode === null) await delay(20);
  assert.ok(count() >= 2, stderr);
  child.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0, stderr);
});
