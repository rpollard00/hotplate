import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openHotplateStore } from "../src/store.js";
import type { Observation } from "../src/domain.js";

function fact(sequence: number, evidence: Observation["evidence"]): Observation {
  return {
    id: `regression:${sequence}`, producerId: "regression", sequence,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    scope: { projectCwd: "/test", sessionId: "s", sessionFile: null, segmentId: "segment", segmentReason: "startup", runId: "run", turnId: "turn", leafId: `leaf-${sequence}` },
    evidence,
  };
}
const skill = { name: "alpha", canonicalPath: "/skills/alpha/SKILL.md", version: null };

async function temporary(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-regression-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("opening a database preserves the permissions of its existing parent", async () => {
  await temporary(async (dir) => {
    await chmod(dir, 0o755);
    const store = openHotplateStore({ databasePath: join(dir, "analytics.sqlite") });
    try { assert.equal((await stat(dir)).mode & 0o777, 0o755); }
    finally { await store.close(); }
  });
});

test("failed-only model reads are not activations", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record(fact(1, { kind: "read-result", skill, toolCallId: "failed", outcome: "error", model: { provider: "test", id: "a" } }));
    assert.equal((await store.queryModelMatrix({})).rows[0]?.uniqueObservedRunActivations, 0);
  } finally { await store.close(); }
});

test("model-filtered chain evidence agrees with the overview", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([
      fact(1, { kind: "command-intent", skillName: "alpha", source: "interactive" }),
      fact(2, { kind: "read-result", skill, toolCallId: "read", outcome: "success", model: { provider: "test", id: "a" } }),
    ]);
    const filter = { modelProvider: "test" };
    const items = (await store.querySkillChain(filter)).runs.flatMap(run => run.steps.flatMap(step => step.kind === "observations" ? step.items : []));
    assert.equal(items.length, (await store.queryOverview(filter)).observationCount);
    assert.equal(items[0]?.evidence.kind, "read-result");
  } finally { await store.close(); }
});

test("same-turn reads remain one group despite result times and advancing leaves", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([1, 2].map(sequence => fact(sequence, { kind: "read-result", skill, toolCallId: `read-${sequence}`, outcome: "success", model: null })));
    const steps = (await store.querySkillChain({})).runs[0]?.steps;
    assert.equal(steps?.length, 1);
    assert.equal(steps?.[0]?.kind === "observations" ? steps[0].items.length : 0, 2);
  } finally { await store.close(); }
});

test("an unreadable database returns an error payload without killing the dashboard", { timeout: 10_000 }, async () => {
  await temporary(async (dir) => {
    const path = join(dir, "corrupt.sqlite");
    await writeFile(path, "not SQLite");
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "serve", "--db", path, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", data => { stderr += String(data); });
    try {
      const [chunk] = await once(child.stdout, "data");
      const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      assert.ok(url);
      const response = await fetch(`${url}/api/dashboard`);
      const payload: unknown = await response.json();
      assert.ok(typeof payload === "object" && payload !== null && "kind" in payload);
      assert.equal(payload.kind, "error");
      assert.equal((await fetch(`${url}/health`)).status, 200);
      assert.equal(child.exitCode, null, stderr);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    }
  });
});
