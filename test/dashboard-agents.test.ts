import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDashboardReport } from "../src/dashboard/analytics.js";
import type { ChainObservation, DashboardFilter, HostId, Observation, SkillChainRun, SkillChainStep } from "../src/domain.js";
import { parseMachineId } from "../src/observation.js";
import { openHotplateStore } from "../src/store.js";

type ChainEvidence = ChainObservation["evidence"];
const machineId = parseMachineId("local");
const at = "2026-01-01T12:00:00.000Z";
function skill(name: string) {
  return { name, canonicalPath: `/skills/${name}/SKILL.md`, version: null };
}
function read(name: string, outcome: "success" | "error" = "success"): ChainEvidence {
  return { kind: "read-result", skill: skill(name), toolCallId: `read-${name}`, outcome, model: null };
}
function invoke(name: string, outcome: "success" | "error" = "success"): ChainEvidence {
  return { kind: "skill-invocation", skill: { name, canonicalPath: null, version: null }, toolCallId: `invoke-${name}`, outcome, model: null };
}
function attempt(name: string): ChainEvidence {
  return { kind: "read-attempt", skill: skill(name), toolCallId: `attempt-${name}`, model: null };
}
function request(name: string): ChainEvidence {
  return { kind: "command-intent", skillName: name, source: "interactive" };
}
function wrapper(name: string): ChainEvidence {
  return { kind: "wrapper-observed", skill: skill(name), wrapperSource: "expanded-prompt" };
}
function step(evidence: readonly ChainEvidence[], observedAt = at): SkillChainStep {
  return {
    kind: "observations", observedAt, turnId: "turn", leafId: null,
    items: evidence.map((entry, index) => ({ observationId: `observation-${index}`, observedAt, sequence: index, evidence: entry })),
  };
}
function run(steps: readonly SkillChainStep[], scope: Partial<Omit<SkillChainRun, "steps">> = {}): SkillChainRun {
  return { machineId, sourceId: "local", projectCwd: "/projects/test", sessionId: "session", segmentId: "segment", runId: "run", ...scope, steps };
}
function report(runs: readonly SkillChainRun[], filter: DashboardFilter = {}) {
  return buildDashboardReport({ filter, chains: { runs }, skills: { rows: [] } });
}

test("agent comparison counts reads, invocations, and read attempts as uses and keeps failures apart", () => {
  const result = report([
    run([step([request("mako"), wrapper("mako")]), step([read("mako"), read("mako", "error")], "2026-01-01T13:00:00.000Z")], { host: "pi" }),
    run([step([attempt("mako"), attempt("how")], "2026-01-02T08:00:00.000Z")], { host: "codex", sessionId: "codex-session" }),
    run([step([invoke("mako"), invoke("how", "error"), read("how")], "2026-01-01T09:00:00.000Z")], { host: "claude-code", runId: null }),
  ]);
  assert.deepEqual(result.agents.hosts, [
    { host: "pi", uses: { reads: 1, invocations: 0, attempts: 0, failures: 1 }, sessions: 1, skills: 1, lastUseAt: "2026-01-01T13:00:00.000Z" },
    { host: "claude-code", uses: { reads: 1, invocations: 1, attempts: 0, failures: 1 }, sessions: 1, skills: 2, lastUseAt: "2026-01-01T09:00:00.000Z" },
    { host: "codex", uses: { reads: 0, invocations: 0, attempts: 2, failures: 0 }, sessions: 1, skills: 2, lastUseAt: "2026-01-02T08:00:00.000Z" },
  ]);
  assert.deepEqual(result.counts, { requests: 1, wrappers: 1, successfulReads: 2, failedReads: 1, readAttempts: 2, invocations: 2 });
});

test("agent comparison counts sessions, not runs, and falls back to segments and the unknown host", () => {
  const result = report([
    run([step([read("mako")])], { host: "pi", runId: "first" }),
    run([step([read("mako")])], { host: "pi", runId: "second" }),
    run([step([read("mako")])], { host: "pi", sessionId: "other" }),
    run([step([read("mako")])], { host: "pi", machineId: parseMachineId("other-machine") }),
    run([step([invoke("mako")])], { host: "claude-code", runId: null }),
    run([step([invoke("mako")])], { host: "claude-code", runId: null }),
    run([step([read("how")])], { sessionId: null, segmentId: "legacy-a", runId: "one" }),
    run([step([read("how")])], { sessionId: null, segmentId: "legacy-a", runId: "two" }),
    run([step([read("how")])], { sessionId: null, segmentId: "legacy-b" }),
  ]);
  assert.deepEqual(result.agents.hosts.map(({ host, sessions, uses }) => ({ host, sessions, total: uses.reads + uses.invocations })), [
    { host: "pi", sessions: 3, total: 4 },
    { host: "claude-code", sessions: 1, total: 2 },
    { host: "unknown", sessions: 2, total: 3 },
  ]);
  const mako = result.agents.skills.find(row => row.name === "mako");
  assert.deepEqual(mako?.cells.map(({ host, sessions }) => ({ host, sessions })), [{ host: "pi", sessions: 3 }, { host: "claude-code", sessions: 1 }]);
});

test("agent comparison omits request-only hosts and keeps failure-only hosts and skills without uses", () => {
  const result = report([
    run([step([request("mako"), wrapper("mako")])], { host: "opencode-v2", runId: null }),
    run([step([invoke("broken", "error")])], { host: "opencode-v1", runId: null }),
    run([step([read("mako")])], { host: "pi" }),
  ]);
  assert.deepEqual(result.agents.hosts.map(entry => entry.host), ["pi", "opencode-v1"]);
  assert.deepEqual(result.agents.hosts[1], {
    host: "opencode-v1", uses: { reads: 0, invocations: 0, attempts: 0, failures: 1 }, sessions: 0, skills: 0, lastUseAt: null,
  });
  assert.deepEqual(result.agents.skills, [
    { name: "mako", uses: 1, cells: [{ host: "pi", uses: { reads: 1, invocations: 0, attempts: 0, failures: 0 }, sessions: 1 }] },
    { name: "broken", uses: 0, cells: [{ host: "opencode-v1", uses: { reads: 0, invocations: 0, attempts: 0, failures: 1 }, sessions: 0 }] },
  ]);
  assert.deepEqual(report([run([step([request("mako"), wrapper("mako")])], { host: "pi" })]).agents, { hosts: [], skills: [] });
});

test("agent skill rows rank by total uses across hosts and order cells by host", () => {
  const result = report([
    run([step([attempt("zeta"), attempt("zeta"), attempt("alpha")])], { host: "codex" }),
    run([step([invoke("alpha"), read("beta")])], { host: "opencode-v2", runId: null }),
    run([step([read("zeta"), read("beta")])]),
    run([step([read("alpha")])], { host: "pi" }),
  ]);
  assert.deepEqual(result.agents.skills.map(row => [row.name, row.uses, row.cells.map(cell => cell.host)]), [
    ["alpha", 3, ["pi", "codex", "opencode-v2"]],
    ["zeta", 3, ["codex", "unknown"]],
    ["beta", 2, ["opencode-v2", "unknown"]],
  ]);
  assert.deepEqual(result.agents.hosts.map(entry => entry.host), ["pi", "codex", "opencode-v2", "unknown"]);
});

test("activity bins count skill uses per host in host order", () => {
  const result = report([
    run([step([read("mako"), read("how", "error"), request("mako")], "2026-01-01T10:15:00.000Z")], { host: "pi" }),
    run([step([attempt("mako"), attempt("how")], "2026-01-01T10:30:00.000Z")], { host: "codex" }),
    run([step([invoke("mako"), invoke("how", "error")], "2026-01-01T12:05:00.000Z")], { host: "claude-code", runId: null }),
    run([step([read("mako")], "2026-01-01T10:45:00.000Z")]),
  ]);
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.deepEqual(result.activity.bins.map(bin => [bin.startAt, bin.agents]), [
    ["2026-01-01T10:00:00.000Z", [{ host: "pi", uses: 1 }, { host: "codex", uses: 2 }, { host: "unknown", uses: 1 }]],
    ["2026-01-01T11:00:00.000Z", []],
    ["2026-01-01T12:00:00.000Z", [{ host: "claude-code", uses: 1 }]],
  ]);
  assert.equal(result.activity.bins[0]?.counts.readAttempts, 2);
});

test("agent sessions stay whole when the store splits native observations into separate runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-agents-"));
  const store = openHotplateStore({ databasePath: join(directory, "test.sqlite") });
  const observation = (host: HostId, sequence: number, runId: string | null, evidence: Observation["evidence"]): Observation => ({
    host, id: `id-${sequence}`, producerId: "producer", sequence, observedAt: `2026-01-01T12:00:0${sequence}.000Z`, evidence,
    scope: { projectCwd: "/project", sessionId: `${host}-session`, sessionFile: null, segmentId: `${host}-session`, segmentReason: "startup", runId, turnId: null, leafId: null },
  });
  try {
    const summary = await store.record([
      observation("claude-code", 1, null, invoke("mako")),
      observation("claude-code", 2, null, read("how")),
      observation("claude-code", 3, null, invoke("mako")),
      observation("codex", 4, "turn-1", attempt("mako")),
      observation("codex", 5, "turn-2", attempt("mako")),
    ]);
    assert.equal(summary.accepted, 5);
    const chains = await store.querySkillChain({});
    assert.equal(chains.runs.length, 5);
    const result = buildDashboardReport({ filter: {}, skills: await store.querySkillTable({}), chains });
    assert.deepEqual(result.agents.hosts.map(({ host, sessions, uses }) => ({ host, sessions, uses })), [
      { host: "claude-code", sessions: 1, uses: { reads: 1, invocations: 2, attempts: 0, failures: 0 } },
      { host: "codex", sessions: 1, uses: { reads: 0, invocations: 0, attempts: 2, failures: 0 } },
    ]);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent skill rows retain exact plugin-prefixed native invocation names", () => {
  const result = report([
    run([step([read("brainstorming")])], { host: "pi" }),
    run([step([invoke("superpowers:brainstorming")])], { host: "claude-code", runId: null }),
  ]);
  assert.deepEqual(result.agents.skills.map((row) => [row.name, row.cells.map((cell) => [cell.host, cell.sessions])]), [
    ["brainstorming", [["pi", 1]]],
    ["superpowers:brainstorming", [["claude-code", 1]]],
  ]);
});
