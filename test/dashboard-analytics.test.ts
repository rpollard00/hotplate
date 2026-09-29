import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDashboardReport } from "../src/dashboard/analytics.js";
import type { ChainObservation, DashboardFilter, Evidence, ModelRef, Observation, SkillChainRun, SkillChainStep, SkillTableRow } from "../src/domain.js";
import { parseMachineId, parseSourceId } from "../src/observation.js";
import { openHotplateStore } from "../src/store.js";

const machineId = parseMachineId("local");
const dayOne = "2026-01-01T12:00:00.000Z";
const dayThree = "2026-01-03T12:00:00.000Z";
const zero = { requests: 0, wrappers: 0, successfulReads: 0, failedReads: 0 };
function skill(name: string, canonicalPath = `/skills/${name}/SKILL.md`) {
  return { name, canonicalPath, version: null };
}
function read(name: string, model: ModelRef = null, outcome: "success" | "error" = "success"): ChainObservation["evidence"] {
  return { kind: "read-result", skill: skill(name), toolCallId: name, model, outcome };
}
function item(evidence: ChainObservation["evidence"], sequence = 1, observedAt = dayOne): ChainObservation {
  return { observationId: `observation-${sequence}`, observedAt, sequence, evidence };
}
function group(items: readonly ChainObservation[], turnId: string | null = "turn"): SkillChainStep {
  return { kind: "observations", observedAt: items[0]?.observedAt ?? dayOne, turnId, leafId: "leaf", items };
}
function run(steps: readonly SkillChainStep[], scope: Partial<Omit<SkillChainRun, "steps">> = {}): SkillChainRun {
  return { machineId, sourceId: "local", projectCwd: "/projects/test", sessionId: null, segmentId: "segment", runId: null, ...scope, steps };
}
function catalog(name: string): SkillTableRow {
  return {
    machineId, skillName: name, canonicalPath: skill(name).canonicalPath, version: null, cataloged: true,
    commandIntentCount: 99, interactiveCommandIntentCount: 99, rpcCommandIntentCount: 0, extensionCommandIntentCount: 0,
    wrapperObservedCount: 99, successfulReadCount: 99, failedReadCount: 99, readResultCount: 198,
    uniqueObservedRunActivations: 99, lastObservedAt: "2099-01-01T00:00:00.000Z",
  };
}
function report(runs: readonly SkillChainRun[] = [], rows: readonly SkillTableRow[] = [], filter: DashboardFilter = {}) {
  return buildDashboardReport({ filter, chains: { runs }, skills: { rows } });
}

test("dashboard analytics separates evidence classes and ignores catalog counters and refresh times", () => {
  const runs = [run([
    group([item({ kind: "command-intent", skillName: "mako", source: "rpc" })]),
    group([item({ kind: "wrapper-observed", skill: skill("mako"), wrapperSource: "unknown-pasted-or-transformed" }, 2)]),
    group([item(read("mako"), 3), item(read("mako"), 4), item(read("failure-only", null, "error"), 5)]),
  ])];
  const inputBefore = JSON.stringify(runs);
  const result = report(runs, [catalog("unused"), catalog("mako")]);
  assert.deepEqual(result.counts, { requests: 1, wrappers: 1, successfulReads: 2, failedReads: 1 });
  assert.equal(result.skillsRead, 1);
  assert.equal(result.skills.length, 4);
  const unused = result.skills.find((entry) => entry.label === "unused");
  assert.deepEqual(unused?.counts, zero);
  assert.equal(unused?.lastEvidenceAt, null);
  assert.deepEqual(unused?.routeKeys, []);
  const mako = result.skills.filter((entry) => entry.label === "mako");
  assert.equal(mako.length, 2);
  assert.notEqual(mako[0]?.key, mako[1]?.key);
  assert.equal(mako.filter((entry) => entry.cataloged).length, 1);
  assert.equal(result.skillGroups.find((entry) => entry.name === "mako")?.cataloged, true);
  assert.deepEqual(result.skillGroups.find((entry) => entry.name === "mako")?.counts, { requests: 1, wrappers: 1, successfulReads: 2, failedReads: 0 });
  assert.equal(result.routes[0]?.lastEvidenceAt, dayOne);
  assert.deepEqual(result.routes[0]?.counts, result.counts);
  assert.equal(result.relationships.length, 0);
  assert.deepEqual(report(runs, [catalog("unused"), catalog("mako")]), result);
  assert.equal(JSON.stringify(runs), inputBefore);
});

test("dashboard analytics retains equal model IDs across providers, unknown models, and repeated reads", () => {
  const result = report([run([group([
    item(read("a", { provider: "one", id: "shared" }), 1),
    item(read("a", { provider: "two", id: "shared" }), 2),
    item(read("a", { provider: "one", id: "shared" }), 3),
    item(read("b", null, "error"), 4),
    item(read("b"), 5),
  ])])]);
  assert.equal(result.models.length, 3);
  assert.equal(result.models.find((column) => column.model?.provider === "one")?.successfulReads, 2);
  assert.equal(result.models.find((column) => column.model?.provider === "two")?.successfulReads, 1);
  const unknown = result.models.find((column) => column.model === null);
  assert.equal(unknown?.successfulReads, 1);
  assert.equal(unknown?.failedReads, 1);
  assert.equal(unknown?.cells.length, 1);
  assert.equal(result.models.reduce((total, column) => total + column.successfulReads, 0), result.counts.successfulReads);
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0]?.kind, "same-group");
  assert.equal(result.relationships[0]?.evidence.length, 1);
});

test("dashboard analytics keeps machine, path, and request-only skill identities distinct", () => {
  const result = report([
    run([group([item(read("same")), item({ ...read("same"), kind: "wrapper-observed", skill: skill("same", "/other/SKILL.md"), wrapperSource: "expanded-prompt" })])]),
    run([group([item(read("same"))])], { machineId: parseMachineId("other") }),
    run([group([item({ kind: "command-intent", skillName: "same", source: "extension" })])], { segmentId: "request" }),
  ]);
  assert.equal(result.skills.length, 4);
  assert.equal(new Set(result.skills.map((entry) => entry.key)).size, 4);
  assert.equal(result.skillsRead, 1);
  assert.equal(result.skillGroups.length, 1);
  const rollup = result.skillGroups[0];
  assert.equal(rollup?.name, "same");
  assert.deepEqual(rollup?.counts, { requests: 1, wrappers: 1, successfulReads: 2, failedReads: 0 });
  assert.equal(rollup?.skillKeys.length, 4);
  assert.equal(rollup?.routeKeys.length, 3);
  assert.deepEqual(rollup?.models, [{ model: null, successfulReads: 2, failedReads: 0 }]);
  assert.equal(rollup?.cataloged, false);
  assert.ok(rollup?.skillKeys.every((key) => result.skills.some((entry) => entry.key === key)));
});

test("dashboard analytics preserves original groups and exact relationship provenance", () => {
  const steps = [
    group([item(read("a"), 1), item(read("a"), 2), item(read("b"), 3)], "same-turn"),
    group([item(read("c"), 4), item(read("d", null, "error"), 5)], "next-turn"),
    group([item(read("a"), 6), item(read("b"), 7)], "third-turn"),
  ];
  const result = report([run(steps), run(steps, { segmentId: "second" })]);
  const same = result.relationships.filter((entry) => entry.kind === "same-group");
  const next = result.relationships.filter((entry) => entry.kind === "next-group");
  assert.equal(same.length, 1);
  assert.equal(same[0]?.evidence.length, 4);
  assert.equal(next.length, 2);
  for (const relationship of result.relationships) {
    for (const evidence of relationship.evidence) {
      const route = result.routes.find((entry) => entry.key === evidence.routeKey);
      assert.ok(route);
      if ("stepIndex" in evidence) {
        assert.equal(route.steps[evidence.stepIndex]?.kind, "observations");
      } else {
        assert.equal(evidence.toStepIndex, evidence.fromStepIndex + 1);
        assert.equal(route.steps[evidence.fromStepIndex]?.kind, "observations");
        assert.equal(route.steps[evidence.toStepIndex]?.kind, "observations");
      }
    }
  }
  const preserved = result.routes[0]?.steps.map((step) => step.kind === "gap" ? step : {
    ...step, items: step.items.map(({ skillKey: _key, ...observation }) => observation),
  });
  assert.deepEqual(preserved, steps);
  assert.ok(next.every((relationship) => relationship.evidence.length === 2));
});

test("dashboard analytics never bridges gaps or intervening requests, wrappers, or failures", () => {
  const barriers: SkillChainStep[] = [
    { kind: "gap", observedAt: dayOne, omitted: 4, reason: "db-busy" },
    { kind: "gap", observedAt: null, omitted: 3, reason: "filtered-intermediates" },
    group([item({ kind: "command-intent", skillName: "mako", source: "interactive" })]),
    group([item({ kind: "wrapper-observed", skill: skill("mako"), wrapperSource: "expanded-prompt" })]),
    group([item(read("failed", null, "error"))]),
  ];
  const result = report(barriers.map((barrier, index) => run([
    group([item(read("a"))]), barrier, group([item(read("b"))]),
  ], { segmentId: `segment-${index}` })));
  assert.deepEqual(result.relationships, []);
  assert.deepEqual(result.coverage, { captureGaps: 1, droppedObservations: 4, filteredOmissions: 3, undatedEvidence: 0, catalogContext: "machine-project-time" });
  const wrapperMako = result.skills.find((entry) => entry.label === "mako" && entry.identity.kind === "resolved");
  assert.equal(wrapperMako?.counts.wrappers, 1);
  assert.equal(wrapperMako?.routeKeys.length, 1);
  assert.equal(result.routes.find((entry) => entry.key === wrapperMako?.routeKeys[0])?.steps.length, 3);
});

test("dashboard analytics never joins reused or null IDs across full route partitions", () => {
  const scopes: Partial<SkillChainRun>[] = [
    {}, { machineId: parseMachineId("other") }, { sourceId: parseSourceId("22222222-2222-4222-8222-222222222222") },
    { projectCwd: "/other" }, { sessionId: "session" }, { segmentId: "second" }, { runId: "run" },
    { sessionId: "" }, { runId: "" },
  ];
  const result = report(scopes.map((scope) => run([group([item(read("a"))], null)], scope)));
  assert.equal(result.routes.length, scopes.length);
  assert.equal(new Set(result.routes.map((route) => route.key)).size, scopes.length);
  assert.deepEqual(result.relationships, []);
});

test("dashboard analytics handles empty, catalog-only, bounded empty, and sparse UTC activity", () => {
  assert.deepEqual(report().activity, { kind: "empty", timezone: "UTC" });
  assert.deepEqual(report([], [catalog("unused")]).counts, zero);
  assert.deepEqual(report([], [catalog("unused")]).activity, { kind: "empty", timezone: "UTC" });
  const bounded = report([], [], { fromObservedAt: dayOne, toObservedAt: dayThree });
  assert.equal(bounded.activity.kind, "bucketed");
  if (bounded.activity.kind !== "bucketed") return;
  assert.equal(bounded.activity.bins.length, 49);
  assert.ok(bounded.activity.bins.every((bin) => JSON.stringify(bin.counts) === JSON.stringify(zero)));
  const result = report([run([group([
    item(read("a"), 1, "2026-01-01T23:59:59.999Z"),
    item(read("a"), 2, "2026-01-03T00:00:00.000Z"),
  ])])]);
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.equal(result.activity.binWidthMs, 3_600_000);
  assert.equal(result.activity.startAt, "2026-01-01T23:00:00.000Z");
  assert.equal(result.activity.endAt, "2026-01-03T01:00:00.000Z");
  assert.deepEqual(result.activity.bins.map((bin) => bin.counts.successfulReads), [1, ...Array.from({ length: 24 }, () => 0), 1]);
  const extended = report([run([group([item(read("a"))])])], [], { toObservedAt: dayThree });
  assert.equal(extended.activity.kind === "bucketed" && extended.activity.bins.length, 49);
});

test("skill trends count distinct read-bearing runs per UTC bin and exact skill name", () => {
  const result = report([
    run([group([
      item(read("a"), 1), item(read("a"), 2),
      item({ kind: "read-result", skill: skill("a", "/variant/SKILL.md"), model: null, outcome: "success", toolCallId: "variant" }, 3),
      item(read("b"), 4), item(read("a"), 5, dayThree), item(read("undated"), 6, "invalid"),
    ])]),
    run([group([item(read("b")), item(read("A"), 2)])], { runId: "second" }),
    run([group([item(read("failure", null, "error"))])], { runId: "failed" }),
    run([group([item({ kind: "command-intent", skillName: "a", source: "interactive" })])], { runId: "request" }),
    run([group([item({ kind: "wrapper-observed", skill: skill("a"), wrapperSource: "expanded-prompt" })])], { runId: "wrapper" }),
  ]);
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.deepEqual(result.activity.bins.map(({ readRuns, skills }) => ({ readRuns, skills })), [
    { readRuns: 2, skills: [{ name: "a", readRuns: 1, successfulReads: 3 }, { name: "A", readRuns: 1, successfulReads: 1 }, { name: "b", readRuns: 2, successfulReads: 2 }] },
    ...Array.from({ length: 47 }, () => ({ readRuns: 0, skills: [] })),
    { readRuns: 1, skills: [{ name: "a", readRuns: 1, successfulReads: 1 }] },
  ]);
  assert.equal(result.activity.bins[0]?.counts.successfulReads, 6);
  for (const bin of result.activity.bins) {
    assert.equal(bin.skills.reduce((total, skill) => total + skill.successfulReads, 0), bin.counts.successfulReads);
  }
});

test("skill trends count repeated reads while retaining distinct run counts", () => {
  const runs = [
    run([group([item(read("a")), item(read("a"), 2), item(read("b"), 3)])]),
    run([group([item(read("b"))])], { runId: "other" }),
  ];
  const original = report(runs).activity;
  const busier = report(Array.from({ length: 4 }, (_, copy) => runs.map(entry => ({ ...entry, segmentId: "copy-" + copy }))).flat()).activity;
  assert.equal(original.kind, "bucketed"); assert.equal(busier.kind, "bucketed");
  if (original.kind !== "bucketed" || busier.kind !== "bucketed") return;
  const shares = (activity: typeof original) => activity.bins.map(bin => bin.skills.map(entry => entry.readRuns / bin.readRuns));
  assert.deepEqual(shares(original), [[0.5, 1]]);
  assert.deepEqual(shares(busier), shares(original));
  assert.deepEqual(original.bins[0]?.skills.map(skill => skill.successfulReads), [2, 2]);
  assert.deepEqual(busier.bins[0]?.skills.map(skill => skill.successfulReads), [8, 8]);
});

test("skill trends deduplicate runs across days inside an adaptive bin", () => {
  const result = report([run([group([item(read("a"), 1), item(read("a"), 2, "2026-01-02T12:00:00.000Z")])])], [], {
    fromObservedAt: "2026-01-01T00:00:00.000Z", toObservedAt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.ok(result.activity.binWidthMs > 86_400_000);
  assert.equal(result.activity.bins[0]?.readRuns, 1);
  assert.deepEqual(result.activity.bins[0]?.skills, [{ name: "a", readRuns: 1, successfulReads: 2 }]);
  assert.ok(result.activity.bins.slice(1).every(bin => bin.readRuns === 0 && bin.skills.length === 0));
});

test("dashboard analytics bounds multi-year activity without losing evidence counts", () => {
  const result = report([run([group([item(read("a")), item(read("a"), 2, dayThree)])])], [], {
    fromObservedAt: "2000-01-01T00:00:00.000Z", toObservedAt: "2050-12-31T23:59:59.999Z",
  });
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.ok(result.activity.bins.length <= 90);
  assert.ok(result.activity.binWidthMs > 86_400_000);
  assert.equal(result.activity.bins.at(-1)?.endAt, "2051-01-01T00:00:00.000Z");
  assert.equal(result.activity.bins.reduce((sum, bin) => sum + bin.counts.successfulReads, 0), 2);
});

test("dashboard analytics retains undated evidence with explicit chart coverage and valid recency", () => {
  const result = report([
    run([group([
      item(read("a"), 1, "invalid"), item(read("a"), 2, "+275760-09-13T00:00:00.000Z"),
      item(read("a"), 3, dayOne), item(read("a"), 4, "2026-01-03T14:00:00+02:00"),
    ])]),
    run([group([item(read("b"), 5, "not a date")])], { segmentId: "undated" }),
  ]);
  assert.equal(result.counts.successfulReads, 5);
  assert.equal(result.coverage.undatedEvidence, 3);
  assert.equal(result.routes[0]?.firstEvidenceAt, dayOne);
  assert.equal(result.routes[0]?.lastEvidenceAt, dayThree);
  assert.equal(result.routes[1]?.lastEvidenceAt, null);
  assert.equal(result.skills.find((entry) => entry.label === "b")?.lastEvidenceAt, null);
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  const chartReads = result.activity.bins.reduce((sum, bin) => sum + bin.counts.successfulReads, 0);
  assert.equal(chartReads + result.coverage.undatedEvidence, result.counts.successfulReads);
  const undated = report([run([group([item(read("a"), 1, "invalid")])])]);
  assert.equal(undated.activity.kind, "empty");
  assert.equal(undated.coverage.undatedEvidence, 1);
  assert.equal(undated.counts.successfulReads, 1);
  const mixed = report([run([group([
    item(read("a"), 1, "invalid"), item(read("a", null, "error"), 2, "invalid"),
    item({ kind: "command-intent", skillName: "a", source: "rpc" }, 3, "invalid"),
    item({ kind: "wrapper-observed", skill: skill("a"), wrapperSource: "expanded-prompt" }, 4, "invalid"),
    item(read("a"), 5, dayOne),
  ])])]);
  assert.equal(mixed.coverage.undatedEvidence, 4);
  assert.equal(mixed.activity.kind, "bucketed");
  if (mixed.activity.kind !== "bucketed") return;
  const chartTotal = mixed.activity.bins.reduce((sum, bin) => sum + Object.values(bin.counts).reduce((a, b) => a + b, 0), 0);
  assert.equal(Object.values(mixed.counts).reduce((a, b) => a + b, 0), chartTotal + mixed.coverage.undatedEvidence);
});

test("dashboard analytics exact-name rollups aggregate model cells without merging case or identity", () => {
  const one = { provider: "one", id: "same" };
  const two = { provider: "two", id: "same" };
  const otherPath = { ...read("a", one), skill: skill("a", "/other/a/SKILL.md") };
  const result = report([
    run([group([item(read("a", one)), item(otherPath, 2), item(read("A", two), 3)])]),
    run([group([item(read("a", two)), item(read("a", null, "error"), 2)])], { machineId: parseMachineId("other") }),
  ], [catalog("a")]);
  assert.equal(result.skillsRead, 2);
  assert.equal(result.skills.length, 4);
  assert.equal(result.skillGroups.length, 2);
  const grouped = result.skillGroups.find((entry) => entry.name === "a");
  assert.equal(grouped?.cataloged, true);
  assert.equal(grouped?.skillKeys.length, 3);
  assert.deepEqual(grouped?.counts, { requests: 0, wrappers: 0, successfulReads: 3, failedReads: 1 });
  assert.equal(grouped?.models.find((entry) => entry.model?.provider === "one")?.successfulReads, 2);
  assert.equal(grouped?.models.find((entry) => entry.model?.provider === "two")?.successfulReads, 1);
  assert.equal(grouped?.models.find((entry) => entry.model === null)?.failedReads, 1);
});

test("dashboard analytics consumes real store scope, same-turn grouping, and filtered gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-analytics-"));
  const store = openHotplateStore({ databasePath: join(directory, "test.sqlite") });
  const scope: Observation["scope"] = {
    projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "startup",
    runId: "run", turnId: "same-turn", leafId: "leaf",
  };
  const evidence: Evidence[] = [
    { kind: "catalog-snapshot", skills: [skill("unused")] },
    read("a", { provider: "one", id: "shared" }), read("b", { provider: "two", id: "shared" }),
    read("c", { provider: "one", id: "shared" }), { kind: "capture-gap", dropped: 2, reason: "queue-overflow" },
    { kind: "command-intent", skillName: "mako", source: "rpc" },
  ];
  try {
    await store.record(evidence.map((entry, sequence) => ({
      id: `id-${sequence}`, producerId: "producer", sequence, observedAt: `2026-01-01T12:00:0${sequence}.000Z`, scope, evidence: entry,
    })));
    await store.record({ id: "other", producerId: "producer", sequence: 9, observedAt: dayThree,
      scope: { ...scope, projectCwd: "/other" }, evidence: read("outside") });
    const filters: DashboardFilter[] = [
      { projectCwd: "/project" }, { modelProvider: "one" }, { source: "rpc" },
      { sessionId: "absent" }, { runId: null }, { machineId: parseMachineId("absent") },
      { fromObservedAt: "2026-01-01T12:00:02.000Z", toObservedAt: "2026-01-01T12:00:03.000Z" },
    ];
    const results = [];
    for (const filter of filters) results.push(buildDashboardReport({ filter,
      skills: await store.querySkillTable(filter), chains: await store.querySkillChain(filter) }));
    const [project, model, source, session, nullRun, machine, time] = results;
    assert.equal(project?.counts.successfulReads, 3);
    assert.ok(project?.routes[0]?.steps.some((step) => step.kind === "observations" && step.items.length === 3));
    assert.equal(model?.counts.successfulReads, 2);
    assert.equal(model?.counts.requests, 0);
    assert.deepEqual(model?.relationships, []);
    assert.equal(model?.coverage.captureGaps, 1);
    assert.equal(model?.coverage.droppedObservations, 2);
    assert.equal(model?.coverage.filteredOmissions, 3);
    assert.equal(model?.skills.find((entry) => entry.label === "unused")?.cataloged, true);
    assert.deepEqual(source?.counts, { ...zero, requests: 1 });
    assert.equal(source?.models.length, 0);
    assert.deepEqual(session?.counts, zero);
    assert.deepEqual(nullRun?.counts, zero);
    assert.deepEqual(machine?.counts, zero);
    assert.equal(session?.skills.find((entry) => entry.label === "unused")?.lastEvidenceAt, null);
    assert.equal(time?.counts.successfulReads, 2);
    assert.equal(time?.activity.kind === "bucketed" && time.activity.bins.length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("hourly activity uses exact evidence timestamps, offsets, inclusive edges, and per-hour run sets", () => {
  const result = report([run([group([
    item(read("a"), 1, "2026-01-01T10:59:59.999Z"),
    item(read("a"), 2, "2026-01-01T11:00:00.000Z"),
    item(read("a"), 3, "2026-01-01T13:00:00+02:00"),
    item(read("a", null, "error"), 4, "2026-01-01T11:00:00.000Z"),
    item({ kind: "command-intent", skillName: "a", source: "rpc" }, 5, "2026-01-01T10:45:00.000Z"),
    item({ kind: "wrapper-observed", skill: skill("a"), wrapperSource: "expanded-prompt" }, 6, "2026-01-01T11:00:00.000Z"),
  ])])], [], { fromObservedAt: "2026-01-01T10:30:00.000Z", toObservedAt: "2026-01-01T11:00:00.000Z" });
  assert.equal(result.activity.kind, "bucketed");
  if (result.activity.kind !== "bucketed") return;
  assert.equal(result.activity.binWidthMs, 3_600_000);
  assert.deepEqual(result.activity.bins.map(bin => bin.counts), [
    { requests: 1, wrappers: 0, successfulReads: 1, failedReads: 0 },
    { requests: 0, wrappers: 1, successfulReads: 2, failedReads: 1 },
  ]);
  assert.deepEqual(result.activity.bins.map(bin => [bin.readRuns, bin.skills]), [
    [1, [{ name: "a", readRuns: 1, successfulReads: 1 }]], [1, [{ name: "a", readRuns: 1, successfulReads: 2 }]],
  ]);
});

test("activity resolution uses elapsed scope before UTC boundary alignment", () => {
  for (const [end, width, length] of [
    ["2026-01-08T10:30:00.000Z", 3_600_000, 169],
    ["2026-01-08T10:30:00.001Z", 86_400_000, 8],
    ["2026-01-01T10:30:00.000Z", 3_600_000, 1],
  ] satisfies [string, number, number][]) {
    const activity = report([], [], { fromObservedAt: "2026-01-01T10:30:00.000Z", toObservedAt: end }).activity;
    assert.equal(activity.kind, "bucketed");
    if (activity.kind !== "bucketed") continue;
    assert.equal(activity.binWidthMs, width);
    assert.equal(activity.bins.length, length);
    assert.ok(activity.bins.every(bin => bin.readRuns === 0));
  }
});
