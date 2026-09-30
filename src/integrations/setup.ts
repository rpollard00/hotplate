import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NativeHostId } from "../domain.js";
import { readAccountConfiguration, readIngestToken } from "../network-config.js";
import { openCaptureStore } from "../store.js";
import { readRelayStatus } from "../relay.js";
import { changeIntegration, integrationStatus } from "./install.js";
import { readIntegrationSettings, writeIntegrationSettings, resolveEnrolledRelayConfiguration, type IntegrationSettings } from "./native-settings.js";

const serviceName = "hotplate-relay.service";
const ownership = "# Managed by Hotplate setup; relay service v1\n";
type Target = { host: NativeHostId; binary: string; configHome?: string };
type HostReport = { host: NativeHostId; state: "installed" | "skipped" | "error"; detail: string; status: ReturnType<typeof integrationStatus> | null };

export async function probeReceiver(origin: string): Promise<{ reachable: boolean; httpStatus: number | null }> {
  try {
    const response = await fetch(new URL("/health", origin), {
      method: "HEAD", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(2000),
    });
    return { reachable: true, httpStatus: response.status };
  } catch { return { reachable: false, httpStatus: null }; }
}

function runtimeVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 16384 });
  return result.status === 0 ? result.stdout.match(/\bv?(\d+\.\d+\.\d+)\b/u)?.[1] ?? null : null;
}

function withConfigHome<T>(target: Target, action: () => T): T {
  if (!target.configHome) return action();
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = target.configHome;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

function targets(settings: IntegrationSettings): { available: Target[]; reports: HostReport[] } {
  const available: Target[] = [];
  const reports: HostReport[] = [];
  for (const [host, binary] of [["codex", "codex"], ["claude-code", "claude"]] satisfies [NativeHostId, string][]) {
    if (runtimeVersion(binary)) available.push({ host, binary });
    else reports.push({ host, state: "skipped", detail: "Host executable unavailable.", status: null });
  }
  const current = runtimeVersion("opencode");
  const currentMajor = current?.split(".")[0];
  if (currentMajor === "1" || currentMajor === "2") {
    available.push({ host: currentMajor === "1" ? "opencode-v1" : "opencode-v2", binary: "opencode", ...(currentMajor === "1" && settings.opencodeV1ConfigHome ? { configHome: settings.opencodeV1ConfigHome } : {}) });
    if (currentMajor === "1") reports.push({ host: "opencode-v2", state: "skipped", detail: "The default OpenCode executable is v1.", status: null });
  }
  else if (current) reports.push({ host: "opencode-v2", state: "error", detail: "Unsupported OpenCode major version.", status: null });
  else reports.push({ host: "opencode-v2", state: "skipped", detail: "OpenCode executable unavailable.", status: null });
  if (currentMajor !== "1") {
    const binary = settings.opencodeV1Binary ?? "opencode-v1";
    const version = runtimeVersion(binary);
    if (!version) reports.push({ host: "opencode-v1", state: settings.opencodeV1Binary ? "error" : "skipped", detail: "OpenCode v1 executable unavailable.", status: null });
    else if (version.split(".")[0] !== "1") reports.push({ host: "opencode-v1", state: "error", detail: "OpenCode v1 executable has the wrong major version.", status: null });
    else if (!settings.opencodeV1ConfigHome || resolve(settings.opencodeV1ConfigHome) === resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"))) {
      reports.push({ host: "opencode-v1", state: "error", detail: "Use --opencode-v1-config-home with the launcher's separate XDG_CONFIG_HOME.", status: null });
    } else available.push({ host: "opencode-v1", binary, configHome: settings.opencodeV1ConfigHome });
  }
  return { available, reports };
}

function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", serviceName);
}

function unitArgument(value: string, expandDollar = true): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Relay service paths cannot contain control characters.");
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${expandDollar ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

function unitBody(configPath: string, databasePath: string): string {
  return `${ownership}[Unit]\nDescription=Hotplate account relay\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${unitArgument(process.execPath)} ${unitArgument(fileURLToPath(new URL("../cli.js", import.meta.url)))} relay --config ${unitArgument(configPath)}\nEnvironment=${unitArgument(`HOTPLATE_DB=${databasePath}`, false)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=10\n\n[Install]\nWantedBy=default.target\n`;
}

function checkUnitOwnership(path: string): void {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isFile() || !readFileSync(path, "utf8").startsWith(ownership)) throw new Error("An unrelated hotplate-relay.service already exists. Preserve or rename it before setup.");
}

function systemctl(args: readonly string[]): boolean {
  return spawnSync("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 10000 }).status === 0;
}

function serviceState(): { supported: boolean; active: boolean; enabled: boolean } {
  if (process.platform !== "linux") return { supported: false, active: false, enabled: false };
  const supported = systemctl(["show-environment"]);
  return { supported, active: supported && systemctl(["is-active", "--quiet", serviceName]), enabled: supported && systemctl(["is-enabled", "--quiet", serviceName]) };
}

function writeUnit(path: string, body: string): void {
  checkUnitOwnership(path);
  if (existsSync(path) && readFileSync(path, "utf8") === body) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function hostStatus(target: Target): ReturnType<typeof integrationStatus> {
  return withConfigHome(target, () => integrationStatus({ host: target.host, binary: target.binary, cwd: process.cwd(), global: true }));
}

export async function runSetupCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--status") {
    const settings = readIntegrationSettings();
    if (!settings) {
      process.stdout.write(`${JSON.stringify({ configured: false, service: serviceState(), hosts: [], relay: null, receiver: null })}\n`);
      return;
    }
    const configuration = readAccountConfiguration({ path: settings.configPath, env: settings.databasePath ? { ...process.env, HOTPLATE_DB: settings.databasePath } : process.env });
    const discovered = targets(settings);
    const reports = discovered.reports;
    for (const target of discovered.available) {
      try {
        const status = hostStatus(target);
        reports.push({ host: target.host, state: status.installed ? "installed" : "error", detail: status.installed ? "Installed." : "Integration is missing.", status });
      } catch { reports.push({ host: target.host, state: "error", detail: "Cannot inspect integration configuration.", status: null }); }
    }
    process.stdout.write(`${JSON.stringify({ configured: true, configPath: settings.configPath, endpoint: configuration.enrollment.collectorOrigin, hosts: reports, relay: await readRelayStatus({ configuration }), service: serviceState(), receiver: await probeReceiver(configuration.enrollment.collectorOrigin) })}\n`);
    return;
  }
  let configPath: string | undefined;
  let relay: string | undefined;
  let opencodeV1ConfigHome: string | undefined;
  let opencodeV1Binary: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Use setup --config /absolute/account.json or --relay URL, with optional --opencode-v1-config-home and --opencode-v1-binary absolute paths. Use setup --status to inspect.");
    if (flag === "--config" && !configPath && !relay) configPath = value;
    else if (flag === "--relay" && !relay && !configPath) relay = value;
    else if (flag === "--opencode-v1-config-home" && !opencodeV1ConfigHome) opencodeV1ConfigHome = value;
    else if (flag === "--opencode-v1-binary" && !opencodeV1Binary) opencodeV1Binary = value;
    else throw new Error("Invalid setup option.");
  }
  if (relay) configPath = resolveEnrolledRelayConfiguration(relay);
  if (!configPath || !isAbsolute(configPath) || (opencodeV1ConfigHome && !isAbsolute(opencodeV1ConfigHome)) || (opencodeV1Binary && !isAbsolute(opencodeV1Binary))) throw new Error("Setup requires absolute configuration paths.");
  const previous = readIntegrationSettings();
  const v1Home = opencodeV1ConfigHome ?? previous?.opencodeV1ConfigHome;
  const v1Binary = opencodeV1Binary ?? previous?.opencodeV1Binary;
  const settings: IntegrationSettings = {
    configPath,
    ...(v1Home ? { opencodeV1ConfigHome: v1Home } : {}),
    ...(v1Binary ? { opencodeV1Binary: v1Binary } : {}),
  };
  const configuration = readAccountConfiguration({ path: configPath, env: previous?.configPath === configPath && previous.databasePath ? { ...process.env, HOTPLATE_DB: previous.databasePath } : process.env });
  readIngestToken(configuration.tokenFile);
  const path = unitPath();
  const body = unitBody(configPath, configuration.databasePath);
  checkUnitOwnership(path);
  if (process.platform !== "linux" || !systemctl(["show-environment"])) throw new Error("Setup requires an available Linux systemd user manager. Start a user session with systemd and retry.");
  const store = openCaptureStore(configuration);
  await store.close();
  const discovered = targets(settings);
  const reports = discovered.reports;
  for (const target of discovered.available) {
    try {
      withConfigHome(target, () => changeIntegration("install", { host: target.host, binary: target.binary, cwd: process.cwd(), global: true }));
      reports.push({ host: target.host, state: "installed", detail: "Installed.", status: hostStatus(target) });
    } catch { reports.push({ host: target.host, state: "error", detail: "Installation failed. Inspect the host configuration and integration status.", status: null }); }
  }
  writeIntegrationSettings({ ...settings, databasePath: configuration.databasePath });
  writeUnit(path, body);
  const started = systemctl(["daemon-reload"]) && systemctl(["enable", serviceName]) && systemctl(["restart", serviceName]);
  const service = serviceState();
  process.stdout.write(`${JSON.stringify({ configured: true, configPath, endpoint: configuration.enrollment.collectorOrigin, hosts: reports, relay: await readRelayStatus({ configuration }), service, receiver: await probeReceiver(configuration.enrollment.collectorOrigin) })}\n`);
  if (!started || !service.active || !service.enabled || reports.some((report) => report.state === "error")) throw new Error("Setup is incomplete. Inspect the reported host errors and systemd user service state.");
}
