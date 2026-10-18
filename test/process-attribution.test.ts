import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findHarnessAncestor, readProcessIdentity, registerHarnessProcess, resolveProcessAttribution, unregisterHarnessProcess } from "../src/process-attribution.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hotplate-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const procRoot = join(root, "proc");
  mkdirSync(join(procRoot, "sys/kernel/random"), { recursive: true });
  writeFileSync(join(procRoot, "sys/kernel/random/boot_id"), "test-boot\n");
  const env = { HOTPLATE_PROCESS_REGISTRY: join(root, "registry") };
  function put(pid: number, parentPid: number, name: string, executable: string, startTicks = String(pid), script?: string): void {
    const path = join(procRoot, String(pid));
    mkdirSync(path, { recursive: true });
    const fields = Array.from({ length: 50 }, () => "0");
    fields[0] = "S";
    fields[1] = String(parentPid);
    fields[19] = startTicks;
    writeFileSync(join(path, "stat"), `${pid} (${name}) ${fields.join(" ")}\n`);
    writeFileSync(join(path, "status"), `Name:\t${name}\nUid:\t${process.getuid?.() ?? 0}\t${process.getuid?.() ?? 0}\t0\t0\n`);
    writeFileSync(join(path, "comm"), `${name}\n`);
    writeFileSync(join(path, "cmdline"), `${executable}\0${script ?? ""}\0PROMPT_SECRET_codex_claude\0`);
    rmSync(join(path, "exe"), { force: true });
    symlinkSync(executable, join(path, "exe"));
  }
  return { root, procRoot, env, put };
}

test("nearest harness registration crosses wrappers without borrowing sibling sessions", (t) => {
  const f = fixture(t);
  f.put(10, 0, "t3code", "/opt/t3code");
  f.put(20, 10, "codex", "/opt/codex");
  f.put(21, 20, "launcher", "/bin/bash");
  f.put(22, 21, "reader)", "/usr/bin/cat");
  f.put(30, 10, "claude", "/home/user/.local/share/claude/versions/2.1.0");
  f.put(31, 30, "sh", "/bin/sh");
  f.put(32, 31, "reader", "/usr/bin/python3");
  const codex = registerHarnessProcess({ ...f, pid: 20, host: "codex", binding: { kind: "dedicated", sessionId: "wrong-single-session", actorId: "actor", projectCwd: f.root }, source: "native-hook" });
  assert.equal(codex?.binding.kind, "shared");
  assert.ok(registerHarnessProcess({ ...f, pid: 30, host: "claude-code", binding: { kind: "dedicated", sessionId: "claude-session", actorId: "claude-session", projectCwd: f.root }, source: "native-hook" }));
  assert.equal(findHarnessAncestor({ host: "codex", pid: 22, procRoot: f.procRoot })?.pid, 20);
  assert.equal(resolveProcessAttribution(readProcessIdentity(22, f), f).host, "codex");
  assert.equal(resolveProcessAttribution(readProcessIdentity(22, f), f).sessionId, null);
  assert.deepEqual(resolveProcessAttribution(readProcessIdentity(32, f), f), { kind: "session", host: "claude-code", sessionId: "claude-session", actorId: "claude-session", projectCwd: f.root });
});

test("Node-hosted Pi is identified before hooks and arbitrary arguments cannot identify a harness", (t) => {
  const f = fixture(t);
  f.put(10, 0, "t3code", "/opt/t3code");
  f.put(20, 10, "MainThread", "/usr/bin/node", "20", "/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  f.put(21, 20, "bash", "/bin/bash");
  f.put(30, 10, "MainThread", "/usr/bin/node", "30", "/tmp/reader.js");
  assert.equal(findHarnessAncestor({ host: "pi", pid: 21, procRoot: f.procRoot })?.pid, 20);
  assert.deepEqual(resolveProcessAttribution(readProcessIdentity(21, f), f), { kind: "harness", host: "pi", sessionId: null, actorId: null, projectCwd: null });
  assert.equal(resolveProcessAttribution(readProcessIdentity(30, f), f).kind, "unknown");
  assert.equal(findHarnessAncestor({ host: "codex", pid: 30, procRoot: f.procRoot }), null);
});

test("an unregistered nested harness does not inherit its outer harness session", (t) => {
  const f = fixture(t);
  f.put(10, 0, "pi", "/usr/bin/node");
  f.put(20, 10, "codex", "/opt/codex");
  f.put(30, 20, "cat", "/usr/bin/cat");
  assert.ok(registerHarnessProcess({ ...f, pid: 10, host: "pi", binding: { kind: "dedicated", sessionId: "outer-pi", actorId: "outer-pi", projectCwd: f.root }, source: "in-process" }));
  assert.deepEqual(resolveProcessAttribution(readProcessIdentity(30, f), f), { kind: "harness", host: "codex", sessionId: null, actorId: null, projectCwd: null });
  assert.equal(findHarnessAncestor({ host: "pi", pid: 30, procRoot: f.procRoot }), null);
});

test("T3 direct loading and unrecognized readers remain unknown rather than non-agent", (t) => {
  const f = fixture(t);
  f.put(10, 0, "t3code", "/opt/t3code");
  f.put(20, 10, "loader", "/usr/bin/node", "20", "/opt/t3code/loader.js");
  assert.equal(resolveProcessAttribution(readProcessIdentity(10, f), f).kind, "unknown");
  assert.equal(resolveProcessAttribution(readProcessIdentity(20, f), f).kind, "unknown");
});

test("multiple dedicated sessions remain ambiguous until a binding is removed", (t) => {
  const f = fixture(t);
  f.put(10, 0, "pi", "/usr/bin/node");
  const base = { ...f, pid: 10, host: "pi" as const, source: "in-process" as const };
  const first = registerHarnessProcess({ ...base, binding: { kind: "dedicated", sessionId: "one", actorId: "one", projectCwd: f.root } });
  const second = registerHarnessProcess({ ...base, binding: { kind: "dedicated", sessionId: "two", actorId: "two", projectCwd: f.root } });
  assert.ok(first);
  assert.ok(second);
  assert.equal(resolveProcessAttribution(readProcessIdentity(10, f), f).sessionId, null);
  unregisterHarnessProcess(second, f);
  assert.equal(resolveProcessAttribution(readProcessIdentity(10, f), f).sessionId, "one");
  const entries = readdirSync(f.env.HOTPLATE_PROCESS_REGISTRY);
  assert.equal(entries.length, 1);
  assert.equal(statSync(f.env.HOTPLATE_PROCESS_REGISTRY).mode & 0o777, 0o700);
  for (const entry of entries) {
    const path = join(f.env.HOTPLATE_PROCESS_REGISTRY, entry);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8").includes("PROMPT_SECRET"), false);
  }
});

test("shared OpenCode runtime never inherits a single observed session", (t) => {
  const f = fixture(t);
  f.put(10, 0, "opencode", "/opt/opencode");
  for (const host of ["opencode-v1", "opencode-v2"] as const) {
    const registration = registerHarnessProcess({ ...f, pid: 10, host, binding: { kind: "dedicated", sessionId: "session", actorId: "session", projectCwd: f.root }, source: "in-process" });
    assert.ok(registration);
    assert.equal(registration.binding.kind, "shared");
    assert.equal(resolveProcessAttribution(readProcessIdentity(10, f), f).sessionId, null);
    unregisterHarnessProcess(registration, f);
  }
  assert.deepEqual(resolveProcessAttribution(readProcessIdentity(10, f), f), { kind: "harness", host: "unknown", sessionId: null, actorId: null, projectCwd: null });
});

test("PID reuse, changed boot and vanished readers do not reuse session attribution", (t) => {
  const f = fixture(t);
  f.put(10, 0, "pi", "/usr/bin/node");
  f.put(20, 10, "cat", "/usr/bin/cat");
  const identity = readProcessIdentity(20, f);
  assert.ok(identity);
  assert.ok(registerHarnessProcess({ ...f, pid: 10, host: "pi", binding: { kind: "dedicated", sessionId: "original", actorId: "original", projectCwd: f.root }, source: "in-process" }));
  f.put(20, 10, "cat", "/usr/bin/cat", "99");
  assert.equal(resolveProcessAttribution(identity, f).kind, "unknown");
  assert.equal(registerHarnessProcess({ ...f, process: identity, host: "pi", binding: { kind: "shared" }, source: "wrapper" }), null);
  f.put(20, 10, "cat", "/usr/bin/cat");
  f.put(10, 0, "pi", "/usr/bin/node", "100");
  assert.equal(resolveProcessAttribution(identity, f).kind, "unknown");
  writeFileSync(join(f.procRoot, "sys/kernel/random/boot_id"), "different-boot\n");
  assert.equal(resolveProcessAttribution(identity, f).kind, "unknown");
  rmSync(join(f.procRoot, "20"), { recursive: true });
  assert.equal(resolveProcessAttribution(identity, f).kind, "unknown");
});

test("an explicit in-process registration resolves a real wrapped reader process", { skip: process.platform !== "linux", timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hotplate-process-live-"));
  const env = { ...process.env, HOTPLATE_PROCESS_REGISTRY: join(root, "registry") };
  const leaf = 'process.stdout.write(JSON.stringify({reader:process.pid,harness:process.ppid})+"\\n");setInterval(()=>{},1000)';
  const harness = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>child.kill());child.on('exit',()=>process.exit());`;
  const wrapper = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(harness)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>child.kill());child.on('exit',()=>process.exit());`;
  const child = spawn(process.execPath, ["-e", wrapper], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; rmSync(root, { recursive: true, force: true }); });
  const output = await once(child.stdout, "data");
  const raw: unknown = JSON.parse(String(output[0]));
  assert.ok(raw && typeof raw === "object" && "reader" in raw && "harness" in raw);
  assert.equal(typeof raw.reader, "number");
  assert.equal(typeof raw.harness, "number");
  if (typeof raw.reader !== "number" || typeof raw.harness !== "number") throw new Error("Invalid process fixture");
  const registration = registerHarnessProcess({ env, pid: raw.harness, host: "pi", binding: { kind: "dedicated", sessionId: "wrapped-live", actorId: "wrapped-live", projectCwd: root }, source: "in-process" });
  assert.ok(registration);
  assert.equal(resolveProcessAttribution(readProcessIdentity(raw.reader), { env }).sessionId, "wrapped-live");
  unregisterHarnessProcess(registration, { env });
});

test("an explicit process registry remains isolated from account registrations", (t) => {
  const f = fixture(t);
  f.put(10, 0, "runtime", "/usr/bin/node", "10", "/tmp/custom-runtime.js");
  const registration = registerHarnessProcess({ ...f, pid: 10, host: "opencode-v1", binding: { kind: "shared" }, source: "in-process" });
  assert.ok(registration);
  const identity = readProcessIdentity(10, f);
  const account = { HOME: f.root, XDG_STATE_HOME: join(f.root, "account-state") };
  assert.equal(resolveProcessAttribution(identity, { procRoot: f.procRoot, env: account }).kind, "unknown");
  assert.equal(resolveProcessAttribution(identity, { procRoot: f.procRoot, env: { ...account, ...f.env, XDG_STATE_HOME: join(f.root, "v1-state") } }).host, "opencode-v1");
});
