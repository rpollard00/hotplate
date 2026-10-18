import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

test("disabled resource capture creates no database", async t => {
  const f = fixture(t);
  assert.match(await f.command(["scan", "--root", f.root], { HOTPLATE_DISABLED: "1" }), /disabled/u);
  assert.equal(existsSync(f.databasePath), false);
});

test("watch retries a helper that exits while reconciliation continues", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
  const f = fixture(t);
  const starts = join(f.directory, "starts");
  const helper = join(f.directory, "helper.cjs");
  writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(starts)},'start\\n');process.stdout.write('{"type":"ready"}\\n');\n`);
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
