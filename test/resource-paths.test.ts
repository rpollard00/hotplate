import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { admitResourcePath, canonicalResourcePath, discoverResourceRoots, narrowResourceRoot, qualifyResource, readResourceConfiguration, resourceFilesystemId, saveResourceRoots, type ResourceAdvertisement, type ResourceDiagnostic, type ResourceHost } from "../src/resource-paths.js";

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
  const roots = discoverResourceRoots({ cwd, env, advertisements: [{ kind: "collection", path: local, host: "claude-code", sessionId: "session", source: "host-configuration" }] });
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
  assert.equal(saved.path, join(directory, ".config", "hotplate", "resources.json"));
  assert.deepEqual(readResourceConfiguration(env).roots, [join(directory, "skills")]);
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(saved.path, "utf8")), { version: 1, roots: [join(directory, "skills")] });
  assert.throws(() => saveResourceRoots(["relative"], env), /Invalid Hotplate resource configuration/u);
  assert.throws(() => readResourceConfiguration({ HOTPLATE_RESOURCES_CONFIG: join(directory, "absent.json") }), /Invalid Hotplate resource configuration/u);
  writeFileSync(saved.path, JSON.stringify({ version: 1, roots: [], explorer: true }));
  assert.throws(() => discoverResourceRoots({ cwd: directory, env }), /Invalid Hotplate resource configuration/u);
});

test("explicit resource configuration remains isolated from account roots", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-resource-config-isolated-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { HOME: directory, XDG_CONFIG_HOME: join(directory, "account-xdg") };
  const isolated = { ...account, HOTPLATE_RESOURCES_CONFIG: join(directory, "isolated", "resources.json"), XDG_CONFIG_HOME: join(directory, "harness-xdg") };
  const sharedRoot = join(directory, "shared-skills");
  const isolatedRoot = join(directory, "isolated-skills");
  saveResourceRoots([sharedRoot], account);
  assert.equal(saveResourceRoots([isolatedRoot], isolated).path, isolated.HOTPLATE_RESOURCES_CONFIG);
  assert.deepEqual(readResourceConfiguration(account).roots, [sharedRoot]);
  assert.deepEqual(readResourceConfiguration(isolated).roots, [isolatedRoot]);
});

test("project discovery uses provider paths and stops at the nearest repository marker", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-provider-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const project = join(directory, "repo");
  const cwd = join(project, "nested");
  const conventions = [".agents/skills", ".claude/skills", ".opencode/skills", ".pi/skills", ".codex/skills", ".skills"];
  for (const base of [directory, project, cwd]) for (const path of conventions) mkdirSync(join(base, path), { recursive: true });
  writeFileSync(join(project, ".git"), "gitdir: elsewhere");
  const env = { HOME: home };
  assert.equal(discoverResourceRoots({ cwd, env }).some(root => root.scope === "project"), false);
  const cases: readonly [ResourceHost, readonly string[], readonly string[]][] = [
    ["codex", [".agents/skills"], [".agents/skills"]],
    ["claude-code", [".claude/skills"], [".claude/skills"]],
    ["opencode-v1", [".opencode/skills"], [".opencode/skills"]],
    ["opencode-v2", [".opencode/skills", ".claude/skills", ".agents/skills"], [".opencode/skills", ".claude/skills", ".agents/skills"]],
    ["pi", [".pi/skills", ".agents/skills"], [".agents/skills"]],
  ];
  for (const [host, local, ancestors] of cases) {
    const roots = discoverResourceRoots({ cwd, env, project: { host, boundary: { kind: "infer" } } });
    assert.deepEqual(roots.filter(root => root.scope === "project").map(root => root.path).sort(),
      [...local.map(path => join(cwd, path)), ...ancestors.map(path => join(project, path))].sort(), host);
  }
  const diagnostics: ResourceDiagnostic[] = [];
  const outside = discoverResourceRoots({ cwd, env, project: { host: "codex", boundary: { kind: "reported", path: home } }, onDiagnostic: entry => diagnostics.push(entry) });
  assert.equal(outside.some(root => root.scope === "project"), false);
  assert.ok(diagnostics.some(entry => entry.reason === "outside-project"));
});

test("missing repository markers constrain inference to cwd and reported boundaries allow exact ancestors", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-project-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "parent", "child");
  for (const path of [join(cwd, ".agents/skills"), join(directory, "parent", ".agents/skills")]) mkdirSync(path, { recursive: true });
  const env = { HOME: join(directory, "home") };
  const diagnostics: ResourceDiagnostic[] = [];
  const inferred = discoverResourceRoots({ cwd, env, project: { host: "codex", boundary: { kind: "infer" } }, onDiagnostic: entry => diagnostics.push(entry) });
  assert.deepEqual(inferred.map(root => root.path), [join(cwd, ".agents/skills")]);
  assert.equal(diagnostics[0]?.reason, "outside-project");
  const reported = discoverResourceRoots({ cwd, env, project: { host: "codex", boundary: { kind: "reported", path: join(directory, "parent") } } });
  assert.equal(reported.length, 2);
  mkdirSync(join(cwd, ".jj"));
  assert.equal(discoverResourceRoots({ cwd, env, project: { host: "codex", boundary: { kind: "infer" } } }).length, 1);
});

test("legacy declarations reject checkout, home, filesystem and plugin cache roots while exact content remains", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-declared-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const checkout = join(directory, "checkout");
  const content = join(checkout, "skills");
  const packageRoot = join(directory, "package");
  const cache = join(home, ".codex/plugins/cache");
  const installed = join(cache, "vendor/package/version/skills");
  const custom = join(directory, "references");
  const missing = join(directory, "temporarily-unmounted");
  for (const path of [join(checkout, ".git"), content, join(packageRoot, ".jj"), installed, custom]) mkdirSync(path, { recursive: true });
  writeFileSync(join(packageRoot, "SKILL.md"), "package");
  const diagnostics: ResourceDiagnostic[] = [];
  const roots = discoverResourceRoots({ cwd: checkout, env: { HOME: home }, roots: ["/", directory, home, checkout, cache, dirname(installed), content, installed, packageRoot, custom, missing], onDiagnostic: entry => diagnostics.push(entry) });
  assert.deepEqual(roots.map(root => root.path).sort(), [content, installed, packageRoot, custom, missing].sort());
  for (const path of ["/", directory, home, checkout, cache, dirname(installed)]) assert.ok(diagnostics.some(entry => entry.path === path && entry.reason === "source-root"));
  assert.ok(diagnostics.some(entry => entry.path === custom && entry.reason === "legacy-declaration"));
  assert.ok(diagnostics.some(entry => entry.path === missing && entry.reason === "missing"));
});

test("typed collections authorize ownerless content while legacy advertisements require narrow proof", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-advertisement-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const collection = join(directory, ".skills");
  mkdirSync(collection);
  const file = join(collection, "README.md");
  writeFileSync(file, "shared content");
  const env = { HOME: join(directory, "home") };
  assert.equal(discoverResourceRoots({ cwd: directory, env, advertisedRoots: [collection] }).length, 0);
  const roots = discoverResourceRoots({ cwd: directory, env, advertisements: [{ kind: "collection", path: collection, host: "codex", sessionId: "s", source: "host-configuration" }] });
  assert.equal(qualifyResource({ path: file, cwd: directory, roots })?.ownerSkillPath, null);
  assert.ok(Object.isFrozen(roots));
  assert.ok(Object.isFrozen(roots[0]?.admission.authority));
  assert.ok(Object.isFrozen(roots[0]?.admission.exclusions.segments));
  const root = roots[0];
  assert.ok(root);
  assert.equal(qualifyResource({ path: file, cwd: directory, roots: [{ ...root }] }), null);
});

test("installed aliases authorize exact targets and reject nested escapes and excluded routes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-exact-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const checkout = join(directory, "checkout");
  const content = join(checkout, "skills");
  const external = join(directory, "external");
  for (const path of [collection, join(content, "references"), join(content, ".artifacts"), join(content, ".git"), join(content, "node_modules/pkg"), external]) mkdirSync(path, { recursive: true });
  for (const path of [join(content, "SKILL.md"), join(content, "references/guide.md"), join(content, ".artifacts/image.png"), join(content, ".git/private"), join(content, "node_modules/pkg/index.js"), join(external, "SKILL.md"), join(checkout, "source.ts")]) writeFileSync(path, "fixture");
  const alias = join(collection, "installed");
  symlinkSync(content, alias);
  symlinkSync(external, join(content, "references/escape"));
  symlinkSync(join(content, ".git/private"), join(content, "references/git-link"));
  symlinkSync(external, join(collection, ".git"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, advertisements: [{ kind: "package", path: external, host: "codex", sessionId: "s" }] });
  assert.ok(qualifyResource({ path: join(content, "references/guide.md"), cwd: directory, roots }));
  assert.ok(qualifyResource({ path: join(alias, ".artifacts/image.png"), cwd: directory, roots }));
  for (const path of [join(checkout, "source.ts"), join(content, ".git/private"), join(content, "node_modules/pkg/index.js"), join(content, "references/git-link"), join(content, "references/escape/SKILL.md"), join(collection, ".git/SKILL.md")]) {
    assert.equal(qualifyResource({ path, cwd: directory, roots }), null, path);
  }
  assert.equal(roots.some(root => root.path === join(collection, ".git")), false);
  assert.equal(admitResourcePath({ path: join(content, "references/escape"), cwd: directory, roots, entry: "directory" }).kind, "rejected");
  rmSync(alias);
  symlinkSync(external, alias);
  assert.equal(qualifyResource({ path: join(content, "SKILL.md"), cwd: directory, roots }), null);
  assert.equal(qualifyResource({ path: join(alias, "SKILL.md"), cwd: directory, roots }), null);
});

test("provider retirement exclusions survive overlapping roots and exact npm-store packages retain their own boundary", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-retired-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const claude = join(home, ".claude/skills");
  const shared = join(directory, "shared");
  const store = join(directory, ".npm/store/node_modules/installed");
  for (const path of [dirname(claude), join(shared, ".trash/removed"), join(shared, ".artifacts"), join(store, "node_modules/dependency"), join(store, "references")]) mkdirSync(path, { recursive: true });
  symlinkSync(shared, claude);
  for (const path of [join(shared, ".trash/removed/SKILL.md"), join(shared, ".artifacts/keep.png"), join(store, "SKILL.md"), join(store, "references/guide.md"), join(store, "node_modules/dependency/SKILL.md")]) writeFileSync(path, "fixture");
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, roots: [shared], advertisements: [
    { kind: "package", path: store, host: "codex", sessionId: "s" },
    { kind: "package", path: join(shared, ".trash/removed"), host: "claude-code", sessionId: "s" },
  ] });
  assert.equal(qualifyResource({ path: join(shared, ".trash/removed/SKILL.md"), cwd: directory, roots }), null);
  assert.ok(qualifyResource({ path: join(shared, ".artifacts/keep.png"), cwd: directory, roots }));
  assert.ok(qualifyResource({ path: join(store, "references/guide.md"), cwd: directory, roots }));
  assert.equal(qualifyResource({ path: join(store, "node_modules/dependency/SKILL.md"), cwd: directory, roots }), null);
});

test("catalog package proof is exact and file advertisements never authorize sibling files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-package-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageRoot = join(directory, "package");
  const missing = join(directory, "missing");
  mkdirSync(packageRoot);
  const entrypoint = join(packageRoot, "custom.md");
  const sibling = join(packageRoot, "neighbor.md");
  writeFileSync(entrypoint, "catalog entrypoint");
  writeFileSync(sibling, "not installed");
  const env = { HOME: join(directory, "home") };
  const roots = discoverResourceRoots({ cwd: directory, env, advertisements: [
    { kind: "package", path: packageRoot, host: "opencode-v2", sessionId: "s" },
    { kind: "package", path: missing, host: "opencode-v2", sessionId: "s" },
    { kind: "package", path: entrypoint, host: "opencode-v2", sessionId: "s" },
  ] });
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.admission.extent, "file");
  assert.ok(qualifyResource({ path: entrypoint, cwd: directory, roots }));
  assert.equal(qualifyResource({ path: sibling, cwd: directory, roots }), null);
  rmSync(entrypoint);
  assert.ok(qualifyResource({ path: entrypoint, cwd: directory, roots }));
  assert.deepEqual(discoverResourceRoots({ cwd: directory, env, advertisements: [{ kind: "package", path: entrypoint, host: "opencode-v2", sessionId: "s" }] }), []);
});

test("package declarations and collection aliases cannot use escaping package markers", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-package-marker-link-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const target = join(directory, "external");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(target);
  writeFileSync(join(target, "SKILL.md"), "external");
  symlinkSync(join(target, "SKILL.md"), join(checkout, "SKILL.md"));
  const env = { HOME: join(directory, "home") };
  assert.deepEqual(discoverResourceRoots({ cwd: directory, env, roots: [checkout] }), []);
  assert.deepEqual(discoverResourceRoots({ cwd: directory, env, advertisements: [{ kind: "package", path: checkout, host: "codex", sessionId: "s" }] }), []);
});

test("exact advertisements cannot authorize VCS internals without an enclosing root", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-vcs-advertisement-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = [join(directory, "checkout/.git/package"), join(directory, "checkout/.jj/package")];
  for (const path of paths) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), "fixture"); }
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: join(directory, "home") },
    advertisements: paths.map(path => ({ kind: "package", path, host: "codex", sessionId: "s" })) });
  assert.deepEqual(roots, []);
});

test("checkout rejection identifies independently installed aliases within that checkout", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-source-root-suggestions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const checkout = join(directory, "checkout");
  const content = join(checkout, "skills");
  const declared = join(checkout, "references");
  const unrelated = join(directory, "another-installation");
  for (const path of [collection, join(checkout, ".git"), content, declared, unrelated]) mkdirSync(path, { recursive: true });
  const alias = join(collection, "reese");
  symlinkSync(content, alias);
  symlinkSync(unrelated, join(collection, "other"));
  const diagnostics: ResourceDiagnostic[] = [];
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, roots: [declared, checkout], onDiagnostic: entry => diagnostics.push(entry) });
  assert.equal(roots.some(root => root.path === checkout), false);
  assert.deepEqual(diagnostics.find(entry => entry.path === checkout && entry.reason === "source-root")?.relatedPaths, [alias]);
});

test("overlapping exclusions do not depend on declaration order", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-overlap-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const content = join(directory, "content");
  const dependency = join(content, "node_modules/dependency");
  const independent = join(directory, "npm-store/node_modules/installed");
  for (const path of [dependency, independent]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), "fixture"); }
  const env = { HOME: join(directory, "home") };
  for (const declarations of [[content, dependency], [dependency, content]]) {
    const roots = discoverResourceRoots({ cwd: directory, env, roots: declarations,
      advertisements: [{ kind: "package", path: independent, host: "codex", sessionId: "s" }] });
    assert.deepEqual(roots.map(root => root.path).sort(), [content, independent].sort());
    assert.equal(qualifyResource({ path: join(dependency, "SKILL.md"), cwd: directory, roots }), null);
    assert.ok(qualifyResource({ path: join(independent, "SKILL.md"), cwd: directory, roots }));
  }
});

test("canonical overlap exclusions also remove aliases selected before their enclosing content root", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-alias-overlap-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const content = join(directory, "content");
  const dependency = join(content, "node_modules/dependency");
  for (const path of [collection, dependency]) mkdirSync(path, { recursive: true });
  writeFileSync(join(dependency, "SKILL.md"), "fixture");
  const alias = join(collection, "dependency");
  symlinkSync(dependency, alias);
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, roots: [content] });
  assert.equal(roots.some(root => root.path === alias), false);
  assert.equal(qualifyResource({ path: join(dependency, "SKILL.md"), cwd: directory, roots }), null);
  assert.equal(qualifyResource({ path: join(alias, "SKILL.md"), cwd: directory, roots }), null);
});

test("rejected collection aliases cannot exclude independent npm installations in either declaration order", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-rejected-alias-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const content = join(directory, "content");
  const excludedAlias = join(content, "node_modules/collection");
  const store = join(directory, "store");
  const independent = join(store, "node_modules/selected");
  const installedAlias = join(collection, "selected");
  const marker = join(independent, "SKILL.md");
  for (const path of [collection, dirname(excludedAlias), independent]) mkdirSync(path, { recursive: true });
  writeFileSync(marker, "fixture");
  symlinkSync(store, excludedAlias);
  symlinkSync(independent, installedAlias);
  for (const declarations of [[content, excludedAlias], [excludedAlias, content]]) {
    for (const declaration of ["configured", "advertised"]) for (const installation of ["account", "catalog"]) {
      const advertisements: ResourceAdvertisement[] = declaration === "advertised"
        ? declarations.map(path => ({ kind: "collection", path, host: "codex", sessionId: "s", source: "host-configuration" })) : [];
      if (installation === "catalog") advertisements.push({ kind: "package", path: independent, host: "codex", sessionId: "s" });
      const diagnostics: ResourceDiagnostic[] = [];
      const roots = discoverResourceRoots({ cwd: directory, env: { HOME: installation === "account" ? home : join(directory, "catalog-home") },
        roots: declaration === "configured" ? declarations : [], advertisements, onDiagnostic: entry => diagnostics.push(entry) });
      assert.deepEqual(roots.map(root => root.path).sort(), [content, ...(installation === "account" ? [collection, installedAlias] : [independent])].sort());
      assert.ok(qualifyResource({ path: marker, cwd: directory, roots }));
      assert.equal(qualifyResource({ path: join(excludedAlias, "node_modules/selected/SKILL.md"), cwd: directory, roots }), null);
      assert.deepEqual(diagnostics.find(entry => entry.path === excludedAlias && entry.reason === "excluded")?.relatedPaths, [content]);
    }
  }
});

test("cyclic alias exclusions cannot suppress independent installations", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-cyclic-alias-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const store = join(directory, "store");
  const firstTarget = join(store, "content/node_modules/first");
  const first = join(directory, "declared");
  const second = join(first, "node_modules/second");
  const independent = join(store, "node_modules/selected");
  const installedAlias = join(collection, "selected");
  for (const path of [collection, join(firstTarget, "node_modules"), independent]) mkdirSync(path, { recursive: true });
  for (const path of [firstTarget, independent]) writeFileSync(join(path, "SKILL.md"), "fixture");
  symlinkSync(firstTarget, first);
  symlinkSync(store, second);
  symlinkSync(independent, installedAlias);
  for (const declarations of [[first, second], [second, first]]) {
    const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home }, roots: declarations });
    assert.deepEqual(roots.map(root => root.path).sort(), [collection, installedAlias].sort());
    assert.ok(qualifyResource({ path: join(independent, "SKILL.md"), cwd: directory, roots }));
    assert.equal(qualifyResource({ path: join(first, "SKILL.md"), cwd: directory, roots }), null);
  }
});

test("direct catalog package and file proof do not inherit rejected installation anchors", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-catalog-anchor-precedence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const content = join(directory, "content");
  const installed = join(directory, "store/node_modules/installed");
  const standalone = join(directory, "catalog/standalone.md");
  const packageAlias = join(content, "node_modules/package");
  const fileAlias = join(content, "node_modules/file");
  for (const path of [dirname(packageAlias), installed, dirname(standalone)]) mkdirSync(path, { recursive: true });
  writeFileSync(join(installed, "SKILL.md"), "fixture");
  writeFileSync(standalone, "fixture");
  symlinkSync(installed, packageAlias);
  symlinkSync(standalone, fileAlias);
  for (const declarations of [[content, packageAlias, fileAlias], [fileAlias, packageAlias, content]]) {
    const roots = discoverResourceRoots({ cwd: directory, env: { HOME: join(directory, "home") }, roots: declarations,
      advertisements: [installed, standalone].map(path => ({ kind: "package", path, host: "codex", sessionId: "s" })) });
    assert.deepEqual(roots.map(root => root.path).sort(), [content, installed, standalone].sort());
    for (const path of [join(installed, "SKILL.md"), standalone]) assert.ok(qualifyResource({ path, cwd: directory, roots }));
    for (const path of [join(packageAlias, "SKILL.md"), fileAlias]) assert.equal(qualifyResource({ path, cwd: directory, roots }), null);
  }
});

test("narrowed roots preserve source metadata and reject a retargeted source even when the narrowed path stays canonical", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-narrowed-anchor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const collection = join(home, ".agents/skills");
  const source = join(directory, "source");
  const replacement = join(directory, "replacement");
  const mounted = join(source, "mounted");
  for (const path of [collection, mounted, replacement]) mkdirSync(path, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "owner");
  const file = join(mounted, "guide.md");
  writeFileSync(file, "fixture");
  const alias = join(collection, "installed");
  symlinkSync(source, alias);
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home } });
  const root = roots.find(entry => entry.path === alias);
  assert.ok(root);
  const narrowed = narrowResourceRoot({ root, path: join(alias, "mounted"), entry: "directory" });
  assert.ok(narrowed);
  assert.deepEqual(qualifyResource({ path: file, cwd: directory, roots: [narrowed] }), qualifyResource({ path: file, cwd: directory, roots: [root] }));
  assert.equal(qualifyResource({ path: join(source, "SKILL.md"), cwd: directory, roots: [narrowed] }), null);
  assert.equal(narrowResourceRoot({ root, path: replacement, entry: "directory" }), null);
  rmSync(alias);
  symlinkSync(replacement, alias);
  symlinkSync(mounted, join(replacement, "mounted"));
  assert.equal(canonicalResourcePath(narrowed.path), narrowed.canonicalPath);
  assert.equal(qualifyResource({ path: file, cwd: directory, roots: [narrowed] }), null);
  assert.deepEqual(admitResourcePath({ path: narrowed.path, cwd: directory, roots: [narrowed], entry: "directory" }), { kind: "rejected", reason: "authority-changed" });
});
