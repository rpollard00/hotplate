import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverResourceRoots, qualifyResource, readResourceConfiguration, resourceFilesystemId, saveResourceRoots } from "../src/resource-paths.js";

test("root discovery combines account, project ancestors, configuration, and host scope", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-roots-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const project = join(directory, "project");
  const cwd = join(project, "packages", "app");
  const account = join(home, ".agents", "skills");
  const local = join(project, ".claude", "skills");
  const configured = join(directory, "custom");
  const missing = join(directory, "missing");
  for (const path of [cwd, account, local, configured]) mkdirSync(path, { recursive: true });
  const env = { HOME: home, HOTPLATE_RESOURCE_ROOTS: missing, HOTPLATE_FILESYSTEM_ID: "fixture-mount" };
  saveResourceRoots([configured], env);
  const roots = discoverResourceRoots({ cwd, env, advertisedRoots: [local] });
  assert.equal(roots.find((root) => root.path === account)?.scope, "account");
  assert.equal(roots.find((root) => root.path === local)?.origin, "host");
  assert.equal(roots.find((root) => root.path === local)?.scope, "session");
  assert.equal(roots.find((root) => root.path === configured)?.origin, "configured");
  assert.equal(roots.find((root) => root.path === missing)?.origin, "configured");
  assert.equal(roots.some((root) => root.path === join(home, ".codex", "skills")), false);
  assert.ok(roots.every((root) => root.filesystemId === "fixture-mount"));
  assert.equal(resourceFilesystemId(env), "fixture-mount");
});

test("qualification accepts every regular file, infers metadata owners, and excludes neighboring directories", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "skills");
  const marker = join(root, "principle-testing", "SKILL.md");
  const reference = join(root, "principle-testing", "references", "guide.md");
  const hidden = join(root, ".artifacts", "photo.png");
  const script = join(root, "scripts", "check.sh");
  for (const path of [marker, reference, hidden, script]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "Content is never needed for qualification.");
    chmodSync(path, 0o000);
  }
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory }, roots: [root] });
  assert.equal(qualifyResource({ path: marker, cwd: directory, roots })?.kind, "principle");
  const qualified = qualifyResource({ path: reference, cwd: directory, roots });
  assert.equal(qualified?.kind, "reference");
  assert.equal(qualified?.ownerSkillPath, marker);
  assert.equal(qualifyResource({ path: hidden, cwd: directory, roots })?.ownerSkillPath, null);
  assert.equal(qualifyResource({ path: hidden, cwd: directory, roots })?.kind, "file");
  assert.equal(qualifyResource({ path: script, cwd: directory, roots })?.kind, "script");
  assert.equal(qualifyResource({ path: root, cwd: directory, roots }), null);
  assert.equal(qualifyResource({ path: join(directory, "skills-other", "secret.md"), cwd: directory, roots }), null);
  assert.equal(qualifyResource({ path: join(root, "missing.md"), cwd: directory, roots })?.canonicalPath, join(root, "missing.md"));
});

test("immediate skill symlinks qualify physical reads while copies retain separate identities", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, ".agents", "skills");
  const target = join(directory, "checkout");
  const source = join(target, "skill", "SKILL.md");
  const copy = join(root, "copy", "SKILL.md");
  for (const path of [source, copy]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "same bytes");
  }
  symlinkSync(target, join(root, "bundle"), "dir");
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: directory } });
  const physical = qualifyResource({ path: source, cwd: directory, roots });
  const aliasPath = join(root, "bundle", "skill", "SKILL.md");
  const alias = qualifyResource({ path: aliasPath, cwd: directory, roots });
  assert.equal(physical?.canonicalPath, source);
  assert.equal(alias?.canonicalPath, source);
  assert.equal(alias?.observedPath, aliasPath);
  assert.notEqual(qualifyResource({ path: copy, cwd: directory, roots })?.canonicalPath, source);
  assert.equal(qualifyResource({ path: join(root, "bundle", "skill", "missing.md"), cwd: directory, roots })?.canonicalPath, join(target, "skill", "missing.md"));
});

test("resource configuration is strict, persistent, and private", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") };
  const initial = readResourceConfiguration(env);
  assert.deepEqual(initial.roots, []);
  const saved = saveResourceRoots([join(directory, "skills"), join(directory, "skills", ".")], env);
  assert.equal(saved.path, join(env.XDG_CONFIG_HOME, "hotplate", "resources.json"));
  assert.deepEqual(readResourceConfiguration(env).roots, [join(directory, "skills")]);
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(saved.path, "utf8")), { version: 1, roots: [join(directory, "skills")] });
  assert.throws(() => saveResourceRoots(["relative"], env), /Invalid Hotplate resource configuration/u);
  assert.throws(() => readResourceConfiguration({ HOTPLATE_RESOURCES_CONFIG: join(directory, "absent.json") }), /Invalid Hotplate resource configuration/u);
  writeFileSync(saved.path, JSON.stringify({ version: 1, roots: [], explorer: true }));
  assert.throws(() => discoverResourceRoots({ cwd: directory, env }), /Invalid Hotplate resource configuration/u);
});
