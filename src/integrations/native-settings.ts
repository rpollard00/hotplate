import { parseCollectorOrigin } from "../observation.js";
import { readAccountConfiguration } from "../network-config.js";
import { resolveHotplateDatabasePath } from "../store.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type IntegrationSettings = {
  configPath: string;
  databasePath?: string;
  opencodeV1ConfigHome?: string;
  opencodeV1Binary?: string;
};

export function integrationSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HOTPLATE_INTEGRATION_SETTINGS;
  if (override !== undefined && !override.trim()) throw new Error("Invalid Hotplate integration settings path.");
  return override === undefined ? join(homedir(), ".config", "hotplate", "integrations.json") : resolve(override);
}

function parseSettings(value: unknown): IntegrationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["configPath", "databasePath", "opencodeV1ConfigHome", "opencodeV1Binary"].includes(key))) throw new Error();
  if (typeof record.configPath !== "string" || !isAbsolute(record.configPath)) throw new Error();
  const settings: IntegrationSettings = { configPath: record.configPath };
  for (const key of ["databasePath", "opencodeV1ConfigHome", "opencodeV1Binary"] as const) {
    const entry = record[key];
    if (entry !== undefined) {
      if (typeof entry !== "string" || !isAbsolute(entry)) throw new Error();
      settings[key] = entry;
    }
  }
  return settings;
}

export function readIntegrationSettings(env: NodeJS.ProcessEnv = process.env): IntegrationSettings | null {
  const path = integrationSettingsPath(env);
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).size > 16384) throw new Error();
    return parseSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch { throw new Error("Invalid Hotplate integration settings. Run hotplate setup with a valid account configuration."); }
}

export function writeIntegrationSettings(settings: IntegrationSettings, env: NodeJS.ProcessEnv = process.env): void {
  const body = `${JSON.stringify(parseSettings(settings), null, 2)}\n`;
  const path = integrationSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function nativeAccountConfig(env: NodeJS.ProcessEnv): string | undefined {
  if (env.HOTPLATE_CONFIG !== undefined) return env.HOTPLATE_CONFIG;
  if (env.HOTPLATE_DB?.trim()) return undefined;
  return readIntegrationSettings(env)?.configPath;
}

export function resolveEnrolledRelayConfiguration(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  const canonical = parseCollectorOrigin(origin);
  const root = dirname(resolveHotplateDatabasePath({ env: { ...env, HOTPLATE_DB: "" } }));
  const path = join(root, "connections", createHash("sha256").update(canonical).digest("hex"), "account.json");
  if (!existsSync(path)) throw new Error("This relay has no enrolled account. Connect it in Pi first, or use setup --config with an enrolled account configuration.");
  const configuration = readAccountConfiguration({ path, env });
  if (configuration.enrollment.collectorOrigin !== canonical) throw new Error("Enrolled relay configuration does not match the requested origin.");
  return path;
}

export function readNativeAccountConfiguration(env: NodeJS.ProcessEnv) {
  if (env.HOTPLATE_CONFIG !== undefined) {
    if (!env.HOTPLATE_CONFIG.trim()) throw new Error("Invalid account configuration");
    return readAccountConfiguration({ path: env.HOTPLATE_CONFIG, env });
  }
  if (env.HOTPLATE_DB?.trim()) return null;
  const settings = readIntegrationSettings(env);
  if (!settings) return null;
  return readAccountConfiguration({ path: settings.configPath, env: settings.databasePath ? { ...env, HOTPLATE_DB: settings.databasePath } : env });
}
