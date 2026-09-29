import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeIntegration, integrationStatus } from "../src/integrations/install.js";
import * as v1Entry from "../src/integrations/opencode/v1-entry.js";
import * as v2Entry from "../src/integrations/opencode/v2-entry.js";

test("native installation is idempotent and preserves unrelated hooks and settings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hotplate-install-"));
  try {
    const binary = join(cwd, "runtime");
    writeFileSync(binary, "#!/bin/sh\nprintf '2.1.283\\n'\n", { mode: 0o700 });
    mkdirSync(join(cwd, ".claude"));
    const path = join(cwd, ".claude", "settings.local.json");
    const unrelated = { matcher: "Read", hooks: [{ type: "command", command: "printf unrelated" }] };
    writeFileSync(path, JSON.stringify({ theme: "dark", hooks: { PostToolUse: [unrelated] } }));
    const options: Parameters<typeof changeIntegration>[1] = { host: "claude-code", cwd, binary };
    changeIntegration("install", options);
    const once = readFileSync(path, "utf8");
    changeIntegration("install", options);
    assert.equal(readFileSync(path, "utf8"), once);
    assert.equal(integrationStatus(options).installed, true);
    changeIntegration("remove", options);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "dark", hooks: { PostToolUse: [unrelated], PostToolUseFailure: [] } });
    assert.equal(integrationStatus(options).installed, false);
    changeIntegration("remove", options);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("OpenCode v2 installs an owned discoverable wrapper and preserves configuration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hotplate-install-v2-"));
  try {
    const binary = join(cwd, "runtime");
    writeFileSync(binary, "#!/bin/sh\nprintf 'opencode v2.0.15\\n'\n", { mode: 0o700 });
    const path = join(cwd, ".opencode", "plugins", "hotplate.js");
    const configurationPath = join(cwd, "opencode.json");
    const configuration = '{"plugins":["unrelated"],"theme":"dark"}\n';
    writeFileSync(configurationPath, configuration);
    const options: Parameters<typeof changeIntegration>[1] = { host: "opencode-v2", cwd, binary };
    changeIntegration("install", options);
    const once = readFileSync(path, "utf8");
    assert.match(once, /^export \{ default \} from "file:.*\/opencode\/v2-entry\.js";\n$/u);
    const status = integrationStatus(options);
    assert.equal(status.installed, true);
    assert.equal(status.version, "2.0.15");
    assert.equal(status.configurationPath, path);
    changeIntegration("install", options);
    assert.equal(readFileSync(path, "utf8"), once);
    assert.equal(readFileSync(configurationPath, "utf8"), configuration);
    changeIntegration("remove", options);
    assert.equal(existsSync(path), false);
    assert.equal(integrationStatus(options).installed, false);
    changeIntegration("remove", options);
    assert.equal(readFileSync(configurationPath, "utf8"), configuration);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("OpenCode v2 refuses to overwrite or remove an unowned plugin file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hotplate-install-v2-"));
  try {
    const binary = join(cwd, "runtime");
    writeFileSync(binary, "#!/bin/sh\nprintf 'opencode v2.0.15\\n'\n", { mode: 0o700 });
    const path = join(cwd, ".opencode", "plugins", "hotplate.js");
    mkdirSync(join(cwd, ".opencode", "plugins"), { recursive: true });
    const original = "export default { id: 'unrelated' };\n";
    writeFileSync(path, original);
    const options: Parameters<typeof changeIntegration>[1] = { host: "opencode-v2", cwd, binary };
    assert.equal(integrationStatus(options).installed, false);
    assert.throws(() => changeIntegration("install", options), /not owned/u);
    assert.throws(() => changeIntegration("remove", options), /not owned/u);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(existsSync(join(cwd, "opencode.json")), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("OpenCode v1 cannot install beside a v2 wrapper without configuration JSON", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hotplate-install-major-"));
  try {
    const binary = join(cwd, "runtime");
    writeFileSync(binary, "#!/bin/sh\nprintf 'opencode v2.0.15\\n'\n", { mode: 0o700 });
    changeIntegration("install", { host: "opencode-v2", cwd, binary });
    const path = join(cwd, ".opencode", "plugins", "hotplate.js");
    const wrapper = readFileSync(path, "utf8");
    writeFileSync(binary, "#!/bin/sh\nprintf '1.18.29\\n'\n", { mode: 0o700 });
    assert.throws(() => changeIntegration("install", { host: "opencode-v1", cwd, binary }), /other major/u);
    assert.equal(readFileSync(path, "utf8"), wrapper);
    assert.equal(existsSync(join(cwd, "opencode.json")), false);
    changeIntegration("remove", { host: "opencode-v2", cwd, binary });
    changeIntegration("install", { host: "opencode-v1", cwd, binary });
    assert.equal(integrationStatus({ host: "opencode-v1", cwd, binary }).installed, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("public OpenCode entrypoints expose only the plugin default", () => {
  assert.deepEqual(Object.keys(v1Entry), ["default"]);
  assert.deepEqual(Object.keys(v2Entry), ["default"]);
  const manifest = readFileSync("package.json", "utf8");
  assert.match(manifest, /"\.\/integrations\/opencode-v1"\s*:\s*"\.\/dist\/src\/integrations\/opencode\/v1-entry\.js"/u);
  assert.match(manifest, /"\.\/integrations\/opencode-v2"\s*:\s*"\.\/dist\/src\/integrations\/opencode\/v2-entry\.js"/u);
});

test("OpenCode refuses wrong major, JSONC, and conflicting configuration without writes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hotplate-install-"));
  try {
    const binary = join(cwd, "runtime");
    writeFileSync(binary, "#!/bin/sh\nprintf '2.0.15\\n'\n", { mode: 0o700 });
    assert.throws(() => changeIntegration("install", { host: "opencode-v1", cwd, binary }), /wrong major/u);
    assert.equal(existsSync(join(cwd, "opencode.json")), false);
    writeFileSync(join(cwd, "opencode.jsonc"), "// preserve\n{}");
    assert.throws(() => changeIntegration("install", { host: "opencode-v2", cwd, binary }), /JSONC/u);
    rmSync(join(cwd, "opencode.jsonc"));
    writeFileSync(join(cwd, "opencode.json"), '{"plugin":["unrelated"]}');
    assert.throws(() => changeIntegration("install", { host: "opencode-v2", cwd, binary }), /other major/u);
    assert.equal(readFileSync(join(cwd, "opencode.json"), "utf8"), '{"plugin":["unrelated"]}');
    writeFileSync(join(cwd, "opencode.json"), "malformed");
    assert.throws(() => changeIntegration("install", { host: "opencode-v2", cwd, binary }), /Invalid integration/u);
    assert.equal(readFileSync(join(cwd, "opencode.json"), "utf8"), "malformed");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
