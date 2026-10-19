import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildDashboardReport } from "../src/dashboard/analytics.js";
import { projectMetrics, type MetricMeasure, type MetricsPresentation } from "../src/dashboard/metrics.js";
import type { ChainObservation, SkillChainRun } from "../src/domain.js";
import { parseMachineId } from "../src/observation.js";

const at = "2026-01-01T12:00:00.000Z";
const skill = { name: "plugin:mako", canonicalPath: "/skills/mako/SKILL.md", version: null };
const one = { provider: "one", id: "shared" };
const two = { provider: "two", id: "shared" };
function run(evidence: readonly ChainObservation["evidence"][], overrides: Partial<SkillChainRun> = {}): SkillChainRun {
  return { host: "codex", machineId: parseMachineId("local"), sourceId: "local", projectCwd: "/project", sessionId: "session", segmentId: "segment", runId: "run", steps: [{ kind: "observations", observedAt: at, turnId: null, leafId: null, items: evidence.map((entry, sequence) => ({ observationId: `obs-${sequence}`, observedAt: at, sequence, evidence: entry })) }], ...overrides };
}
const read = (model: typeof one | null, outcome: "success" | "error" = "success"): ChainObservation["evidence"] => ({ kind: "read-result", skill, model, outcome, toolCallId: "call" });
const invoke = (model: typeof one | null, outcome: "success" | "error" = "success"): ChainObservation["evidence"] => ({ kind: "skill-invocation", skill, model, outcome, toolCallId: "call" });
const runs = [
  run([read(one), read(one), invoke(two), invoke(null, "error"), { kind: "read-attempt", skill, model: null, toolCallId: "attempt" }, read(null, "error"), { kind: "command-intent", skillName: skill.name, source: "rpc" }, { kind: "wrapper-observed", skill, wrapperSource: "expanded-prompt" }]),
  run([read(two), read(null)], { runId: "other-run" }),
  run([read(two)], { host: "claude-code", runId: "other-host" }),
];
const report = buildDashboardReport({ filter: {}, skills: { rows: [] }, chains: { runs } });
const presentation: MetricsPresentation = { measure: "uses", split: "agent-model", display: "count" };

test("metrics conserve each recorded measure across every split and stable activity bins", () => {
  const expected = { successfulReads: 5, failedReads: 1, uses: 7, invocations: 1, invocationFailures: 1, readAttempts: 1, requests: 1, wrappers: 1 };
  for (const measure of Object.keys(expected) as MetricMeasure[]) for (const split of ["skill", "agent", "model", "agent-model"] as const) {
    const result = projectMetrics(report, { measure, split, display: "count" });
    assert.deepEqual(result.totals, expected);
    assert.equal(result.series.reduce((sum, series) => sum + series.count, 0), expected[measure]);
    assert.equal(result.skills.reduce((sum, row) => sum + row.count, 0), expected[measure]);
    assert.equal(result.timeline.reduce((sum, bin) => sum + bin.count, 0), expected[measure]);
    assert.deepEqual(result.timeline.map(bin => [bin.startAt, bin.endAt]), report.activity.kind === "bucketed" ? report.activity.bins.map(bin => [bin.startAt, bin.endAt]) : []);
    for (const bin of result.timeline) assert.equal(bin.values.reduce((sum, value) => sum + value.count, 0), bin.count);
  }
});

test("metrics keep exact names, valid pairs, unknown and inherent lack of attribution distinct", () => {
  const result = projectMetrics(report, presentation);
  assert.deepEqual(result.skills.map(row => row.name), ["plugin:mako"]);
  assert.equal(result.series.length, 4);
  assert.equal(result.series.find(series => series.host === "claude-code")?.model?.provider, "two");
  assert.equal(result.series.filter(series => series.model?.id === "shared").length, 3);
  assert.equal(result.series.filter(series => series.attribution === "unknown").length, 1);
  const request = projectMetrics(report, { measure: "requests", split: "model", display: "count" });
  assert.equal(request.series[0]?.label, "No model attribution");
  assert.equal(request.series[0]?.attribution, "none");
  assert.deepEqual(request.skills[0]?.routeKeys, [report.routes.find(route => route.counts.requests > 0)?.key]);
});

test("session shares deduplicate runs, distinguish hosts, and use model cohort denominators", () => {
  const result = projectMetrics(report, { ...presentation, measure: "uses", display: "session-share" });
  assert.equal(result.skills[0]?.sessions, 2);
  assert.equal(result.skills[0]?.eligibleSessions, 2);
  assert.equal(result.skills[0]?.share, 1);
  for (const series of result.series) assert.equal(series.sessions, 1);
  for (const cell of result.skills[0]?.cells ?? []) { assert.equal(cell.sessions, 1); assert.equal(cell.eligibleSessions, 1); assert.equal(cell.share, 1); }
  const failed = buildDashboardReport({ filter: {}, skills: { rows: [] }, chains: { runs: [run([invoke(null, "error")])] } });
  const view = projectMetrics(failed, { measure: "invocationFailures", split: "model", display: "count" });
  assert.equal(view.totals.uses, 0);
  assert.equal(view.skills[0]?.share, null);
  assert.equal(view.skills[0]?.cells[0]?.share, null);
});

test("projection serialized into browser source needs no module dependencies", () => {
  const browserResult: unknown = runInNewContext(`(${projectMetrics.toString()})(report, presentation)`, { report, presentation });
  assert.deepEqual(JSON.parse(JSON.stringify(browserResult)), projectMetrics(report, presentation));
});

test("undated observations contribute to totals without acquiring a timeline date", () => {
  const undated = run([read(null)]);
  const steps = undated.steps.map(step => step.kind === "observations" ? { ...step, items: step.items.map(item => ({ ...item, observedAt: "invalid" })) } : step);
  const result = projectMetrics(buildDashboardReport({ filter: {}, skills: { rows: [] }, chains: { runs: [{ ...undated, steps }] } }), presentation);
  assert.equal(result.totals.uses, 1); assert.equal(result.undatedCount, 1); assert.deepEqual(result.timeline, []);
});

test("skill/session numerators, cohort denominators and route targets stay exact across multiple sessions", () => {
  const otherSkill = { ...skill, name: "other" };
  const otherRead: ChainObservation["evidence"] = { kind: "read-result", skill: otherSkill, model: one, outcome: "success", toolCallId: "other" };
  const input = buildDashboardReport({ filter: {}, skills: { rows: [] }, chains: { runs: [
    run([read(one), read(two)]),
    run([read(one)], { runId: "repeat-run" }),
    run([otherRead], { sessionId: "second-session", runId: "second" }),
    run([invoke(two, "error")], { sessionId: "failure-session", runId: "failure" }),
  ] } });
  const result = projectMetrics(input, { measure: "uses", display: "session-share", split: "model" });
  const mako = result.skills.find(row => row.name === skill.name);
  const other = result.skills.find(row => row.name === otherSkill.name);
  assert.equal(mako?.sessions, 1); assert.equal(mako?.eligibleSessions, 2); assert.equal(mako?.share, 0.5);
  const cohortOne = result.series.find(series => series.model?.provider === "one");
  const cohortTwo = result.series.find(series => series.model?.provider === "two");
  assert.equal(cohortOne?.eligibleSessions, 2); assert.equal(cohortTwo?.eligibleSessions, 1);
  assert.equal(mako?.cells.find(cell => cell.key === cohortOne?.key)?.share, 0.5);
  assert.equal(mako?.cells.find(cell => cell.key === cohortTwo?.key)?.share, 1);
  assert.equal(other?.cells.find(cell => cell.key === cohortTwo?.key)?.share, 0);
  const failureRoute = input.routes.find(route => route.scope.runId === "failure");
  assert.ok(failureRoute);
  assert.ok(mako?.routeKeys.every(key => key !== failureRoute.key));
  const failed = projectMetrics(input, { measure: "invocationFailures", display: "count", split: "model" });
  assert.deepEqual(failed.skills.find(row => row.name === skill.name)?.routeKeys, [failureRoute.key]);
});
