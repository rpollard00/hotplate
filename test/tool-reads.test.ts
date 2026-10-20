import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { discoverResourceRoots } from "../src/resource-paths.js";
import { captureToolReads, toolObservationIdentity, type ReadTool, type ToolReadContext } from "../src/tool-reads.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-tool-reads-"));
  const home = join(directory, "home");
  const skill = join(home, ".agents", "skills", "example");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Example\n");
  for (const name of ["first file.md", "second.md", "literal $x;[].md"]) writeFileSync(join(skill, "references", name), "reference content\n");
  symlinkSync("first file.md", join(skill, "references", "alias.md"));
  const roots = discoverResourceRoots({ cwd: directory, env: { HOME: home, XDG_STATE_HOME: join(directory, "state") }, project: { host: "codex", boundary: { kind: "infer" } } });
  const context: ToolReadContext = { cwd: skill, roots, model: { provider: "test", id: "model" }, process: null, attribution: "session" };
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
      { kind: "shell", command: `cat '${absolute}' references/second.md`, cwd: null, outcome: success },
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
      "cat references/second.md; true", "cat references/second.md || true", "cat references/second.md | head",
      "cat references/second.md > /tmp/output", "cat $SKILL", "cat $(pwd)/SKILL.md", "cat `pwd`/SKILL.md",
      "cat references/*.md", "cat references/{first,second}.md", "cat ~/skills/example/SKILL.md", "cat -",
      "python analyze.py", "echo 'cat references/second.md'", "# cat references/second.md", "cat 'unclosed",
      "cat references/second.md\ntrue", "cat --number references/second.md", "head -n 0 references/second.md",
      "sed -n '1p' references/second.md references/alias.md", "sed -n '2,1p' references/second.md",
      "PRIVATE_INPUT_CANARY references/second.md",
    ]) {
      const result = captureToolReads({ operationId: "opaque", context: f.context, tool: { kind: "shell", cwd: f.skill, command, outcome: success } });
      assert.equal(result.length, 1, command);
      assert.ok(result[0]?.kind === "tool-coverage" && result[0].recognition.kind === "opaque", command);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_INPUT_CANARY"));
    }
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
