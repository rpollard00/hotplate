import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { discoverResourceRoots } from "../src/resource-paths.js";
import { shellGlob } from "../src/shell-glob.js";
import { captureToolReads, toolObservationIdentity, type ReadTool, type ShellGlob, type ToolReadContext } from "../src/tool-reads.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-tool-reads-"));
  const home = join(directory, "home");
  const skill = join(home, ".agents", "skills", "example");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Example\n");
  for (const name of ["first file.md", "second.md", "literal $x;[].md"]) writeFileSync(join(skill, "references", name), "reference content\n");
  symlinkSync("first file.md", join(skill, "references", "alias.md"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home, XDG_STATE_HOME: join(directory, "state") }, project: { host: "codex", boundary: { kind: "infer" } } });
  const context: ToolReadContext = { cwd: skill, roots, model: { provider: "test", id: "model" }, process: null, attribution: "session", home };
  return { directory, skill, context, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const success = { kind: "succeeded" } as const;
const unknown = { kind: "unknown" } as const;

test("structured tool reads preserve requested and reported portions without needing an entrypoint read", () => {
  const f = fixture();
  try {
    const evidence = captureToolReads({ operationId: "read", context: f.context,
      tool: { kind: "file", path: "references/first file.md", requested: { kind: "lines", start: 4, count: 10 }, outcome: success, delivery: unknown } });
    assert.equal(evidence.length, 2);
    const resource = evidence[0];
    assert.ok(resource?.kind === "resource-access");
    assert.equal(resource.resource.kind, "reference");
    assert.equal(resource.resource.ownerSkillPath, join(f.skill, "SKILL.md"));
    assert.equal(resource.access, "read");
    assert.equal(resource.outcome, "success");
    assert.deepEqual(resource.toolRead, { kind: "structured-read", requested: { kind: "lines", start: 4, count: 10 }, delivery: unknown, revision: unknown });
    const reported = captureToolReads({ operationId: "reported", context: f.context,
      tool: { kind: "file", path: "references/second.md", requested: { kind: "whole" }, outcome: success,
        delivery: { kind: "known", returned: { kind: "lines", start: 1, count: 1 }, truncated: true } } });
    assert.ok(reported[0]?.kind === "resource-access");
    assert.deepEqual(reported[0].toolRead?.delivery, { kind: "known", returned: { kind: "lines", start: 1, count: 1 }, truncated: true });
  } finally { f.close(); }
});

test("literal shell reads use effective cwd, quote rules, multiple targets and canonical alias deduplication", () => {
  const f = fixture();
  try {
    const evidence = captureToolReads({ operationId: "cat", context: f.context,
      tool: { kind: "shell", cwd: join(f.skill, "references"), command: `cat -- 'first file.md' alias.md second.md 'literal $x;[].md'`, outcome: success } });
    const reads = evidence.filter(item => item.kind === "resource-access");
    assert.equal(reads.length, 3);
    assert.ok(reads.every(item => item.access === "inferred-read" && item.outcome === "success"));
    assert.deepEqual(evidence.at(-1), { kind: "tool-coverage", operationId: "cat", family: "shell", outcome: "success", model: f.context.model,
      recognition: { kind: "recognized", resourceCount: 3 } });
    for (const command of ['cat references/first\\ file.md', 'cat "references/first file.md"']) {
      const result = captureToolReads({ operationId: command, context: f.context, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      assert.equal(result.filter(item => item.kind === "resource-access").length, 1);
    }
  } finally { f.close(); }
});

test("unknown command cwd cannot attribute relative targets to an in-scope project shadow", () => {
  const f = fixture();
  try {
    const absolute = join(f.skill, "references", "second.md");
    for (const tool of [
      { kind: "shell", command: "cat references/second.md", cwd: null, outcome: success },
      { kind: "python", code: "open('references/second.md').read()", cwd: null, outcome: success },
      { kind: "shell", command: `python3 -c "open('references/second.md').read()"`, cwd: null, outcome: success },
    ] satisfies ReadTool[]) {
      const evidence = captureToolReads({ operationId: "unknown-cwd", context: f.context, tool });
      assert.deepEqual(evidence, [{ kind: "tool-coverage", operationId: "unknown-cwd", family: tool.kind,
        outcome: "success", model: f.context.model, recognition: { kind: "opaque", reason: "missing-input" } }]);
    }
    for (const tool of [
      { kind: "shell", command: `cat '${absolute}'`, cwd: null, outcome: success },
      { kind: "python", code: `open('${absolute}').read()`, cwd: null, outcome: success },
    ] satisfies ReadTool[]) {
      const evidence = captureToolReads({ operationId: "absolute", context: f.context, tool });
      assert.ok(evidence[0]?.kind === "resource-access");
      assert.equal(evidence[0].resource.canonicalPath, absolute);
    }
    const mixed = captureToolReads({ operationId: "mixed", context: f.context,
      tool: { kind: "shell", command: `cat '${absolute}' references/first\\ file.md`, cwd: null, outcome: success } });
    assert.deepEqual(mixed.map(item => item.kind === "resource-access" ? item.resource.canonicalPath : item.recognition),
      [absolute, { kind: "opaque", reason: "missing-input" }]);
  } finally { f.close(); }
});

test("known requests do not become confirmed delivery, and aggregate failures remain per-file attempts", () => {
  const f = fixture();
  try {
    for (const outcome of [{ kind: "failed" }, { kind: "unreported" }] as const) {
      const evidence = captureToolReads({ operationId: "cat", context: f.context,
        tool: { kind: "shell", cwd: join(f.skill, "references"), command: "cat 'first file.md' second.md", outcome } });
      const reads = evidence.filter(item => item.kind === "resource-access");
      assert.equal(reads.length, 2);
      assert.ok(reads.every(item => item.access === "attempt" && item.outcome === "unknown" && item.toolRead?.delivery.kind === "unknown"));
      const coverage = evidence.at(-1);
      assert.ok(coverage?.kind === "tool-coverage");
      assert.equal(coverage.outcome, outcome.kind === "failed" ? "error" : "unknown");
    }
    const failure = captureToolReads({ operationId: "read", context: f.context,
      tool: { kind: "file", path: "references/second.md", requested: { kind: "whole" }, delivery: unknown, outcome: { kind: "failed" } } });
    assert.ok(failure[0]?.kind === "resource-access");
    assert.equal(failure[0].outcome, "error");
    const portions: [string, { kind: "lines"; start: number; count: number }][] = [
      ["sed -n '2,4p' references/second.md", { kind: "lines", start: 2, count: 3 }],
      ["head -n 4 references/second.md", { kind: "lines", start: 1, count: 4 }],
    ];
    for (const [command, portion] of portions) {
      const result = captureToolReads({ operationId: "portion", context: f.context, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      assert.ok(result[0]?.kind === "resource-access");
      assert.deepEqual(result[0].toolRead?.requested, portion);
      assert.deepEqual(result[0].toolRead?.delivery, unknown);
    }
  } finally { f.close(); }
});

test("unsupported shell semantics produce only sanitized unknown execution coverage", () => {
  const f = fixture();
  try {
    for (const command of [
      "cat $SKILL", "cat $(pwd)/SKILL.md", "cat `pwd`/SKILL.md", "cat references/*.md", "cat references/{first,second}.md",
      "cat ~user/SKILL.md", "cat -", "python -W ignore analyze.py", "# cat references/second.md", "cat 'unclosed",
      "cat --number references/second.md", "head -n 0 references/second.md", "sed -n '1p' references/second.md references/alias.md",
      "sed -n '2,1p' references/second.md", "PRIVATE_INPUT_CANARY references/second.md",
      "if true; then cat references/second.md; fi", "cat references/second.md &", "cat <(true)", "(cat references/second.md)",
      "cat 'a' \"b", "cat $(echo 'x", "cat <<EOF\nreferences/second.md", "f() { cat references/second.md; }", "cat references/[a-z]*.md",
      "cat references/second.md &&", "| cat references/second.md", "cat references/second.md >", "sudo cat references/second.md",
    ]) {
      const result = captureToolReads({ operationId: "opaque", context: f.context, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      assert.equal(result.length, 1, command);
      assert.ok(result[0]?.kind === "tool-coverage" && result[0].recognition.kind === "opaque", command);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_INPUT_CANARY"));
    }
  } finally { f.close(); }
});

test("compound shell commands follow cd, home expansion, comments, redirects and partial readers", () => {
  const f = fixture();
  try {
    const entry = join(f.skill, "SKILL.md");
    const second = join(f.skill, "references", "second.md");
    symlinkSync(f.skill, join(f.skill, "references", "nested"));
    const lines = (start: number, count: number | null) => ({ kind: "lines", start, count }) as const;
    const cases: [string, string | null, [string, unknown, string][], unknown][] = [
      [`cd '${f.skill}' && cat SKILL.md`, f.directory, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["cd ~/.agents/skills/example && sed -n '1,40p' SKILL.md | head -n 20", null, [[entry, lines(1, 40), "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ['cat "$HOME/.agents/skills/example/SKILL.md" ${HOME}/.agents/skills/example/references/second.md', null,
        [[entry, { kind: "whole" }, "inferred-read"], [second, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 2 }],
      ["cat SKILL.md; cat references/second.md", f.skill, [[entry, { kind: "whole" }, "attempt"], [second, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 2 }],
      ["cd references || exit 1\ncat second.md", f.skill, [[second, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["cd references || true; cat second.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      ["cd - && cat SKILL.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      [`cd - && cat SKILL.md '${second}'`, f.skill, [[second, { kind: "whole" }, "inferred-read"]], { kind: "opaque", reason: "missing-input" }],
      ["# inspect the skill\ncd references\n\nhead -5 second.md  # first lines\n", f.skill, [[second, lines(1, 5), "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["cat SKILL.md > /tmp/out", f.skill, [], { kind: "recognized", resourceCount: 0 }],
      ["cat SKILL.md | head -n 3 >> /tmp/out", f.skill, [], { kind: "recognized", resourceCount: 0 }],
      ["cat SKILL.md >&2", f.skill, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["cat SKILL.md 2>/dev/null", f.skill, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["cat < SKILL.md 2>&1", f.skill, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["head -n 2 <SKILL.md | wc -l", f.skill, [[entry, lines(1, 2), "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["tail -n +5 SKILL.md", f.skill, [[entry, lines(5, null), "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["tail -3 SKILL.md", f.skill, [[entry, { kind: "unknown" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["sed -n '3,$p' SKILL.md", f.skill, [[entry, lines(3, null), "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["LC_ALL=C nl SKILL.md | grep -n Example", f.skill, [[entry, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 1 }],
      [`cd '${f.skill}' && rg foo && cat SKILL.md`, null, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "opaque", reason: "unsupported-syntax" }],
      ["ls references && echo --- && pwd && cat references/second.md", f.skill, [[second, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["cd references/nested && cat ../SKILL.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      [`cat '${f.skill}/references/../SKILL.md'`, f.skill, [], { kind: "opaque", reason: "missing-input" }],
      ["cd -- - && cat SKILL.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      ["cd references && true || cat second.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      ["ls references && cd references; cat second.md", f.skill, [], { kind: "opaque", reason: "missing-input" }],
      ["cd references || exit 1 && false || cat second.md", f.skill, [[second, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["cat SKILL.md 2>/tmp/x >&2", f.skill, [], { kind: "recognized", resourceCount: 0 }],
      ["cat SKILL.md 1>&2 2>/tmp/x", f.skill, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["cat SKILL.md | cat references/second.md", f.skill, [[second, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["exec 2>/dev/null; cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["command cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["builtin cd references && cat second.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["eval 'cat SKILL.md'", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["source env.sh; cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      [". env.sh && cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["exit 0 && cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["cat SKILL.md; exit 0", f.skill, [[entry, { kind: "whole" }, "attempt"]], { kind: "recognized", resourceCount: 1 }],
      ["'A=b' cat SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["A=\"b c\" cat SKILL.md", f.skill, [[entry, { kind: "whole" }, "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["HOME=/tmp; cat ~/.agents/skills/example/SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["HOME=/tmp cat ~/.agents/skills/example/SKILL.md", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
      ["tail +2 SKILL.md", f.skill, [[entry, lines(2, null), "inferred-read"]], { kind: "recognized", resourceCount: 1 }],
      ["tail -n 3 +2", f.skill, [], { kind: "opaque", reason: "unsupported-syntax" }],
    ];
    for (const [command, cwd, expected, recognition] of cases) {
      const evidence = captureToolReads({ operationId: "compound", context: f.context, tool: { kind: "shell", cwd, command, outcome: success } });
      const reads = evidence.filter(item => item.kind === "resource-access");
      assert.deepEqual(reads.map(item => [item.resource.canonicalPath, item.toolRead?.requested, item.access]), expected, command);
      assert.deepEqual(evidence.at(-1)?.kind === "tool-coverage" ? evidence.at(-1) : null, { kind: "tool-coverage", operationId: "compound", family: "shell",
        outcome: "success", model: f.context.model, recognition }, command);
    }
  } finally { f.close(); }
});

test("shell steps stay independently readable around opaque words, variables, loops, globs, blocks and heredocs", () => {
  const f = fixture();
  try {
    const root = dirname(f.skill);
    const entry = join(f.skill, "SKILL.md");
    const second = join(f.skill, "references", "second.md");
    const other = join(root, "other", "SKILL.md");
    mkdirSync(dirname(other));
    writeFileSync(other, "# Other\n");
    const lines = (start: number, count: number | null) => ({ kind: "lines", start, count }) as const;
    const whole = { kind: "whole" } as const;
    const unsupported = { kind: "opaque", reason: "unsupported-syntax" } as const;
    const recognized = (resourceCount: number) => ({ kind: "recognized", resourceCount }) as const;
    const expansions: Record<string, readonly string[]> = { "vite.config.*": [], "references/zz*.md": [], "references/s*.md": [second], [`${root}/*/SKILL.md`]: [entry, other] };
    const fake: ShellGlob = pattern => expansions[pattern] ?? null;
    const cases: [string, ShellGlob | undefined, [string, unknown, string][], unknown][] = [
      [`cat vite.config.* 2>/dev/null; cat ${second} | head -80`, undefined, [[second, whole, "attempt"]], unsupported],
      [`cat vite.config.* 2>/dev/null; cat ${second} | head -80`, fake, [[second, whole, "attempt"]], recognized(1)],
      ["cat references/s*.md", fake, [[second, whole, "inferred-read"]], recognized(1)],
      ["cat references/s*.md", shellGlob, [[second, whole, "inferred-read"]], recognized(1)],
      [`for f in ${root}/*/SKILL.md; do head -n 5 "$f"; done`, fake, [[entry, lines(1, 5), "attempt"], [other, lines(1, 5), "attempt"]], recognized(2)],
      [`for f in ${root}/*/SKILL.md; do head -n 5 "$f"; done`, undefined, [], unsupported],
      ["cd refer*; cat second.md", fake, [], unsupported],
      ["ls *.md; cat SKILL.md", undefined, [[entry, whole, "attempt"]], unsupported],
      [`S=${root}; cat -n $S/example/SKILL.md | sed -n '1,46p'`, undefined, [[entry, whole, "attempt"]], recognized(1)],
      [`export S=${root}; head -n 3 "\${S}/other/SKILL.md"`, undefined, [[other, lines(1, 3), "attempt"]], recognized(1)],
      [`L=~/.agents/skills; cat "$L/example/SKILL.md"`, undefined, [[entry, whole, "attempt"]], recognized(1)],
      [`S=${root}; T=$S/example; cat $T/SKILL.md`, undefined, [[entry, whole, "attempt"]], recognized(1)],
      [`cat $X/SKILL.md; cat ${second}`, undefined, [[second, whole, "attempt"]], unsupported],
      [`X=${root} cat $X/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root}; S=$(pwd); cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root}; read S; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`true && S=${root}; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root} && cat $S/example/SKILL.md`, undefined, [[entry, whole, "inferred-read"]], recognized(1)],
      [`S=${root} && T=$S/example && cat $T/SKILL.md`, undefined, [[entry, whole, "inferred-read"]], recognized(1)],
      [`export S=${root} && head -n 3 "$S/other/SKILL.md"`, undefined, [[other, lines(1, 3), "inferred-read"]], recognized(1)],
      [`false && S=${root}; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root} || true; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root} && true || true && cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`true || S=${root}; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`cd references && S=${root}; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`export S=${root} || true; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`S=${root}; true && T=$S; cat $S/example/SKILL.md`, undefined, [[entry, whole, "attempt"]], recognized(1)],
      [`S="${root} x"; cat $S/example/SKILL.md`, undefined, [], unsupported],
      [`for f in ${entry} ${other}; do head -n 5 "$f"; done`, undefined, [[entry, lines(1, 5), "attempt"], [other, lines(1, 5), "attempt"]], recognized(2)],
      ["for f in references/second.md\ndo\n  cat $f\ndone", undefined, [[second, whole, "attempt"]], recognized(1)],
      ["for i in $(seq 1 3); do cat SKILL.md; done; cat references/second.md", undefined, [[second, whole, "attempt"]], unsupported],
      ["for d in references; do cd $d; done; cat second.md", undefined, [], unsupported],
      ["for f in SKILL.md references/second.md; do cat $f; break; done", undefined, [], unsupported],
      ["while read d; do cd $d; done < dirs; cat SKILL.md", undefined, [], unsupported],
      [`curl -fsS -H "Authorization: $(cat ~/.token)" https://example.test/x; cat SKILL.md`, undefined, [[entry, whole, "attempt"]], unsupported],
      ["jj log -T 'commit_id ++ \"\\n\"' -r $REV && cat SKILL.md", undefined, [[entry, whole, "attempt"]], unsupported],
      ['npm test; echo "exit=${PIPESTATUS[0]} $?"; cat SKILL.md', undefined, [[entry, whole, "attempt"]], unsupported],
      ['echo "$(cat SKILL.md)"', undefined, [], unsupported],
      ["git commit -m \"$(cat <<'EOF'\nDon't stop; cat SKILL.md\nEOF\n)\" && cat references/second.md", undefined, [[second, whole, "attempt"]], unsupported],
      ["cat > SKILL.md <<'EOF'\n# Title\n; cat references/second.md\nEOF", undefined, [], recognized(0)],
      ["cat <<EOF\nreferences/second.md\nEOF", undefined, [], recognized(0)],
      ["cat <<-EOF\n\treferences/second.md\n\tEOF\ncat SKILL.md", undefined, [[entry, whole, "attempt"]], recognized(1)],
      ["cat <<< references/second.md", undefined, [], recognized(0)],
      ["python3 - <<EOF\nprint(open('SKILL.md').read())\nEOF\ncat references/second.md", undefined, [[second, whole, "attempt"]], unsupported],
      ["if [ -f x ]; then cat SKILL.md; fi; cat references/second.md", undefined, [[second, whole, "attempt"]], unsupported],
      ["[ -f SKILL.md ] || { echo missing; exit 1; }; cat SKILL.md", undefined, [[entry, whole, "attempt"]], unsupported],
      ["if [ ! -f SKILL.md ]; then exit 1; fi; cat SKILL.md", undefined, [], unsupported],
      ["[[ -f SKILL.md && -d references ]] && cat SKILL.md", undefined, [[entry, whole, "inferred-read"]], recognized(1)],
      ["case x in a|b) cd references;; *) true;; esac; cat SKILL.md", undefined, [], unsupported],
      ["( cd references && cat second.md ); cat SKILL.md", undefined, [[entry, whole, "attempt"]], unsupported],
      ["{ cd references; }; cat SKILL.md", undefined, [], unsupported],
      ["f(){ cd references; }; f; cat SKILL.md", undefined, [], unsupported],
      [`cat(){ echo; }; cat ${entry}`, undefined, [], unsupported],
      ["exit 1; cat SKILL.md", undefined, [], unsupported],
      ["cd references && exit 0 && cat second.md", undefined, [], unsupported],
      ["IFS=: ; cat SKILL.md", undefined, [], unsupported],
      ["unset S; cat SKILL.md", undefined, [], unsupported],
      ["cat references/second.md |& head", undefined, [[second, whole, "attempt"]], recognized(1)],
      ["X=references; echo $[X=1]; cat $X/second.md", undefined, [], unsupported],
      ["X=references; Y=$((X=1)); cat $X/second.md", undefined, [], unsupported],
      ["X=references; (( X=1 )); cat $X/second.md", undefined, [], unsupported],
      ["X=references; for ((X=0; X<1; X++)); do :; done; cat $X/second.md", undefined, [], unsupported],
      ["X=references; a[X=1]=2; cat $X/second.md", undefined, [], unsupported],
      ["X=references; echo ${a[X=1]}; cat $X/second.md", undefined, [], unsupported],
      ["X=references; [[ X=1 -eq 1 ]]; cat $X/second.md", undefined, [], unsupported],
      ["X=references; echo hi > /dev/null$((X=1)); cat $X/second.md", undefined, [], unsupported],
      ...["eval true", "source env.sh", ". env.sh", "builtin true", "command -v jq", "exec true", "declare X=1", "typeset X=1", "local X=1", "readonly X=1",
        "read X", "mapfile X < list", "readarray X < list", "printf -v X y", "printf -vX y", "wait -p X", "getopts a X", "trap 'cd /' DEBUG", "set -e", "shopt -s nullglob",
        "unset X", "alias cat=true", "enable -n echo", "hash -r", "let X=1", "ulimit -n 64", "umask 077", "test -f x && source env.sh", "[ -f x ] || builtin cd /",
        "if true; then source env.sh; fi", "true | true && kill $$"].map(prefix =>
        [`${prefix}; cat ${entry}`, undefined, [], unsupported] as [string, ShellGlob | undefined, [string, unknown, string][], unknown]),
      [`f() { g; }; g() { exit; }; f; cat ${entry}`, undefined, [], unsupported],
      [`f() { :; }; true && f; cat ${entry}`, undefined, [], unsupported],
      ...["GLOBIGNORE=x", "FIGNORE=x", "GLOBSORT=name", "BASH_ENV=x", "ENV=x", "POSIXLY_CORRECT=1", "SHELLOPTS=x", "BASHOPTS=x", "export GLOBIGNORE=x"].map(prefix =>
        [`${prefix}; cat ${entry}`, undefined, [], unsupported] as [string, ShellGlob | undefined, [string, unknown, string][], unknown]),
      [`GLOBIGNORE=x cat ${entry}`, undefined, [], unsupported],
      [`for f in references/zz*.md; do cat $f; done; cat ${entry}`, fake, [[entry, whole, "attempt"]], unsupported],
      [`for f in ${entry} references/zz*.md; do cat $f; done`, fake, [], unsupported],
      ["printf '%s' x; echo; true; :; pwd; cat SKILL.md", undefined, [[entry, whole, "attempt"]], recognized(1)],
    ];
    for (const [command, glob, expected, recognition] of cases) {
      const context: ToolReadContext = glob ? { ...f.context, glob } : f.context;
      const evidence = captureToolReads({ operationId: "steps", context, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      const reads = evidence.filter(item => item.kind === "resource-access");
      assert.deepEqual(reads.map(item => [item.resource.canonicalPath, item.toolRead?.requested, item.access]), expected, command);
      assert.deepEqual(evidence.at(-1)?.kind === "tool-coverage" ? evidence.at(-1) : null, { kind: "tool-coverage", operationId: "steps", family: "shell",
        outcome: "success", model: f.context.model, recognition }, command);
    }
  } finally { f.close(); }
});

test("skill script executions follow command paths, interpreters, sourcing and read outcome rules", () => {
  const f = fixture();
  try {
    const scripts = join(f.skill, "scripts");
    mkdirSync(scripts);
    const [log, py, mjs, ts, env] = ["log.sh", "x.py", "x.mjs", "x.ts", "env.sh"].map(name => join(scripts, name));
    for (const path of [log, py, mjs, ts, env]) writeFileSync(path ?? "", "");
    const entry = join(f.skill, "SKILL.md");
    const unsupported = { kind: "opaque", reason: "unsupported-syntax" } as const;
    const missing = { kind: "opaque", reason: "missing-input" } as const;
    const recognized = (resourceCount: number) => ({ kind: "recognized", resourceCount }) as const;
    const cases: [string, string | null, [string | undefined, string, string][], unknown][] = [
      [`${log} file verify`, f.skill, [[log, "execute", "success"]], recognized(1)],
      [`L=${log}; $L file verify --json`, f.skill, [[log, "execute", "unknown"]], recognized(1)],
      ["~/.agents/skills/example/scripts/log.sh a b", null, [[log, "execute", "success"]], recognized(1)],
      ['"$HOME/.agents/skills/example/scripts/log.sh" a', null, [[log, "execute", "success"]], recognized(1)],
      [`cd '${f.skill}' && ./scripts/log.sh a`, f.directory, [[log, "execute", "success"]], recognized(1)],
      ["./scripts/log.sh a", null, [], missing],
      [`bash ${log} a`, null, [[log, "execute", "success"]], recognized(1)],
      [`bash -eu -- ${log}`, null, [[log, "execute", "success"]], recognized(1)],
      [`bash -c 'cat ${entry}'`, null, [], unsupported],
      [`bash -n ${log}`, null, [], unsupported],
      [`python3 -I ${py}`, null, [[py, "execute", "success"]], recognized(1)],
      ["python3 -m mod", f.skill, [], unsupported],
      ["toString x", f.skill, [], unsupported],
      ["constructor x | hasOwnProperty", f.skill, [], unsupported],
      ["python3 -W ignore scripts/x.py", f.skill, [], unsupported],
      ["node scripts/x.mjs", f.skill, [[mjs, "execute", "success"]], recognized(1)],
      ["node -e 'console.log(1)'", f.skill, [], unsupported],
      [`uv run ${py}`, null, [[py, "execute", "success"]], recognized(1)],
      ["uv run pytest", f.skill, [], unsupported],
      ["bun run scripts/x.ts", f.skill, [[ts, "execute", "success"]], recognized(1)],
      ["bun scripts/x.ts", f.skill, [[ts, "execute", "success"]], recognized(1)],
      ["bun run build", f.skill, [], unsupported],
      ["deno run scripts/x.ts", f.skill, [[ts, "execute", "success"]], recognized(1)],
      ["npx tsx scripts/x.ts", f.skill, [[ts, "execute", "success"]], recognized(1)],
      ["tsx scripts/x.ts", f.skill, [[ts, "execute", "success"]], recognized(1)],
      [`source ${env}; cat ${entry}`, null, [[env, "execute", "unknown"]], unsupported],
      [`. ${env} && cat ${entry}`, null, [[env, "execute", "unknown"]], unsupported],
      [`cat ${entry}; source env.sh`, f.skill, [[entry, "attempt", "unknown"]], unsupported],
      [`/usr/local/bin/tool ${entry}`, null, [], unsupported],
      [`bash /usr/local/bin/tool`, null, [], unsupported],
      [`bash ${f.skill}/../example/scripts/log.sh`, null, [], missing],
      [`L=${log} && D=x.tsv && bash $L $D build`, null, [[log, "execute", "success"]], recognized(1)],
      [`(cd /tmp) && L=${log} && S=x && $L file $S`, null, [[log, "execute", "unknown"]], unsupported],
      [`false && L=${log}; $L a`, null, [], unsupported],
      [`L=${log} || true; $L a`, null, [], unsupported],
      [`cd ${f.skill} && L=${log}; $L a`, null, [], unsupported],
      [`for d in a b; do test -d $d && L=${log}; done; $L`, null, [], unsupported],
      [`L=/tmp/q.md; for d in a; do test -d $d && L=${entry}; done; cat $L`, null, [], unsupported],
      [`for i in 1; do test -d a && L=${entry}; done && cat $L`, null, [], unsupported],
      [`test -d a && for i in 1; do L=${entry}; done; cat $L`, null, [], unsupported],
      [`false || for i in 1; do L=${entry}; done; cat $L`, null, [], unsupported],
      [`test -d a && for i in 1; do L=${entry}; done && cat $L`, null, [[entry, "inferred-read", "success"]], recognized(1)],
      [`for i in 1; do L=${entry}; done; cat $L`, null, [[entry, "attempt", "unknown"]], recognized(1)],
      ["bash +x scripts/log.sh", f.skill, [], unsupported],
      ["tsx watch scripts/x.ts", f.skill, [], unsupported],
      ["node inspect scripts/x.mjs", f.skill, [], unsupported],
      ["node --test scripts/x.mjs", f.skill, [], unsupported],
      ["node test", f.skill, [], unsupported],
      ["deno run main", f.skill, [], unsupported],
      ["npx tsx watch scripts/x.ts", f.skill, [], unsupported],
      [`cat ${log} && bash ${log}`, null, [[log, "inferred-read", "success"], [log, "execute", "success"]], recognized(2)],
      [`bash ${log} | head -n 2`, null, [[log, "execute", "unknown"]], recognized(1)],
      [`bash ${log}; bash ${log}`, null, [[log, "execute", "unknown"]], recognized(1)],
      [`for s in ${log} ${py}; do bash $s; done`, null, [[log, "execute", "unknown"], [py, "execute", "unknown"]], recognized(2)],
      ["bash scripts/lo*.sh", f.skill, [[log, "execute", "success"]], recognized(1)],
      ["bash scripts/zz*.sh", f.skill, [], recognized(0)],
    ];
    for (const [command, cwd, expected, recognition] of cases) {
      const evidence = captureToolReads({ operationId: "execute", context: { ...f.context, glob: shellGlob }, tool: { kind: "shell", cwd, command, outcome: success } });
      const accesses = evidence.filter(item => item.kind === "resource-access");
      assert.deepEqual(accesses.map(item => [item.resource.canonicalPath, item.access, item.outcome]), expected, command);
      assert.ok(accesses.every(item => item.access !== "execute" || item.toolRead === undefined), command);
      assert.deepEqual(evidence.at(-1)?.kind === "tool-coverage" ? evidence.at(-1) : null, { kind: "tool-coverage", operationId: "execute", family: "shell",
        outcome: "success", model: f.context.model, recognition }, command);
    }
    for (const outcome of [{ kind: "failed" }, { kind: "unreported" }] as const) {
      const evidence = captureToolReads({ operationId: "failed", context: f.context, tool: { kind: "shell", cwd: null, command: `bash ${log}`, outcome } });
      assert.deepEqual(evidence.filter(item => item.kind === "resource-access").map(item => [item.access, item.outcome]), [["execute", "unknown"]]);
    }
    const both = captureToolReads({ operationId: "both", context: f.context, tool: { kind: "shell", cwd: null, command: `cat ${log} && bash ${log}`, outcome: success } });
    const scope = { projectCwd: f.directory, sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null } as const;
    const ids = both.filter(item => item.kind === "resource-access").map(evidence => toolObservationIdentity({ host: "pi", scope, evidence }).id);
    assert.equal(new Set(ids).size, 2);
  } finally { f.close(); }
});

test("adversarial loops, globs and step counts exhaust one shared work budget quickly", () => {
  const f = fixture();
  try {
    const tree = join(f.directory, "tree");
    for (let outer = 0; outer < 60; outer += 1) {
      mkdirSync(join(tree, `d${outer}`), { recursive: true });
      for (let inner = 0; inner < 60; inner += 1) writeFileSync(join(tree, `d${outer}`, `f${inner}`), "");
    }
    const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
    const entry = join(f.skill, "SKILL.md");
    const commands = [
      `for a in 1 2 3; do for b in ${words(100)}; do for c in ${words(100)}; do true; done; done; done; cat ${entry}`,
      `for a in ${words(100)}; do for b in ${words(100)}; do cat ${tree}/*/* references/*; done; done; cat ${entry}`,
      `for a in ${words(39)}; do for b in ${words(39)}; do ls ${tree}/*/*; done; done; cat ${entry}`,
      `for a in ${words(128)}; do for b in ${words(128)}; do true; true; done; done; cat ${entry}`,
    ];
    let worst = 0;
    for (const command of commands) {
      const started = performance.now();
      const evidence = captureToolReads({ operationId: "budget", context: { ...f.context, glob: shellGlob }, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      worst = Math.max(worst, performance.now() - started);
      assert.deepEqual(evidence.map(item => item.kind === "tool-coverage" ? item.recognition : item.kind), [{ kind: "opaque", reason: "limit" }], command.slice(0, 80));
    }
    assert.ok(worst < 250, `${worst} ms`);
  } finally { f.close(); }
});

test("Python recognizes only complete literal read expressions and known imports", () => {
  const f = fixture();
  try {
    for (const code of [
      "open('references/second.md').read()", "print(open('references/second.md', 'r').read())",
      "from pathlib import Path; print(Path('references/second.md').read_text())",
      "import pathlib; pathlib.Path('references/second.md').read_text()",
    ]) {
      const result = captureToolReads({ operationId: "python", context: f.context, tool: { kind: "python", code, cwd: f.skill, outcome: success } });
      assert.equal(result.filter(item => item.kind === "resource-access").length, 1, code);
      assert.ok(result[0]?.kind === "resource-access" && result[0].access === "inferred-read");
    }
    const shell = captureToolReads({ operationId: "python-c", context: f.context,
      tool: { kind: "shell", command: `python3 -c 'print(open("references/second.md").read())'`, cwd: f.skill, outcome: success } });
    assert.ok(shell[0]?.kind === "resource-access" && shell[0].access === "inferred-read");
    for (const code of [
      '"open(\'references/second.md\').read()"', '# open("references/second.md").read()',
      "print('open(\"references/second.md\").read()')", "open(path).read()", "open(f'{path}').read()",
      "if False: open('references/second.md').read()", "def f(): open('references/second.md').read()",
      "open('references/second.md', 'w').read()", "print(open('references/second.md').read()); raise Exception()",
      "__import__('pathlib').Path('references/second.md').read_text()", "Path('references/second.md').read_text()",
      "open('references/second.md').read(10)", "filename = 'references/second.md'; open(filename).read()",
    ]) {
      const result = captureToolReads({ operationId: "python-opaque", context: f.context, tool: { kind: "python", code, cwd: f.skill, outcome: success } });
      assert.equal(result.length, 1, code);
      assert.ok(result[0]?.kind === "tool-coverage" && result[0].recognition.kind === "opaque", code);
    }
  } finally { f.close(); }
});

test("coverage does not retain unrelated paths, and oversized input is bounded", () => {
  const f = fixture();
  try {
    const tools: ReadTool[] = [
      { kind: "shell", command: "cat /tmp/PRIVATE_PATH_CANARY", cwd: f.skill, outcome: success },
      { kind: "shell", command: "x".repeat(32_769), cwd: f.skill, outcome: success },
      { kind: "shell", command: `echo ${"$(".repeat(10_000)}`, cwd: f.skill, outcome: success },
      { kind: "shell", command: `${"( ".repeat(10_000)}true`, cwd: f.skill, outcome: success },
      { kind: "shell", command: `${"! ".repeat(10_000)}true`, cwd: f.skill, outcome: success },
    ];
    for (const tool of tools) {
      const result = captureToolReads({ operationId: "no-resource", context: f.context, tool });
      assert.equal(result.length, 1);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_PATH_CANARY"));
    }
    const evidence = captureToolReads({ operationId: "pi-tool", context: f.context,
      tool: { kind: "file", path: "references/second.md", requested: { kind: "whole" }, delivery: unknown, outcome: success } })[0];
    assert.ok(evidence?.kind === "resource-access");
    const scope = { projectCwd: f.skill, sessionId: "session-a", sessionFile: null, segmentId: "segment-a", segmentReason: "unknown", runId: null, turnId: null, leafId: null } as const;
    const identity = toolObservationIdentity({ host: "pi", scope, evidence });
    assert.deepEqual(toolObservationIdentity({ host: "pi", scope: { ...scope, segmentId: "reload" }, evidence }), identity);
    assert.notDeepEqual(toolObservationIdentity({ host: "pi", scope: { ...scope, sessionId: "session-b" }, evidence }), identity);
  } finally { f.close(); }
});

test("actual shell and Python reads preserve literal file URLs and quoted tildes", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const reference = join(f.skill, "references", "second.md");
    const outside = join(f.directory, "work");
    mkdirSync(outside);
    const fileUrl = `file://${reference}`;
    const literalUrlFile = resolve(outside, fileUrl);
    const literalTilde = "~/references/local.md";
    const literalTildeFile = resolve(f.skill, literalTilde);
    for (const path of [literalUrlFile, literalTildeFile]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "literal file content\n");
    }
    const cases = [
      { path: fileUrl, cwd: outside, expectedResource: null },
      { path: literalTilde, cwd: f.skill, expectedResource: literalTildeFile },
      { path: "references/second.md", cwd: f.skill, expectedResource: reference },
      { path: reference, cwd: f.skill, expectedResource: reference },
    ];
    for (const item of cases) {
      const command = `cat '${item.path}'`;
      const code = `print(open(${JSON.stringify(item.path)}).read())`;
      const shell = spawnSync("bash", ["-c", command], { cwd: item.cwd, encoding: "utf8" });
      const python = spawnSync("python3", ["-c", code], { cwd: item.cwd, encoding: "utf8" });
      const content = readFileSync(resolve(item.cwd, item.path), "utf8");
      for (const [result, expected] of [[shell, content], [python, `${content}\n`]] as const) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, expected);
      }
      for (const tool of [
        { kind: "shell", cwd: item.cwd, command, outcome: success },
        { kind: "python", cwd: item.cwd, code, outcome: success },
      ] satisfies ReadTool[]) {
        const evidence = captureToolReads({ operationId: `${tool.kind}:${item.path}`, context: f.context, tool });
        const resources = evidence.filter(event => event.kind === "resource-access");
        assert.deepEqual(resources.map(event => event.resource.canonicalPath), item.expectedResource === null ? [] : [item.expectedResource]);
      }
    }
  } finally { f.close(); }
});
