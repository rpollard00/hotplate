import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { probeReceiver } from "../src/integrations/setup.js";

const modulePath = fileURLToPath(new URL("../src/integrations/setup.js", import.meta.url));
const token = "SETUP_TOKEN_CANARY_12345678901234567890";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hotplate-setup-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: bin, XDG_CONFIG_HOME: join(root, "configuration"), XDG_DATA_HOME: join(root, "data"),
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    HOTPLATE_INTEGRATION_SETTINGS: join(root, "selection.json"), NODE_NO_WARNINGS: "1",
    HOTPLATE_SETUP_TEST_LOG: join(root, "systemctl.log"),
  };
  delete env.HOTPLATE_DB;
  delete env.HOTPLATE_CONFIG;
  delete env.HOTPLATE_DISABLED;
  for (const [name, version] of Object.entries({ codex: "0.158.0", claude: "2.1.283", opencode: "2.0.15", "opencode-v1": "1.18.33" })) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 });
  }
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOTPLATE_SETUP_TEST_LOG"\nexit 0\n', { mode: 0o700 });
  const configPath = join(root, "account $cash %value.json");
  writeFileSync(join(root, "token"), token, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ endpoint: "https://collector.example", sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", databasePath: join(root, "db $cash.sqlite"), tokenFile: join(root, "token") }));
  const v1Home = join(root, "v1-configuration");
  const unit = join(root, "configuration/systemd/user/hotplate-relay.service");
  function run(args: readonly string[]) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `import { runSetupCommand } from ${JSON.stringify(modulePath)}; try { await runSetupCommand(JSON.parse(process.argv[1])); } catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }`, JSON.stringify(args)], { env, encoding: "utf8", timeout: 15000 });
  }
  return { root, env, bin, configPath, v1Home, unit, run };
}

test("setup installs all available integrations, persists selection, and enables one owned relay", () => {
  const f = fixture();
  try {
    const args = ["--config", f.configPath, "--opencode-v1-config-home", f.v1Home];
    const first = f.run(args);
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.endpoint, "https://collector.example");
    assert.equal(report.hosts.length, 4);
    assert.ok(report.hosts.every((host: { state: string }) => host.state === "installed"));
    assert.deepEqual(report.service, { supported: true, active: true, enabled: true });
    assert.equal(report.relay.delivery.pendingCount, 0);
    assert.deepEqual(report.receiver, { reachable: false, httpStatus: null });
    assert.equal(first.stdout.includes(token), false);
    assert.equal(existsSync(join(f.v1Home, "opencode/opencode.json")), true);
    assert.equal(existsSync(join(f.root, "configuration/opencode/plugins/hotplate.js")), true);
    const body = readFileSync(f.unit, "utf8");
    assert.ok(body.includes("account $$cash %%value.json"));
    assert.ok(body.includes("db $cash.sqlite"));
    assert.equal(body.includes(token), false);
    const second = f.run(args);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(f.unit, "utf8"), body);
    const status = f.run(["--status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).hosts.length, 4);
    const calls = readFileSync(join(f.root, "systemctl.log"), "utf8");
    assert.ok(calls.includes("--user enable hotplate-relay.service"));
    assert.ok(calls.includes("--user restart hotplate-relay.service"));
    assert.equal(calls.includes(token), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("receiver probe reports protected HTTP endpoints, omits credentials, and rejects redirects and timeouts", async () => {
  let status = 401;
  let requests = 0;
  let hang = false;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "HEAD");
    assert.equal(request.url, "/health");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    if (hang) return;
    response.writeHead(status, status === 302 ? { location: "/redirected" } : {});
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const code of [200, 401, 403, 503]) {
      status = code;
      assert.deepEqual(await probeReceiver(origin), { reachable: true, httpStatus: code });
    }
    status = 302;
    assert.deepEqual(await probeReceiver(origin), { reachable: false, httpStatus: null });
    assert.equal(requests, 5);
    hang = true;
    const started = performance.now();
    assert.deepEqual(await probeReceiver(origin), { reachable: false, httpStatus: null });
    assert.ok(performance.now() - started < 3000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  assert.deepEqual(await probeReceiver(origin), { reachable: false, httpStatus: null });
});

test("setup refuses unrelated service files before installation or enrollment", () => {
  const f = fixture();
  try {
    mkdirSync(dirname(f.unit), { recursive: true });
    writeFileSync(f.unit, "[Service]\nExecStart=/unrelated\n");
    const result = f.run(["--config", f.configPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unrelated/u);
    assert.equal(readFileSync(f.unit, "utf8"), "[Service]\nExecStart=/unrelated\n");
    assert.equal(existsSync(join(f.root, "selection.json")), false);
    assert.equal(existsSync(join(f.root, "db $cash.sqlite")), false);
    assert.equal(existsSync(join(f.root, "codex/hooks.json")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("setup reports missing hosts and partial v1 isolation errors without exposing tokens", () => {
  const f = fixture();
  try {
    rmSync(join(f.bin, "claude"));
    const result = f.run(["--config", f.configPath]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.hosts.find((host: { host: string }) => host.host === "claude-code").state, "skipped");
    assert.equal(report.hosts.find((host: { host: string }) => host.host === "opencode-v1").state, "error");
    assert.equal(report.service.active, true);
    assert.equal(existsSync(join(f.root, "selection.json")), true);
    assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("setup rejects unavailable systemd before writing integration configuration", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = f.run(["--config", f.configPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /systemd user manager/u);
    assert.equal(existsSync(join(f.root, "selection.json")), false);
    assert.equal(existsSync(f.unit), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("setup resolves an enrolled relay and retains configuration after service startup failure", () => {
  const f = fixture();
  try {
    const origin = "https://collector.example";
    const accountPath = join(f.root, "data/hotplate/connections", createHash("sha256").update(origin).digest("hex"), "account.json");
    mkdirSync(dirname(accountPath), { recursive: true });
    writeFileSync(accountPath, readFileSync(f.configPath));
    writeFileSync(join(f.bin, "systemctl"), `#!/bin/sh\nif [ "$2" = restart ]; then printf '${token}' >&2; exit 1; fi\nexit 0\n`, { mode: 0o700 });
    const result = f.run(["--relay", origin, "--opencode-v1-config-home", f.v1Home]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Setup is incomplete/u);
    assert.equal(JSON.parse(result.stdout).configPath, accountPath);
    const selection = JSON.parse(readFileSync(join(f.root, "selection.json"), "utf8"));
    assert.equal(selection.configPath, accountPath);
    assert.equal(selection.databasePath, join(f.root, "db $cash.sqlite"));
    assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false);
    assert.equal(existsSync(f.unit), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
