import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { encodeFilesystemScope } from "../src/filesystem-observer.js";
import { admitResourcePath, canonicalResourcePath, discoverResourceRoots } from "../src/resource-paths.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-native-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "matcher.c");
  const helper = join(directory, "matcher");
  writeFileSync(source, `#define main helper_main
#include ${JSON.stringify(join(process.cwd(), "native/fanotify.c"))}
#undef main
int main(int argc, char **argv) {
    if (read_scope(stdin) != 0) { free_scope(); return 2; }
    for (int index = 1; index < argc; index++) printf("%d\\n", under_root(argv[index]));
    free_scope();
    return 0;
}
`);
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", helper]);
  const file = (relative: string) => {
    const path = join(directory, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
    return path;
  };
  const run = (input: Buffer, paths: readonly string[] = []) => spawnSync(helper, paths, { input, encoding: "utf8", timeout: 5000 });
  return { directory, file, run };
}

function policy(tokens: readonly string[]): Buffer { return Buffer.from(`${tokens.join("\0")}\0`); }

test("compiled native scope matches shared admission for installed aliases, npm packages, retirement, and exact files", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const installed = dirname(f.file("store/node_modules/exact/SKILL.md"));
  const alias = join(f.directory, ".agents/skills/reese");
  mkdirSync(dirname(alias), { recursive: true });
  symlinkSync(installed, alias);
  symlinkSync(installed, join(dirname(alias), "second-alias"));
  const paths = ["store/node_modules/exact/.artifacts/kept.md", "store/node_modules/exact/references/guide.md",
    "store/node_modules/exact/.git/config", "store/node_modules/exact/.jj/repo", "store/node_modules/exact/node_modules/dependency/SKILL.md",
    "store/node_modules/exact/node_modules-other/kept.md", ".claude/skills/active/SKILL.md", ".claude/skills/.trash/retired/SKILL.md",
    ".claude/skills/.trash-other/kept.md", "catalog/selected.md", "catalog/sibling.md", "outside/secret.md"].map(f.file);
  symlinkSync(join(f.directory, "outside"), join(installed, "escape"));
  paths.push(join(installed, "escape/secret.md"), join(alias, "references/guide.md"), `${installed}-outside/secret.md`, join(f.directory, "catalog/selected.md/child"));
  const roots = discoverResourceRoots({ cwd: f.directory, env: { HOME: f.directory }, roots: [join(f.directory, "catalog/selected.md")] });
  const result = f.run(encodeFilesystemScope(roots), paths.map(canonicalResourcePath));
  assert.equal(result.status, 0, result.stderr);
  const native = result.stdout.trim().split("\n").map(value => value === "1");
  const expected = paths.map(path => admitResourcePath({ path, cwd: f.directory, roots, entry: "file-or-missing" }).kind === "accepted");
  assert.deepEqual(native, expected);
  assert.equal(expected[0], true);
  assert.equal(expected[4], false);
  assert.equal(expected[7], false);
  assert.equal(expected[10], false);
});

test("native rules use supplied values and component boundaries", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const root = dirname(f.file('content \n"quoted" Ω/SKILL.md'));
  const input = policy(["scope-v1", "root", "directory", root, "segment", "private", "prefix", "retired/items", "end-root", "end-scope"]);
  const result = f.run(input, [".git/config", ".artifacts/kept", "private/file", "nested/private/file", "private-ish/file", "retired/items/file", "retired/items-other/file"].map(path => join(root, path)));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["1", "1", "0", "0", "1", "0", "1"]);
});

test("native parser rejects incomplete, excessive, and invalid policy before fanotify setup", { skip: process.platform !== "linux" }, t => {
  const f = fixture(t);
  const root = dirname(f.file("content/SKILL.md"));
  const alias = join(f.directory, "alias");
  symlinkSync(root, alias);
  const valid = ["scope-v1", "root", "directory", root, "end-root", "end-scope"];
  const invalid = [Buffer.alloc(0), policy(["scope-v2", ...valid.slice(1)]), policy(valid.slice(0, -1)), policy([...valid, "extra"]),
    policy(["scope-v1", "end-scope"]), policy(["scope-v1", "root", "directory", "/", "end-root", "end-scope"]),
    policy(["scope-v1", "root", "file", root, "end-root", "end-scope"]),
    policy(["scope-v1", "root", "directory", alias, "end-root", "end-scope"]),
    policy(["scope-v1", "root", "directory", root, "segment", "nested/name", "end-root", "end-scope"]),
    ...["/absolute", "../parent", "a/../b", "a//b", "a/", "x".repeat(4097)].map(value => policy(["scope-v1", "root", "directory", root, "prefix", value, "end-root", "end-scope"])),
    policy(["scope-v1", "root", "directory", root, ...Array.from({ length: 17 }, () => ["segment", "value"]).flat(), "end-root", "end-scope"]),
    policy(["scope-v1", ...Array.from({ length: 1025 }, () => ["root", "directory", root, "end-root"]).flat(), "end-scope"]),
    Buffer.alloc(8 * 1024 * 1024 + 1, 1), policy(valid).subarray(0, -1)];
  for (const input of invalid) {
    const result = f.run(input);
    assert.equal(result.status, 2, `Accepted invalid policy with ${input.length} bytes: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  const actual = join(f.directory, "helper");
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", join(process.cwd(), "native/fanotify.c"), "-o", actual]);
  for (const args of [["--uid", String(process.getuid?.())], ["--uid", String(process.getuid?.()), "--root", root]]) {
    const result = spawnSync(actual, args, { input: policy(valid.slice(0, -1)), encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), { type: "unavailable", reason: "io-error" });
  }
});
