import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeFilesystemScope, startFilesystemObserver, type FilesystemObservation } from "../src/filesystem-observer.js";
import { readProcessIdentity, registerHarnessProcess } from "../src/process-attribution.js";
import { discoverResourceRoots } from "../src/resource-paths.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-observer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "skills");
  mkdirSync(join(path, "sample/references"), { recursive: true });
  writeFileSync(join(path, "sample/SKILL.md"), "PRIVATE_SKILL_CONTENT");
  const resource = join(path, "sample/references/principle.md");
  writeFileSync(resource, "PRIVATE_REFERENCE_CONTENT");
  const env = { ...process.env, HOME: directory, HOTPLATE_PROCESS_REGISTRY: join(directory, "registry") };
  const roots = discoverResourceRoots({ cwd: directory, env, roots: [path], filesystemId: "fixture-fs" });
  function helper(messages: unknown[], tail = "setInterval(()=>{},1000)", setup = "process.once('SIGTERM',()=>process.exit(0));"): string {
    const executable = join(directory, "helper.cjs");
    writeFileSync(executable, `#!${process.execPath}\n${setup}process.stdout.write(${JSON.stringify(messages.map((message) => JSON.stringify(message)).join("\n") + "\n")});${tail}\n`);
    chmodSync(executable, 0o700);
    return executable;
  }
  return { directory, roots, resource, env, helper };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Observer did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("observer emits bounded scoped metadata and stable heartbeats, excluding its own inventory", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const observations: FilesystemObservation[] = [];
  const access = { type: "access", access: "access", process: null, uid: process.getuid?.(), path: f.resource };
  const helperPath = f.helper([
    { type: "ready", scopeVersion: 1 },
    access,
    { ...access, path: `${f.roots[0]?.path}-outside/secret.md` },
    { ...access, uid: (process.getuid?.() ?? 0) + 1 },
    { ...access, process: readProcessIdentity(process.pid) },
    { type: "loss", reason: "queue-overflow" },
  ]);
  const observer = startFilesystemObserver({ ...f, helperPath, heartbeatMs: 100, onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.filter((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "active").length >= 2);
  await observer.stop();
  const accesses = observations.filter((event) => event.evidence.kind === "resource-access");
  assert.equal(accesses.length, 1);
  assert.equal(accesses[0]?.sessionId, null);
  assert.equal(accesses[0]?.host, "unknown");
  assert.equal(accesses[0]?.projectCwd, "[unknown project]");
  assert.equal(accesses[0]?.evidence.kind === "resource-access" && accesses[0].evidence.attribution, "unknown");
  assert.ok(observations.some((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "overflow"));
  const last = observations.at(-1);
  assert.equal(last?.evidence.kind === "observer-coverage" && last.evidence.status, "stopped");
  for (const observation of observations) if (observation.evidence.kind === "observer-coverage") assert.equal(observation.evidence.observerId, observer.observerId);
  assert.equal(JSON.stringify(observations).includes("PRIVATE_"), false);
});

test("observer callback receives a dedicated harness session from a wrapped reader", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const procRoot = join(f.directory, "proc");
  mkdirSync(join(procRoot, "sys/kernel/random"), { recursive: true });
  writeFileSync(join(procRoot, "sys/kernel/random/boot_id"), "test-boot");
  for (const [pid, parent, name, executable] of [[10, 0, "t3code", "/opt/t3code"], [20, 10, "claude", "/opt/claude"], [30, 20, "bash", "/bin/bash"], [40, 30, "cat", "/bin/cat"]] as const) {
    const path = join(procRoot, String(pid));
    mkdirSync(path);
    const fields = Array.from({ length: 50 }, () => "0");
    fields[0] = "S"; fields[1] = String(parent); fields[19] = String(pid);
    writeFileSync(join(path, "stat"), `${pid} (${name}) ${fields.join(" ")}`);
    writeFileSync(join(path, "status"), `Name:\t${name}\nUid:\t${process.getuid?.()}\t${process.getuid?.()}\t0\t0\n`);
    writeFileSync(join(path, "comm"), name);
    symlinkSync(executable, join(path, "exe"));
  }
  assert.ok(registerHarnessProcess({ env: f.env, procRoot, pid: 20, host: "claude-code", source: "native-hook", binding: { kind: "dedicated", sessionId: "native-session", actorId: "native-session", projectCwd: f.directory } }));
  const helperPath = f.helper([{ type: "ready", scopeVersion: 1 }, { type: "access", path: f.resource, access: "access", process: readProcessIdentity(40, { procRoot }), uid: process.getuid?.() }]);
  const observations: FilesystemObservation[] = [];
  const observer = startFilesystemObserver({ ...f, procRoot, helperPath, onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.some((event) => event.evidence.kind === "resource-access"));
  await observer.stop();
  const access = observations.find((event) => event.evidence.kind === "resource-access");
  assert.equal(access?.host, "claude-code");
  assert.equal(access?.sessionId, "native-session");
  assert.equal(access?.projectCwd, f.directory);
});

test("graceful shutdown drains the helper's final access before recording stopped coverage", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const observations: FilesystemObservation[] = [];
  const access = { type: "access", access: "access", process: null, uid: process.getuid?.(), path: f.resource };
  const helperPath = f.helper([{ type: "ready", scopeVersion: 1 }], undefined, `process.once('SIGTERM',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(access) + "\n")},()=>process.exit(0));});`);
  const observer = startFilesystemObserver({ ...f, helperPath, onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.some((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "active"));
  await observer.stop();
  assert.equal(observations.filter(event => event.evidence.kind === "resource-access").length, 1);
  const last = observations.at(-1);
  assert.equal(last?.evidence.kind === "observer-coverage" && last.evidence.status, "stopped");
});

test("missing roots remain unavailable while existing roots continue to be observed", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const missing = join(f.directory, "missing-skills");
  const roots = discoverResourceRoots({ cwd: f.directory, env: f.env, roots: [...f.roots.map(root => root.path), missing], filesystemId: "fixture-fs" });
  const observations: FilesystemObservation[] = [];
  const observer = startFilesystemObserver({ ...f, roots, helperPath: f.helper([{ type: "ready", scopeVersion: 1 }]), onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.some((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "active"));
  await observer.stop();
  assert.ok(observations.some((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable" && event.evidence.rootPaths.includes(missing)));
  assert.ok(observations.every((event) => event.evidence.kind !== "observer-coverage" || event.evidence.status === "unavailable" || !event.evidence.rootPaths.includes(missing)));
});

test("symlink root coverage uses the same physical root identity as inventory", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const alias = join(f.directory, "installed-skills");
  const root = f.roots[0];
  assert.ok(root);
  symlinkSync(root.path, alias);
  const observations: FilesystemObservation[] = [];
  const observer = startFilesystemObserver({ ...f, roots: discoverResourceRoots({ cwd: f.directory, env: f.env, roots: [alias], filesystemId: "fixture-fs" }), helperPath: f.helper([{ type: "ready", scopeVersion: 1 }]), onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.length > 0);
  await observer.stop();
  for (const observation of observations) {
    assert.equal(observation.projectCwd, "[unknown project]");
    if (observation.evidence.kind === "observer-coverage") assert.deepEqual(observation.evidence.rootPaths, [root.canonicalPath]);
  }
});

test("malformed or overlong helper streams fail coverage without retaining their payload", { skip: process.platform !== "linux" }, async (t) => {
  for (const content of ["INVALID_SECRET_PAYLOAD", "x".repeat(40_000)]) {
    await t.test(`reject ${content.length} bytes`, async (subtest) => {
      const f = fixture(subtest);
      const helperPath = f.helper([{ type: "ready", scopeVersion: 1 }], `process.stdout.write(${JSON.stringify(`${content}\n`)});setInterval(()=>{},1000)`);
      const observations: FilesystemObservation[] = [];
      const observer = startFilesystemObserver({ ...f, helperPath, onObservation: (event) => { observations.push(event); } });
      await observer.done;
      assert.equal(JSON.stringify(observations).includes("INVALID_SECRET_PAYLOAD"), false);
      assert.ok(observations.some((event) => event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable" && event.evidence.reason === "io-error"));
    });
  }
});

test("unacknowledged, old, or unavailable helpers cannot emit access evidence", { skip: process.platform !== "linux" }, async t => {
  for (const prefix of [[], [{ type: "ready" }], [{ type: "ready", scopeVersion: 2 }], [{ type: "ready", scopeVersion: 1 }, { type: "unavailable", reason: "io-error" }]]) {
    const f = fixture(t);
    const observations: FilesystemObservation[] = [];
    const access = { type: "access", access: "access", process: null, uid: process.getuid?.(), path: f.resource };
    const observer = startFilesystemObserver({ ...f, helperPath: f.helper([...prefix, access, { type: "ready", scopeVersion: 1 }, access]), onObservation: event => { observations.push(event); } });
    await observer.done;
    assert.equal(observations.filter(event => event.evidence.kind === "resource-access").length, 0);
    assert.ok(observations.some(event => event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable"));
  }
});

test("observer rechecks exclusions and rejects copied or retargeted roots", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const root = f.roots[0];
  assert.ok(root);
  for (const suffix of ["sample/.git/config", "sample/.jj/repo", "sample/node_modules/dependency/SKILL.md", "sample/.artifacts/kept.md"]) {
    const path = join(root.path, suffix);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  }
  const observations: FilesystemObservation[] = [];
  const messages = [f.resource, ...["sample/.git/config", "sample/.jj/repo", "sample/node_modules/dependency/SKILL.md", "sample/.artifacts/kept.md"].map(path => join(root.path, path))]
    .map(path => ({ type: "access", access: "access", process: null, uid: process.getuid?.(), path }));
  const observer = startFilesystemObserver({ ...f, helperPath: f.helper([{ type: "ready", scopeVersion: 1 }, ...messages]), onObservation: event => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.filter(event => event.evidence.kind === "resource-access").length === 2);
  await observer.stop();
  const invalid: FilesystemObservation[] = [];
  const copied = startFilesystemObserver({ ...f, roots: [{ ...root }], helperPath: join(f.directory, "not-started"), onObservation: event => { invalid.push(event); } });
  await copied.done;
  assert.ok(invalid.every(event => event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable"));
  assert.throws(() => encodeFilesystemScope([{ ...root }]), /no longer admitted/u);
  const alias = join(f.directory, "alias");
  symlinkSync(root.path, alias);
  const aliasedRoots = discoverResourceRoots({ cwd: f.directory, env: f.env, roots: [alias] });
  unlinkSync(alias);
  symlinkSync(f.directory, alias);
  assert.throws(() => encodeFilesystemScope(aliasedRoots), /no longer admitted/u);
  assert.throws(() => encodeFilesystemScope(Array.from({ length: 1025 }, () => root)), /root count/u);
});

test("an old helper that exits without reading policy cannot cause an unhandled stdin error", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t);
  const observations: FilesystemObservation[] = [];
  const observer = startFilesystemObserver({ ...f, roots: Array.from({ length: 1024 }, () => f.roots).flat(),
    helperPath: f.helper([], "process.exit(2)", ""), onObservation: event => { observations.push(event); } });
  await observer.done;
  assert.equal(observations.filter(event => event.evidence.kind === "resource-access").length, 0);
  assert.ok(observations.some(event => event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable"));
});

test("callback rejection stops observation and reaches the coordinator through done", { skip: process.platform !== "linux" }, async (t) => {
  const f = fixture(t);
  const observer = startFilesystemObserver({ ...f, helperPath: f.helper([{ type: "ready", scopeVersion: 1 }]), onObservation: () => { throw new Error("fixture persistence failed"); } });
  await assert.rejects(observer.done, /fixture persistence failed/u);
  await assert.rejects(observer.stop(), /fixture persistence failed/u);
});

test("a persistence failure drains paused helper output and still terminates", { skip: process.platform !== "linux", timeout: 5000 }, async (t) => {
  const f = fixture(t);
  const messages = [{ type: "ready", scopeVersion: 1 }, ...Array.from({ length: 700 }, () => ({ type: "access", access: "access", path: f.resource, process: null, uid: process.getuid?.() }))];
  const observer = startFilesystemObserver({ ...f, helperPath: f.helper(messages), onObservation: async (event) => {
    if (event.evidence.kind === "resource-access") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("backpressured persistence failed");
    }
  } });
  await assert.rejects(observer.done, /backpressured persistence failed/u);
});

test("missing helper, denied permission and unexpected exit leave explicit unavailable coverage", { skip: process.platform !== "linux" }, async (t) => {
  for (const expected of ["helper-unavailable", "permission-denied", "process-exited"] as const) {
    await t.test(expected, async (subtest) => {
      const f = fixture(subtest);
      const helperPath = expected === "helper-unavailable" ? join(f.directory, "missing") : f.helper(expected === "permission-denied" ? [{ type: "unavailable", reason: expected }] : [{ type: "ready", scopeVersion: 1 }], "");
      const observations: FilesystemObservation[] = [];
      const observer = startFilesystemObserver({ ...f, helperPath, onObservation: (event) => { observations.push(event); } });
      await observer.done;
      await observer.stop();
      const last = observations.at(-1);
      assert.equal(last?.evidence.kind === "observer-coverage" && last.evidence.status, "unavailable");
      assert.equal(last?.evidence.kind === "observer-coverage" && last.evidence.reason, expected);
    });
  }
});

test("native helper compiles and reports actual kernel availability", { skip: process.platform !== "linux", timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  const helperPath = join(f.directory, "hotplate-fanotify");
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", join(process.cwd(), "native/fanotify.c"), "-o", helperPath]);
  if (process.getuid?.() !== 0) {
    const differentUser = spawnSync(helperPath, ["--uid", String((process.getuid?.() ?? 0) + 1)], { input: encodeFilesystemScope(f.roots), encoding: "utf8", timeout: 1000 });
    assert.equal(differentUser.status, 2);
    assert.deepEqual(JSON.parse(differentUser.stdout), { type: "unavailable", reason: "io-error" });
  }
  const observations: FilesystemObservation[] = [];
  const observer = startFilesystemObserver({ ...f, helperPath, onObservation: (event) => { observations.push(event); } });
  t.after(() => observer.stop());
  await until(() => observations.length > 0);
  const first = observations[0]?.evidence;
  assert.equal(first?.kind, "observer-coverage");
  if (first?.kind === "observer-coverage" && first.status === "unavailable") {
    assert.equal(first.reason, "permission-denied");
    await observer.done;
    const fileRoots = discoverResourceRoots({ cwd: f.directory, env: f.env, roots: [f.resource] });
    const fileRoot = spawnSync(helperPath, ["--uid", String(process.getuid?.())], { input: encodeFilesystemScope(fileRoots), encoding: "utf8", timeout: 1000 });
    assert.deepEqual(JSON.parse(fileRoot.stdout), { type: "unavailable", reason: "permission-denied" });
    t.diagnostic("CAP_SYS_ADMIN is unavailable: verified honest EPERM coverage; privileged read attribution remains unverified.");
    return;
  }
  const reader = spawn(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1]);setTimeout(()=>{},1000)", f.resource], { stdio: "ignore" });
  t.after(() => { reader.kill(); });
  await until(() => observations.some((event) => event.evidence.kind === "resource-access" && event.evidence.resource.canonicalPath === f.resource));
  const exited = once(reader, "close");
  reader.kill();
  await exited;
  await observer.stop();
  assert.ok(observations.some((event) => event.evidence.kind === "resource-access" && event.evidence.process?.pid === reader.pid));
});
