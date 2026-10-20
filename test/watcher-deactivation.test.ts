import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const service = "hotplate-resources.service";
const marker = "# Managed by Hotplate activate-watcher; resources service v1";

function fixture(t: TestContext, useXdg = false) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-deactivation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home $cash %value "quoted" \\path');
  const config = useXdg ? join(directory, 'config $cash %value "quoted" \\path') : join(home, ".config");
  const bin = join(directory, "bin");
  const state = join(directory, "manager");
  const unit = join(config, "systemd/user", service);
  for (const path of [home, bin, state, dirname(unit)]) mkdirSync(path, { recursive: true });
  const script = join(directory, "deactivate-watcher");
  copyFileSync(join(process.cwd(), "scripts/deactivate-watcher"), script);
  chmodSync(script, 0o700);
  const log = join(directory, "commands.jsonl");
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    DEACTIVATION_TEST_LOG: log, DEACTIVATION_TEST_STATE: state,
  };
  if (useXdg) env.XDG_CONFIG_HOME = config;
  writeFileSync(join(bin, "id"), '#!/bin/sh\nprintf "%s\\n" "${DEACTIVATION_TEST_UID:-1001}"\n', { mode: 0o700 });
  const mock = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.DEACTIVATION_TEST_LOG, JSON.stringify({ name, args }) + '\\n');
if (name !== 'systemctl') throw new Error('Forbidden command: ' + name);
const command = args[1];
if (args[0] !== '--user') throw new Error('Expected the user manager');
if (command !== 'show-environment' && args[2] !== '${service}') throw new Error('Unexpected service: ' + args[2]);
if (process.env.DEACTIVATION_TEST_FAIL === command) {
  process.stderr.write('simulated ' + command + ' failure\\n'); process.exit(23);
}
const file = key => join(process.env.DEACTIVATION_TEST_STATE, key);
const read = key => readFileSync(file(key), 'utf8');
switch (command) {
  case 'show-environment': break;
  case 'show':
    process.stdout.write('LoadState=' + read('load') + '\\nFragmentPath=' + read('fragment') + '\\nActiveState=' + read('active') + '\\n');
    break;
  case 'stop':
    if (process.env.DEACTIVATION_TEST_NO_EFFECT !== command) writeFileSync(file('active'), 'inactive');
    break;
  case 'disable':
    if (process.env.DEACTIVATION_TEST_NO_EFFECT !== command) writeFileSync(file('enabled'), 'disabled');
    break;
  case 'is-active': {
    const value = process.env.DEACTIVATION_TEST_ACTIVE_OUTPUT ?? read('active');
    process.stdout.write(value + '\\n');
    process.exit(Number(process.env.DEACTIVATION_TEST_ACTIVE_EXIT ?? (value === 'active' ? 0 : 3)));
  }
  case 'is-enabled': {
    const value = process.env.DEACTIVATION_TEST_ENABLED_OUTPUT ?? read('enabled');
    process.stdout.write(value + '\\n');
    process.exit(Number(process.env.DEACTIVATION_TEST_ENABLED_EXIT ?? (value === 'enabled' ? 0 : 1)));
  }
  default: throw new Error('Unexpected systemctl command: ' + command);
}
`;
  for (const name of ["systemctl", "sudo", "npm", "node", "setcap", "pkill", "killall"]) writeFileSync(join(bin, name), mock, { mode: 0o700 });
  function setState(values: { load: string; fragment: string; active: string; enabled: string }) {
    for (const [key, value] of Object.entries(values)) writeFileSync(join(state, key), value);
  }
  setState({ load: "not-found", fragment: "", active: "inactive", enabled: "not-found" });
  function install() {
    writeFileSync(unit, `${marker}\n[Service]\nExecStart=/installed/helper\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    setState({ load: "loaded", fragment: unit, active: "active", enabled: "enabled" });
  }
  function run(args: readonly string[] = []) {
    return spawnSync(script, args, { cwd: home, env, encoding: "utf8", timeout: 10_000 });
  }
  function calls() {
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").map(line => {
      const entry: unknown = JSON.parse(line);
      assert.ok(entry && typeof entry === "object" && "name" in entry && "args" in entry);
      assert.equal(entry.name, "systemctl", "Only systemctl may change the service");
      assert.ok(Array.isArray(entry.args) && entry.args.every(value => typeof value === "string"));
      return entry.args;
    });
  }
  function mutations() { return calls().filter(args => !["show-environment", "show", "is-active", "is-enabled"].includes(args[1] ?? "")); }
  return { directory, home, config, state, unit, env, install, setState, run, calls, mutations };
}

test("watcher deactivation stops only the managed service, verifies its state, and preserves saved artifacts on rerun", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.install();
  const paths = [
    f.unit,
    join(f.config, "hotplate/resources.json"),
    join(f.config, "hotplate/account.json"),
    join(f.config, "hotplate/integrations.json"),
    join(f.home, ".local/share/hotplate/events.sqlite"),
    join(f.directory, "installed/helper"),
    join(f.config, "systemd/user/hotplate-relay.service"),
    join(f.config, "systemd/user/hotplate-integrations.service"),
  ];
  for (const path of paths.slice(1)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `preserved ${path}\n`);
  }
  const before = paths.map(path => readFileSync(path));
  for (let run = 0; run < 2; run++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /hotplate-resources\.service is inactive and disabled\./u);
    assert.match(result.stdout, /Foreground watchers and custom services are outside this script/u);
    assert.equal(readFileSync(join(f.state, "active"), "utf8"), "inactive");
    assert.equal(readFileSync(join(f.state, "enabled"), "utf8"), "disabled");
    assert.deepEqual(paths.map(path => readFileSync(path)), before);
  }
  assert.deepEqual(f.mutations(), Array.from({ length: 2 }, () => [["--user", "stop", service], ["--user", "disable", service]]).flat());
  assert.equal(f.calls().filter(args => args[1] === "is-active").length, 2);
  assert.equal(f.calls().filter(args => args[1] === "is-enabled").length, 2);
});

test("watcher deactivation accepts a missing service without changing the account", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is not installed and is inactive/u);
  assert.deepEqual(f.mutations(), []);
  assert.equal(existsSync(f.unit), false);
  f.install();
  f.setState({ load: "not-found", fragment: "", active: "inactive", enabled: "not-found" });
  const unloaded = f.run();
  assert.notEqual(unloaded.status, 0);
  assert.match(unloaded.stderr, /Cannot verify that .* is absent/u);
  rmSync(f.unit);
  f.setState({ load: "not-found", fragment: "", active: "active", enabled: "not-found" });
  const inconsistent = f.run();
  assert.notEqual(inconsistent.status, 0);
  assert.match(inconsistent.stderr, /Cannot verify that .* is absent/u);
  assert.deepEqual(f.mutations(), []);
});

test("watcher deactivation resolves the account unit with XDG paths containing shell characters", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t, true);
  f.install();
  f.env.HOTPLATE_DISABLED = "true";
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.mutations(), [["--user", "stop", service], ["--user", "disable", service]]);
});

test("watcher deactivation refuses unrelated, symlinked, and shadowed service units before mutation", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.install();
  const unrelated = "[Service]\nExecStart=/unrelated\n";
  writeFileSync(f.unit, unrelated);
  const unknown = f.run();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unrelated/u);
  assert.equal(readFileSync(f.unit, "utf8"), unrelated);
  const target = join(f.directory, "other.service");
  writeFileSync(target, `${marker}\n`);
  rmSync(f.unit);
  symlinkSync(target, f.unit);
  const symlink = f.run();
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /symlinked/u);
  rmSync(f.unit);
  f.install();
  f.setState({ load: "loaded", fragment: target, active: "active", enabled: "enabled" });
  const shadowed = f.run();
  assert.notEqual(shadowed.status, 0);
  assert.match(shadowed.stderr, /loaded unit must match/u);
  f.setState({ load: "masked", fragment: "/dev/null", active: "inactive", enabled: "masked" });
  const masked = f.run();
  assert.notEqual(masked.status, 0);
  assert.match(masked.stderr, /Cannot verify ownership/u);
  assert.deepEqual(f.mutations(), []);
});

test("watcher deactivation help and invalid arguments do not inspect or change services", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.env.DEACTIVATION_TEST_UID = "0";
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: scripts\/deactivate-watcher/u);
  for (const args of [["--force"], ["--help", "extra"], ["root"]]) {
    const invalid = f.run(args);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /No other arguments are supported/u);
  }
  const root = f.run();
  assert.notEqual(root.status, 0);
  assert.match(root.stderr, /without sudo/u);
  assert.deepEqual(f.calls(), []);
});

test("watcher deactivation reports user manager, inspection, stop, and disable failures", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.install();
  for (const command of ["show-environment", "show", "stop", "disable"]) {
    f.env.DEACTIVATION_TEST_FAIL = command;
    const result = f.run();
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, new RegExp(`simulated ${command} failure`, "u"));
    assert.doesNotMatch(result.stdout, /is inactive and disabled/u);
  }
  assert.deepEqual(f.mutations(), [["--user", "stop", service], ["--user", "stop", service], ["--user", "disable", service]]);
});

test("watcher deactivation verifies final state after commands report success", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  for (const command of ["stop", "disable"]) {
    f.install();
    f.env.DEACTIVATION_TEST_NO_EFFECT = command;
    const result = f.run();
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /Cannot verify/u);
    assert.doesNotMatch(result.stdout, /is inactive and disabled/u);
  }
});

test("watcher deactivation rejects state text that disagrees with exit status and inspection failures", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  f.install();
  for (const [output, status] of [["active", "3"], ["inactive", "0"], ["inactive", "23"]]) {
    f.env.DEACTIVATION_TEST_ACTIVE_OUTPUT = output;
    f.env.DEACTIVATION_TEST_ACTIVE_EXIT = status;
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot verify that .* stopped/u);
  }
  delete f.env.DEACTIVATION_TEST_ACTIVE_OUTPUT;
  delete f.env.DEACTIVATION_TEST_ACTIVE_EXIT;
  for (const [output, status] of [["enabled", "1"], ["disabled", "0"], ["disabled", "23"]]) {
    f.env.DEACTIVATION_TEST_ENABLED_OUTPUT = output;
    f.env.DEACTIVATION_TEST_ENABLED_EXIT = status;
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot verify that .* is disabled/u);
  }
  delete f.env.DEACTIVATION_TEST_ENABLED_OUTPUT;
  delete f.env.DEACTIVATION_TEST_ENABLED_EXIT;
  for (const command of ["is-active", "is-enabled"]) {
    f.env.DEACTIVATION_TEST_FAIL = command;
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`simulated ${command} failure`, "u"));
    assert.match(result.stderr, /Cannot verify/u);
  }
});
