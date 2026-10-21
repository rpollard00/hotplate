import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shellGlob } from "../src/shell-glob.js";

const plenty = () => ({ remaining: Number.MAX_SAFE_INTEGER });

test("shell globs follow bash defaults for dotfiles, brackets, segments and no matches", () => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-shell-glob-"));
  try {
    for (const name of ["a.md", "b.md", "c.txt", ".hidden.md", "x/SKILL.md", "y/SKILL.md", ".z/SKILL.md", "y/notes.md"]) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), "");
    }
    const at = (...names: string[]) => names.map(name => join(directory, name));
    const cases: [string, readonly string[] | null][] = [
      ["*.md", at("a.md", "b.md")], [".*.md", at(".hidden.md")], ["[ab].md", at("a.md", "b.md")], ["[!a].md", at("b.md")],
      ["[^b].md", at("a.md")], ["[a-b].*", at("a.md", "b.md")], ["?.txt", at("c.txt")], ["*/SKILL.md", at("x/SKILL.md", "y/SKILL.md")],
      ["y/*", at("y/SKILL.md", "y/notes.md")], ["none*", []], ["*/missing.md", []], ["\\*.md", null], ["a.md", null], ["[[:alpha:]].md", null], ["*/", null],
    ];
    for (const [pattern, expected] of cases) assert.deepEqual(shellGlob(pattern, directory, plenty()), expected, pattern);
    assert.deepEqual(shellGlob(`${directory}/*.txt`, "/", plenty()), at("c.txt"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("shell globs refuse oversized match sets and directory scans", () => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-shell-glob-cap-"));
  try {
    for (let index = 0; index < 129; index += 1) writeFileSync(join(directory, `f${index}.md`), "");
    assert.equal(shellGlob("f*.md", directory, plenty()), null);
    assert.equal(shellGlob("f1?.md", directory, plenty())?.length, 10);
    mkdirSync(join(directory, "wide"));
    for (let index = 0; index < 10_001; index += 1) writeFileSync(join(directory, "wide", `${index}`), "");
    assert.equal(shellGlob("wide/x*", directory, plenty()), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("shell glob matching is linear in adversarial star patterns and respects the shared budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-shell-glob-time-"));
  try {
    mkdirSync(join(directory, "long"));
    writeFileSync(join(directory, "long", "a".repeat(200)), "");
    writeFileSync(join(directory, "long", `${"a".repeat(199)}b`), "");
    const started = performance.now();
    const pattern = `long/${"*a".repeat(12)}*b`;
    assert.deepEqual(shellGlob(pattern, directory, plenty()), [join(directory, "long", `${"a".repeat(199)}b`)]);
    assert.deepEqual(shellGlob(`long/${"*a".repeat(120)}*b`, directory, plenty()), [join(directory, "long", `${"a".repeat(199)}b`)]);
    assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
    const budget = { remaining: 150 };
    assert.equal(shellGlob(pattern, directory, budget), null);
    assert.ok(budget.remaining < 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
