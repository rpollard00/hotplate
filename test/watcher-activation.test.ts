import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-activation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, 'checkout $cash %value "quoted"');
  const home = join(directory, 'home $cash %value "quoted" \\path');
  const caller = join(directory, "caller");
  const bin = join(directory, "bin");
  for (const path of [repository, home, bin, join(caller, "relative skills"), join(repository, "scripts"), join(repository, "native"), join(repository, "test")]) mkdirSync(path, { recursive: true });
  for (const path of ["src", "package.json", "tsconfig.json", "native/fanotify.c", "scripts/build-observer.mjs", "scripts/activate-watcher"]) cpSync(join(process.cwd(), path), join(repository, path), { recursive: true });
  symlinkSync(join(process.cwd(), "node_modules"), join(repository, "node_modules"), "dir");
  writeFileSync(join(repository, "test", "root.ts"), "export {};\n");
  const log = join(directory, "commands.jsonl");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
    NODE_NO_WARNINGS: "1", ACTIVATION_TEST_LOG: log,
  };
  writeFileSync(join(bin, "id"), '#!/bin/sh\nif [ "$1" = -u ]; then printf "1001\\n"; else printf "2001\\n"; fi\n', { mode: 0o700 });
  const mock = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.ACTIVATION_TEST_LOG, JSON.stringify({ name, args }) + '\\n');
if (process.env.ACTIVATION_TEST_FAIL === name + ':' + args[name === 'systemctl' ? 1 : 0]) {
  process.stderr.write('simulated command failure\\n'); process.exit(23);
}
if (name === 'systemctl' && args[1] === 'show') process.stdout.write('ActiveState=active\\nSubState=running\\nMainPID=123\\nExecMainStatus=0\\n');
if (name === 'getcap') process.stdout.write(args[0] + ' cap_sys_admin=ep\\n');
`;
  for (const name of ["sudo", "systemctl", "getcap", "setcap"]) writeFileSync(join(bin, name), mock, { mode: 0o700 });
  const script = join(repository, "scripts", "activate-watcher");
  const unit = join(home, ".config", "systemd", "user", "hotplate-resources.service");
  function run(args: readonly string[] = []) {
    return spawnSync("/bin/bash", [script, ...args], { cwd: caller, env, encoding: "utf8", timeout: 30_000 });
  }
  function calls(name: string): string[][] {
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").flatMap(line => {
      const entry: unknown = JSON.parse(line);
      assert.ok(entry && typeof entry === "object" && "name" in entry && "args" in entry);
      if (entry.name !== name) return [];
      assert.ok(Array.isArray(entry.args) && entry.args.every(value => typeof value === "string"));
      return [entry.args];
    });
  }
  return { directory, repository, home, caller, bin, env, script, unit, run, calls };
}

test("watcher activation builds, preserves account selection and caller roots, and restarts on rerun", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const selection = join(f.directory, 'selection $cash %value "quoted".json');
  const account = join(f.directory, "account.json");
  const database = join(f.directory, "existing-account.sqlite");
  writeFileSync(account, JSON.stringify({ endpoint: "https://collector.example", sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", databasePath: database, tokenFile: join(f.directory, "token") }));
  writeFileSync(selection, JSON.stringify({ configPath: account }));
  f.env.HOTPLATE_INTEGRATION_SETTINGS = selection;
  f.env.HOTPLATE_PROCESS_REGISTRY = join(f.directory, "processes $cash %value");
  const first = f.run(["relative skills"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(join(f.repository, "dist", "src", "cli.js")));
  assert.ok(statSync(join(f.repository, "native", "hotplate-fanotify")).mode & 0o100);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, ".config", "hotplate", "resources.json"), "utf8")).roots, [join(f.caller, "relative skills")]);
  assert.ok(first.stdout.includes(database), "Coverage status uses the selected account database");
  assert.match(first.stdout, /ActiveState=active/u);
  assert.match(first.stdout, /A running service alone does not confirm coverage/u);
  const body = readFileSync(f.unit, "utf8");
  assert.ok(body.startsWith("# Managed by Hotplate activate-watcher; resources service v1\n"));
  assert.ok(body.includes("WorkingDirectory=%h\n"));
  assert.ok(body.includes('checkout $$cash %%value \\"quoted\\"/dist/src/cli.js'));
  assert.ok(body.includes('home $$cash %%value \\"quoted\\" \\\\path'));
  assert.ok(body.includes('Environment="HOTPLATE_INTEGRATION_SETTINGS=' + selection.replaceAll('"', '\\"').replaceAll('%', '%%') + '"'));
  assert.ok(body.includes("UnsetEnvironment=HOTPLATE_CONFIG\n"));
  assert.ok(body.includes("UnsetEnvironment=HOTPLATE_DB\n"));
  assert.ok(body.includes("UnsetEnvironment=HOTPLATE_DISABLED\n"));
  assert.doesNotMatch(body, /NoNewPrivileges|User=root|sudo/u);
  assert.equal(statSync(f.unit).mode & 0o777, 0o600);
  const installed = "/usr/local/libexec/hotplate/1001/hotplate-fanotify";
  const privileged = [
    ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", "/usr/local/libexec/hotplate", dirname(installed)],
    ["install", "-o", "root", "-g", "2001", "-m", "0750", "--", join(f.repository, "native", "hotplate-fanotify"), installed],
    ["setcap", "cap_sys_admin=ep", installed],
  ];
  assert.deepEqual(f.calls("sudo"), privileged);
  const second = f.run(["relative skills"]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(readFileSync(f.unit, "utf8"), body);
  assert.deepEqual(f.calls("sudo"), [...privileged, ...privileged]);
  assert.deepEqual(f.calls("systemctl"), Array.from({ length: 2 }, () => [
    ["--user", "show-environment"], ["--user", "daemon-reload"], ["--user", "enable", f.unit],
    ["--user", "restart", "hotplate-resources.service"], ["--user", "show", "hotplate-resources.service", "--property=ActiveState,SubState,MainPID,ExecMainStatus", "--no-pager"],
  ]).flat());
  if (process.env.HOTPLATE_ACTIVATION_TEST_ARTIFACT) writeFileSync(process.env.HOTPLATE_ACTIVATION_TEST_ARTIFACT, body);
});

test("watcher activation validates prerequisites and service ownership before mutation", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: scripts\/activate-watcher/u);
  assert.deepEqual(f.calls("systemctl"), []);
  f.env.HOTPLATE_DISABLED = "true";
  assert.match(f.run().stderr, /Unset HOTPLATE_DISABLED/u);
  delete f.env.HOTPLATE_DISABLED;
  f.env.ACTIVATION_TEST_FAIL = "systemctl:show-environment";
  assert.match(f.run().stderr, /systemd user manager is required/u);
  delete f.env.ACTIVATION_TEST_FAIL;
  assert.match(f.run(["missing root"]).stderr, /Root must be a readable directory/u);
  f.env.HOTPLATE_CONFIG = "relative-account.json";
  assert.match(f.run().stderr, /HOTPLATE_CONFIG must be an absolute path/u);
  delete f.env.HOTPLATE_CONFIG;
  mkdirSync(dirname(f.unit), { recursive: true });
  const unrelated = "[Service]\nExecStart=/unrelated\n";
  writeFileSync(f.unit, unrelated);
  assert.match(f.run().stderr, /An unrelated hotplate-resources.service exists/u);
  assert.equal(readFileSync(f.unit, "utf8"), unrelated);
  rmSync(f.unit);
  const target = join(f.directory, "other.service");
  writeFileSync(target, "# Managed by Hotplate activate-watcher; resources service v1\n");
  symlinkSync(target, f.unit);
  assert.match(f.run().stderr, /An unrelated hotplate-resources.service exists/u);
  assert.deepEqual(f.calls("sudo"), []);
  assert.equal(existsSync(join(f.repository, "dist")), false);
  assert.equal(existsSync(join(f.home, ".config", "hotplate", "resources.json")), false);
});

test("watcher activation stops on capability failure and reports a failed restart", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.env.ACTIVATION_TEST_FAIL = "sudo:setcap";
  const capability = f.run(["relative skills"]);
  assert.notEqual(capability.status, 0);
  assert.match(capability.stderr, /Activation stopped/u);
  assert.equal(existsSync(f.unit), false);
  assert.equal(existsSync(join(f.home, ".config", "hotplate", "resources.json")), false);
  assert.deepEqual(f.calls("systemctl"), [["--user", "show-environment"]]);
  f.env.ACTIVATION_TEST_FAIL = "systemctl:restart";
  const restart = f.run();
  assert.notEqual(restart.status, 0);
  assert.match(restart.stderr, /journalctl --user -u hotplate-resources.service/u);
  assert.doesNotMatch(restart.stdout, /Service restarted\./u);
  assert.ok(existsSync(f.unit));
  assert.equal(f.calls("systemctl").filter(args => args[1] === "show").length, 0);
});
