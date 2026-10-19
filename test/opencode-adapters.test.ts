import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { extractOpenCodeV1Fact } from "../src/integrations/opencode/v1.js";
import v2, { extractOpenCodeV2Fact } from "../src/integrations/opencode/v2.js";

const context = { projectCwd: "/project", observedAt: "2026-09-28T00:00:00.000Z", env: { HOME: "/nonexistent-hotplate-opencode-test" } };
const v1Input = { tool: "read", sessionID: "session", callID: "call", args: { filePath: ".opencode/skills/example/SKILL.md" } };
const v2Input = { tool: "read", sessionID: "session", id: "call", agent: "build", messageID: "message", input: { path: v1Input.args.filePath }, status: "completed", result: { content: "RAW_OUTPUT_CANARY" } };

test("OpenCode adapters capture equivalent read evidence without raw data", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-opencode-adapters-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, v1Input.args.filePath);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "SKILL_BODY_CANARY");
  const local = { ...context, projectCwd: directory, env: { HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config") } };
  const first = extractOpenCodeV1Fact(v1Input, { output: "RAW_OUTPUT_CANARY", metadata: { secret: "METADATA_CANARY" } }, local);
  const second = extractOpenCodeV2Fact(v2Input, local);
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.evidence, second.evidence);
  assert.equal(first.scope.runId, null);
  assert.equal(second.scope.turnId, "message");
  assert.equal(second.actorId, "session");
  assert.equal(first.evidence.kind, "read-result");
  assert.equal(JSON.stringify([first, second]).includes("CANARY"), false);
});

test("OpenCode v2 distinguishes failure and native skill invocation", () => {
  const fact = extractOpenCodeV2Fact({ ...v2Input, tool: "skill", input: { id: "example" }, status: "error", error: { message: "ERROR_CANARY" } }, context);
  assert.equal(fact?.evidence.kind, "skill-invocation");
  if (fact?.evidence.kind !== "skill-invocation") throw new Error("Missing invocation");
  assert.equal(fact.evidence.outcome, "error");
  assert.equal(fact.evidence.skill.canonicalPath, null);
  assert.equal(JSON.stringify(fact).includes("CANARY"), false);
});

test("OpenCode adapters reject unrelated, incomplete, and ambiguous events", () => {
  assert.equal(extractOpenCodeV1Fact(v1Input, { error: "failed" }, context), null);
  assert.equal(extractOpenCodeV2Fact({ ...v2Input, status: "running" }, context), null);
  assert.equal(extractOpenCodeV2Fact({ ...v2Input, tool: "bash", input: { command: "cat SKILL.md" } }, context), null);
  assert.equal(extractOpenCodeV2Fact({ ...v2Input, input: { path: "/project/README.md" } }, context), null);
  assert.equal(extractOpenCodeV2Fact(v2Input, { projectCwd: "relative" }), null);
});

test("OpenCode v2 plugin resolves the event session rather than its instance location", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hotplate-opencode-plugin-"));
  const previousRegistry = process.env.HOTPLATE_PROCESS_REGISTRY;
  process.env.HOTPLATE_PROCESS_REGISTRY = join(directory, "processes");
  t.after(() => {
    if (previousRegistry === undefined) delete process.env.HOTPLATE_PROCESS_REGISTRY;
    else process.env.HOTPLATE_PROCESS_REGISTRY = previousRegistry;
    rmSync(directory, { recursive: true, force: true });
  });
  let handler: ((event: unknown) => Promise<void>) | undefined;
  const sessions: string[] = [];
  await v2.setup({
    tool: { async hook(name, callback) { assert.equal(name, "execute.after"); handler = callback; } },
    session: { async get(input) { sessions.push(input.sessionID); throw new Error("Unavailable session"); } },
  });
  assert.ok(handler);
  await handler(v2Input);
  assert.deepEqual(sessions, ["session"]);
});
