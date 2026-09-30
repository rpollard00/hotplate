#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openHotplateStore, type Observation } from "./index.js";
import { startDashboardServer } from "./server.js";
import { readAccountConfiguration, readAggregationConfiguration } from "./network-config.js";
import { readRelayStatus, runRelay } from "./relay.js";
import { startAggregationServer } from "./aggregation.js";

type ServeArgs = {
  command: "serve";
  databasePath?: string;
  host?: string;
  port?: number;
};

type DemoArgs = {
  command: "demo";
  databasePath: string;
  force: boolean;
};

type NetworkArgs = { command: "relay"; configPath: string; status: boolean } | { command: "aggregate"; configPath: string };
type CliArgs = ServeArgs | DemoArgs | NetworkArgs | { command: "help" };

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "setup") {
    const { runSetupCommand } = await import("./integrations/setup.js");
    await runSetupCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "capture") {
    const { runCaptureCommand } = await import("./integrations/command.js");
    await runCaptureCommand(argv.length === 2 ? argv[1] : undefined);
    return;
  }
  if (argv[0] === "integration") {
    const { runIntegrationCommand } = await import("./integrations/install.js");
    runIntegrationCommand(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);
  if (args.command === "help") {
    process.stdout.write(helpText());
    return;
  }

  if (args.command === "demo") {
    await seedDemoDatabase({ databasePath: args.databasePath, force: args.force });
    process.stdout.write(`Seeded Hotplate demo database at ${args.databasePath}\n`);
    return;
  }

  if (args.command === "relay" || args.command === "aggregate") {
    await runNetworkCommand(args);
    return;
  }

  const serverOptions: { databasePath?: string; host?: string; port?: number } = {};
  if (args.databasePath !== undefined) serverOptions.databasePath = args.databasePath;
  if (args.host !== undefined) serverOptions.host = args.host;
  if (args.port !== undefined) serverOptions.port = args.port;
  const running = await startDashboardServer(serverOptions);
  process.stdout.write(`Hotplate dashboard: ${running.url}\n`);
  process.stdout.write(`Database: ${running.databasePath}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");

  const stop = async (): Promise<void> => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

async function runNetworkCommand(args: NetworkArgs): Promise<void> {
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (args.command === "relay") {
      const configuration = readAccountConfiguration({ path: args.configPath });
      if (args.status) {
        const status = await readRelayStatus({ configuration });
        process.stdout.write(`${JSON.stringify(status)}\n`);
        process.stderr.write("Pending bytes count payloads only. The retained backlog has no size limit or automatic eviction. Monitor disk space.\n");
      } else {
        await runRelay({ configuration, signal: abort.signal });
      }
    } else {
      const configuration = readAggregationConfiguration({ path: args.configPath });
      const running = await startAggregationServer({ configuration });
      try {
        process.stdout.write(`Hotplate aggregate: ${running.url}\n`);
        if (!abort.signal.aborted) await new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally { await running.close(); }
    }
  } catch {
    throw new Error(`Hotplate ${args.command} stopped. Check the configuration, credentials, database binding, and listener. Pending deliveries remain retained.`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function seedDemoDatabase(options: { databasePath: string; force?: boolean }): Promise<void> {
  if (options.databasePath === ":memory:") {
    throw new Error("Demo database path must be a file path");
  }
  const databasePath = resolve(options.databasePath);
  if (existsSync(databasePath)) {
    if (!options.force) {
      throw new Error("Demo database already exists. Pass --force to replace the explicit demo path.");
    }
    unlinkSync(databasePath);
    unlinkIfExists(`${databasePath}-wal`);
    unlinkIfExists(`${databasePath}-shm`);
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  const store = openHotplateStore({ databasePath });
  try {
    const result = await store.record(demoObservations());
    if (result.dropped > 0) {
      throw new Error(`Demo seed dropped ${result.dropped} observations`);
    }
  } finally {
    await store.close();
  }
}

function demoObservations(): readonly Observation[] {
  const projectA = "/demo/hotplate-alpha";
  const projectB = "/demo/hotplate-beta";
  return [
    observation("demo-001", 1, projectA, "session-a", "segment-a", "run-a", "turn-1", {
      kind: "catalog-snapshot",
      skills: [skill("plan"), skill("typescript"), skill("unused-catalog"), skill("<script>alert(1)</script>")],
    }),
    observation("demo-002", 2, projectA, "session-a", "segment-a", "run-a", "turn-1", {
      kind: "command-intent",
      skillName: "plan",
      source: "interactive",
    }),
    observation("demo-003", 3, projectA, "session-a", "segment-a", "run-a", "turn-1", {
      kind: "wrapper-observed",
      skill: skill("plan"),
      wrapperSource: "expanded-prompt",
    }),
    observation("demo-004", 4, projectA, "session-a", "segment-a", "run-a", "turn-2", {
      kind: "read-result",
      skill: skill("typescript"),
      toolCallId: "tool-1",
      outcome: "success",
      model: { provider: "openai", id: "gpt-4.1" },
    }),
    observation("demo-005", 5, projectA, "session-a", "segment-a", "run-a", "turn-2", {
      kind: "wrapper-observed",
      skill: skill("<script>alert(1)</script>"),
      wrapperSource: "unknown-pasted-or-transformed",
    }),
    observation("demo-006", 6, projectA, "session-a", "segment-a", "run-a", "turn-3", {
      kind: "read-result",
      skill: skill("plan"),
      toolCallId: "tool-2",
      outcome: "error",
      model: { provider: "anthropic", id: "claude-sonnet-4" },
    }),
    observation("demo-007", 7, projectA, "session-a", "segment-a", "run-a", "turn-3", {
      kind: "capture-gap",
      dropped: 2,
      reason: "queue-overflow",
    }),
    observation("demo-008", 8, projectA, "session-a", "segment-a", "run-b", "turn-1", {
      kind: "command-intent",
      skillName: "typescript",
      source: "rpc",
    }),
    observation("demo-009", 9, projectA, "session-a", "segment-a", "run-b", "turn-1", {
      kind: "read-result",
      skill: skill("typescript"),
      toolCallId: "tool-3",
      outcome: "success",
      model: { provider: "openai", id: "gpt-4.1-mini" },
    }),
    observation("demo-010", 10, projectB, "session-b", "segment-b", "run-c", "turn-1", {
      kind: "catalog-snapshot",
      skills: [skill("review"), skill("unused-catalog")],
    }),
    observation("demo-011", 11, projectB, "session-b", "segment-b", "run-c", "turn-1", {
      kind: "command-intent",
      skillName: "review",
      source: "extension",
    }),
    observation("demo-012", 12, projectB, "session-b", "segment-b", "run-c", "turn-2", {
      kind: "read-result",
      skill: skill("review"),
      toolCallId: "tool-4",
      outcome: "success",
      model: null,
    }),
  ];
}

function observation(id: string, sequence: number, projectCwd: string, sessionId: string, segmentId: string, runId: string, turnId: string, evidence: Observation["evidence"]): Observation {
  return {
    id,
    producerId: "hotplate-demo",
    sequence,
    observedAt: new Date(Date.UTC(2026, 0, 1, 12, sequence, 0)).toISOString(),
    scope: {
      projectCwd,
      sessionId,
      sessionFile: `/demo/sessions/${sessionId}.jsonl`,
      segmentId,
      segmentReason: "startup",
      runId,
      turnId,
      leafId: `leaf-${turnId}`,
    },
    evidence,
  };
}

function skill(name: string): { name: string; canonicalPath: string; version: string } {
  return { name, canonicalPath: `/demo/skills/${encodeURIComponent(name)}/SKILL.md`, version: "demo-v1" };
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const [command = "serve", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command === "serve") {
    return parseServeArgs(rest);
  }
  if (command === "demo") {
    return parseDemoArgs(rest);
  }
  if (command === "relay" || command === "aggregate") return parseNetworkArgs(command, rest);
  throw new Error("Unknown command. Run hotplate help.");
}

function parseNetworkArgs(command: "relay" | "aggregate", argv: readonly string[]): NetworkArgs {
  let configPath: string | undefined;
  let status = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" && configPath === undefined) configPath = requireNext(argv, index += 1, "--config");
    else if (value === "--status" && command === "relay" && !status) status = true;
    else throw new Error("Invalid network command options. Use --config <path> and, for relay status only, --status.");
  }
  if (!configPath || configPath.startsWith("--")) throw new Error("Network commands require --config <path>.");
  return command === "relay" ? { command, configPath, status } : { command, configPath };
}

function parseServeArgs(argv: readonly string[]): ServeArgs {
  const args: ServeArgs = { command: "serve" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--db") args.databasePath = requireNext(argv, index += 1, "--db");
    else if (value === "--host") args.host = requireNext(argv, index += 1, "--host");
    else if (value === "--port") args.port = parsePort(requireNext(argv, index += 1, "--port"));
    else throw new Error(`Unknown serve option ${value}`);
  }
  return args;
}

function parseDemoArgs(argv: readonly string[]): DemoArgs {
  let databasePath: string | null = null;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--db") databasePath = requireNext(argv, index += 1, "--db");
    else if (value === "--force") force = true;
    else throw new Error(`Unknown demo option ${value}`);
  }
  if (databasePath === null) {
    throw new Error("Demo command requires --db <path>");
  }
  return { command: "demo", databasePath: resolve(databasePath), force };
}

function requireNext(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port ${value}`);
  }
  return port;
}

function helpText(): string {
  return `Hotplate dashboard\n\nUsage:\n  hotplate serve [--db path] [--host 127.0.0.1] [--port 7345]\n  hotplate demo --db path [--force]\n  hotplate relay --config path [--status]\n  hotplate aggregate --config path\n  hotplate setup (--relay URL | --config path) [--opencode-v1-config-home path] [--opencode-v1-binary path]\n  hotplate setup --status\n  hotplate integration install|remove|status [codex|claude-code|opencode-v1|opencode-v2] [--global] [--binary path]\n  hotplate capture <host> < native-hook.json\n\nRelay status reports enrollment, pending count/bytes/oldest time, and blocked count without delivery.\nNetwork commands require explicit configuration. Native capture uses the account selected by setup. HOTPLATE_CONFIG overrides setup; HOTPLATE_DB selects local capture when HOTPLATE_CONFIG is unset. Without setup, native capture stays local.\nThe serve command opens a loopback-only, read-only dashboard.\nThe demo command writes only to the explicit --db path.\n`;
}

if (isCliEntrypoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
