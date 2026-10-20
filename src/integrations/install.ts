import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { NativeHostId } from "../domain.js";
import { nativeHost } from "./command.js";
import { object } from "./common.js";

type Options = { host: NativeHostId; cwd: string; global?: boolean; binary?: string };
const hosts: readonly NativeHostId[] = ["codex", "claude-code", "opencode-v1", "opencode-v2"];

function paths(options: Options): { path: string; jsonc: string | null } {
  const root = options.global ? homedir() : resolve(options.cwd);
  if (options.host === "codex") return { path: join(options.global ? process.env.CODEX_HOME ?? join(root, ".codex") : join(root, ".codex"), "hooks.json"), jsonc: null };
  if (options.host === "claude-code") return { path: join(options.global ? process.env.CLAUDE_CONFIG_DIR ?? join(root, ".claude") : join(root, ".claude"), options.global ? "settings.json" : "settings.local.json"), jsonc: null };
  const directory = options.global ? join(process.env.XDG_CONFIG_HOME ?? join(root, ".config"), "opencode") : root;
  return { path: join(directory, "opencode.json"), jsonc: join(directory, "opencode.jsonc") };
}

function configuration(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = object(JSON.parse(readFileSync(path, "utf8")));
    if (value) return value;
  } catch {}
  throw new Error("Invalid integration configuration. Repair the JSON before changing this integration.");
}

function command(host: NativeHostId): string {
  if (process.platform === "win32") throw new Error("Native hook installation currently requires a POSIX shell.");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} ${quote(fileURLToPath(new URL("../cli.js", import.meta.url)))} capture ${host}`;
}

function plugin(host: NativeHostId): string {
  return new URL(host === "opencode-v1" ? "./opencode/v1-entry.js" : "./opencode/v2-entry.js", import.meta.url).href;
}

function openCodeV2Wrapper(options: Options): { path: string; content: string } {
  const directory = options.global
    ? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "plugins")
    : join(resolve(options.cwd), ".opencode", "plugins");
  return { path: join(directory, "hotplate.js"), content: `export { default } from ${JSON.stringify(plugin("opencode-v2"))};\n` };
}

function version(options: Options): string | null {
  const binary = options.binary ?? (options.host === "claude-code" ? "claude" : options.host.startsWith("opencode") ? "opencode" : "codex");
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 3000, maxBuffer: 16384 });
  return result.status === 0 ? result.stdout.match(/\bv?(\d+\.\d+\.\d+)\b/u)?.[1] ?? null : null;
}

function mutate(value: Record<string, unknown>, host: NativeHostId, install: boolean): { value: Record<string, unknown>; installed: boolean } {
  if (host.startsWith("opencode")) {
    const key = host === "opencode-v1" ? "plugin" : "plugins";
    const other = key === "plugin" ? "plugins" : "plugin";
    if (install && value[other] !== undefined) throw new Error("OpenCode configuration uses the other major version. Use a separate project or migrate its configuration first.");
    const entries = value[key] ?? [];
    if (!Array.isArray(entries)) throw new Error("Invalid OpenCode plugin configuration.");
    const entry = plugin(host);
    const installed = entries.includes(entry);
    const kept = entries.filter((item: unknown) => item !== entry);
    return { value: { ...value, [key]: install ? [...kept, entry] : kept }, installed };
  }
  const hookMap = value.hooks === undefined ? {} : object(value.hooks);
  if (!hookMap) throw new Error("Invalid native hook configuration.");
  const owned = command(host);
  const next = { ...hookMap };
  let installed = false;
  const events = host === "codex" ? ["PostToolUse"] : ["PostToolUse", "PostToolUseFailure"];
  for (const event of events) {
    const entries = next[event] ?? [];
    if (!Array.isArray(entries)) throw new Error("Invalid native hook event configuration.");
    const kept: unknown[] = [];
    for (const entry of entries) {
      const group = object(entry);
      if (!group || !Array.isArray(group.hooks)) throw new Error("Invalid native hook group configuration.");
      const remaining = group.hooks.filter((handler: unknown) => {
        const item = object(handler);
        const ours = item?.type === "command" && item.command === owned;
        if (ours) installed = true;
        return !ours;
      });
      if (remaining.length || group.hooks.length === 0) kept.push({ ...group, hooks: remaining });
    }
    if (install) kept.push({ matcher: ".*", hooks: [{ type: "command", command: owned, timeout: 2 }] });
    next[event] = kept;
  }
  return { value: { ...value, hooks: next }, installed };
}

export function integrationStatus(options: Options) {
  const location = paths(options);
  const current = configuration(location.path);
  const wrapper = options.host === "opencode-v2" ? openCodeV2Wrapper(options) : null;
  const installed = wrapper
    ? existsSync(wrapper.path) && readFileSync(wrapper.path, "utf8") === wrapper.content
    : mutate(current, options.host, false).installed;
  return {
    host: options.host, configurationPath: wrapper?.path ?? location.path, installed, version: version(options),
    jsoncPresent: location.jsonc !== null && existsSync(location.jsonc),
    coverage: options.host === "codex" ? "literal shell and Python read attempts; shell outcome unavailable; opaque execution coverage; automatic session inventory" : options.host === "claude-code" ? "Read and Skill success and failure; literal shell and Python read attempts; opaque execution coverage; automatic session inventory" : "native reads and skills; literal shell and Python inferred reads with verified exit status; opaque execution coverage; automatic session inventory",
    trust: options.host === "codex" ? "Review and trust the installed definition with /hooks before capture can run." : null,
    lastSuccessfulCapture: null,
  };
}

export function changeIntegration(action: "install" | "remove", options: Options): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 19)) throw new Error("Hotplate integrations require Node 24.19 or newer.");
  const location = paths(options);
  if (location.jsonc && existsSync(location.jsonc)) throw new Error("OpenCode JSONC configuration exists. Automatic changes are refused to preserve comments and configuration precedence.");
  if (action === "install") {
    const found = version(options);
    if (!found) throw new Error("Host runtime unavailable. Install it or provide --binary with its executable path.");
    if (options.host.startsWith("opencode") && Number(found.split(".")[0]) !== (options.host === "opencode-v1" ? 1 : 2)) throw new Error("OpenCode executable has the wrong major version. Select the matching integration or provide --binary.");
  }
  const current = configuration(location.path);
  if (action === "install" && options.host === "opencode-v1" && existsSync(openCodeV2Wrapper(options).path)) throw new Error("OpenCode configuration uses the other major version. Remove its Hotplate plugin first.");
  if (options.host === "opencode-v2") {
    if (action === "install" && current.plugin !== undefined) throw new Error("OpenCode configuration uses the other major version. Use a separate project or migrate its configuration first.");
    const wrapper = openCodeV2Wrapper(options);
    if (existsSync(wrapper.path)) {
      if (readFileSync(wrapper.path, "utf8") !== wrapper.content) throw new Error("The OpenCode plugin file already exists and is not owned by this installation.");
      if (action === "remove") unlinkSync(wrapper.path);
      return;
    }
    if (action === "remove") return;
    mkdirSync(dirname(wrapper.path), { recursive: true });
    writeFileSync(wrapper.path, wrapper.content, { flag: "wx", mode: 0o600 });
    return;
  }
  const changed = mutate(current, options.host, action === "install");
  if (action === "remove" && !changed.installed) return;
  const body = `${JSON.stringify(changed.value, null, 2)}\n`;
  if (existsSync(location.path) && readFileSync(location.path, "utf8") === body) return;
  mkdirSync(dirname(location.path), { recursive: true });
  const temporary = `${location.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    renameSync(temporary, location.path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function runIntegrationCommand(args: readonly string[]): void {
  const [action, ...rest] = args;
  const target = rest[0]?.startsWith("--") ? undefined : rest[0];
  const flags = target === undefined ? rest : rest.slice(1);
  if (action !== "install" && action !== "remove" && action !== "status") throw new Error("Use integration install|remove|status <host> [--global] [--binary path].");
  const host = nativeHost(target);
  if (target !== undefined && !host) throw new Error("Unknown integration host.");
  if (!host && action !== "status") throw new Error("An integration host is required.");
  let global = false;
  let binary: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === "--global" && !global) global = true;
    else if (flags[index] === "--binary" && !binary && flags[index + 1]) binary = flags[++index];
    else throw new Error("Invalid integration command options.");
  }
  for (const selected of host ? [host] : hosts) {
    const options: Options = { host: selected, cwd: process.cwd(), global, ...(binary ? { binary } : {}) };
    if (action !== "status") changeIntegration(action, options);
    process.stdout.write(`${JSON.stringify(integrationStatus(options))}\n`);
  }
}
