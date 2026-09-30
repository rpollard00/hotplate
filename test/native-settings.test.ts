import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureFact, type CaptureFact } from "../src/capture.js";
import { nativeAccountConfig, readIntegrationSettings, readNativeAccountConfiguration, writeIntegrationSettings } from "../src/integrations/native-settings.js";

test("account setup enrolls all native hosts despite separate OpenCode XDG roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "hotplate-native-settings-"));
  const env = { HOTPLATE_INTEGRATION_SETTINGS: join(root, "settings.json"), XDG_CONFIG_HOME: join(root, "opencode-v1"), XDG_DATA_HOME: join(root, "v1-data") };
  try {
    const configPath = join(root, "account.json");
    const databasePath = join(root, "capture.sqlite");
    writeFileSync(configPath, JSON.stringify({ sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://collector.example", tokenFile: "missing-token" }));
    writeIntegrationSettings({ configPath, databasePath }, env);
    assert.equal(statSync(env.HOTPLATE_INTEGRATION_SETTINGS).mode & 0o777, 0o600);
    for (const host of ["codex", "claude-code", "opencode-v1", "opencode-v2"] as const) {
      const fact: CaptureFact = {
        host, sessionId: "session", actorId: "session", occurrenceId: "call", observedAt: "2026-01-01T00:00:00.000Z",
        scope: { projectCwd: root, sessionId: "session", sessionFile: null, segmentId: "session", segmentReason: "unknown", runId: null, turnId: null, leafId: null },
        evidence: { kind: "skill-invocation", skill: { name: "test", canonicalPath: null, version: null }, toolCallId: "call", outcome: "success", model: null },
      };
      assert.equal((await captureFact({ fact, env })).kind, "recorded");
    }
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(DISTINCT host) AS count FROM observations").get()?.count, 4);
      assert.equal(db.prepare("SELECT count(*) AS count FROM delivery_outbox").get()?.count, 4);
    } finally { db.close(); }
    assert.ok(!readFileSync(env.HOTPLATE_INTEGRATION_SETTINGS, "utf8").includes("token"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native selection preserves explicit overrides and fails closed on corrupt settings", () => {
  const root = mkdtempSync(join(tmpdir(), "hotplate-native-settings-"));
  const env = { HOTPLATE_INTEGRATION_SETTINGS: join(root, "settings.json") };
  try {
    assert.equal(readIntegrationSettings(env), null);
    writeIntegrationSettings({ configPath: join(root, "account.json") }, env);
    assert.equal(nativeAccountConfig(env), join(root, "account.json"));
    assert.equal(nativeAccountConfig({ ...env, HOTPLATE_CONFIG: "/explicit.json", HOTPLATE_DB: "/local.sqlite" }), "/explicit.json");
    assert.equal(nativeAccountConfig({ ...env, HOTPLATE_DB: "/local.sqlite" }), undefined);
    assert.equal(nativeAccountConfig({ ...env, HOTPLATE_CONFIG: "" }), "");
    writeFileSync(env.HOTPLATE_INTEGRATION_SETTINGS, "broken");
    assert.throws(() => nativeAccountConfig(env), /Invalid Hotplate integration settings/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay URL selects only an existing matching enrolled account", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdirSync } = await import("node:fs");
  const { resolveEnrolledRelayConfiguration } = await import("../src/integrations/native-settings.js");
  const root = mkdtempSync(join(tmpdir(), "hotplate-native-origin-"));
  try {
    const env = { XDG_DATA_HOME: root };
    assert.throws(() => resolveEnrolledRelayConfiguration("https://collector.example", env), /no enrolled account/u);
    const directory = join(root, "hotplate", "connections", createHash("sha256").update("https://collector.example").digest("hex"));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "account.json");
    writeFileSync(path, JSON.stringify({ sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://collector.example", tokenFile: "token" }));
    assert.equal(resolveEnrolledRelayConfiguration("https://collector.example/", env), path);
    writeFileSync(path, JSON.stringify({ sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://wrong.example", tokenFile: "token" }));
    assert.throws(() => resolveEnrolledRelayConfiguration("https://collector.example", env), /does not match/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("capture and relay honor an edited explicit account database over the saved fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "hotplate-native-db-change-"));
  try {
    const configPath = join(root, "account.json");
    const env = { HOTPLATE_INTEGRATION_SETTINGS: join(root, "settings.json") };
    writeIntegrationSettings({ configPath, databasePath: join(root, "old.sqlite") }, env);
    writeFileSync(configPath, JSON.stringify({ databasePath: "new.sqlite", sourceId: "11111111-1111-4111-8111-111111111111", endpoint: "https://collector.example", tokenFile: "token" }));
    assert.equal(readNativeAccountConfiguration(env)?.databasePath, join(root, "new.sqlite"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
