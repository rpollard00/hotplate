import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contentMeasures, isContentMeasure, type ContentQuery, type ContentReport } from "../src/content-analytics.js";
import type { Evidence, Observation } from "../src/domain.js";
import type { ResourceAccessEvidence, ResourceLocation } from "../src/resource-domain.js";
import { parseMachineId, parseSourceId } from "../src/observation.js";
import { openAggregateStore, openHotplateReadStore, openHotplateStore } from "../src/store.js";

const start = Date.parse("2026-10-20T01:00:00.000Z");
const at = (milliseconds: number) => new Date(start + milliseconds).toISOString();
const model = { provider: "one", id: "shared" };
const skill = { name: "plugin:mako", canonicalPath: "/skills/mako/SKILL.md", version: null };
const query: ContentQuery = { content: "both", measure: "activity", split: "item", filter: {}, selection: { kind: "all" } };

function location(path = skill.canonicalPath, overrides: Partial<ResourceLocation> = {}): ResourceLocation {
  return { filesystemId: "mount-one", canonicalPath: path, observedPath: path, rootPath: "/skills", kind: path.endsWith("SKILL.md") ? "skill" : "reference", ownerSkillPath: skill.canonicalPath, ...overrides };
}
function access(path = skill.canonicalPath, overrides: Partial<ResourceAccessEvidence> = {}): ResourceAccessEvidence {
  return { kind: "resource-access", resource: location(path), operationId: "operation", mechanism: "host-tool", access: "read", outcome: "success", model, process: null, attribution: "session", ...overrides };
}
function read(operation = "operation"): Extract<Evidence, { kind: "read-result" }> {
  return { kind: "read-result", skill, toolCallId: operation, outcome: "success", model };
}
function fact(id: string, evidence: Evidence, milliseconds = 0, overrides: Partial<Observation> = {}): Observation {
  return { id, producerId: id, sequence: 0, observedAt: at(milliseconds), host: "claude-code",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "actor", segmentReason: "unknown", runId: null, turnId: null, leafId: null }, evidence, ...overrides };
}
function conserved(report: ContentReport): void {
  assert.equal(report.selection.rows.reduce((sum, row) => sum + row.count, 0), report.selection.count);
  assert.equal(report.selection.series.reduce((sum, series) => sum + series.count, 0), report.selection.count);
  assert.equal(report.displayed.series.reduce((sum, series) => sum + series.count, 0), report.displayed.count);
  if (report.displayed.activity.kind === "bucketed") {
    assert.equal(report.displayed.activity.bins.reduce((sum, bin) => sum + bin.count, 0), report.displayed.count);
    for (const bin of report.displayed.activity.bins) assert.equal(bin.values.reduce((sum, value) => sum + value.count, 0), bin.count);
  }
  for (const row of report.selection.rows) {
    assert.equal(row.cells.reduce((sum, cell) => sum + cell.count, 0), row.count);
    if (row.identity.kind === "owner") {
      assert.equal(row.children.reduce((sum, child) => sum + child.count, 0), row.count);
      for (const key of Object.keys(row.counts)) if (isContentMeasure(key) && key !== "activity") {
        assert.equal(row.children.reduce((sum, child) => sum + child.counts[key], 0), row.counts[key]);
      }
    }
  }
}

test("content measures conserve disjoint evidence and group support-only owners without changing Skills", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([
      fact("legacy", read()), fact("mirror", access(), 1),
      fact("failure", access("/skills/mako/references/error.md", { operationId: "failure", outcome: "error" }), 2),
      fact("attempt", access("/skills/mako/references/attempt.md", { operationId: "attempt", access: "attempt", outcome: "unknown", model: null }), 3),
      fact("open", access("/skills/mako/references/open.md", { operationId: "open", mechanism: "fanotify", access: "open", outcome: "unknown", model: null, attribution: "harness" }), 4),
      fact("access", access("/skills/mako/references/access.md", { operationId: "access", mechanism: "fanotify", access: "access", outcome: "unknown", model: null }), 5),
      fact("invoke", { kind: "skill-invocation", skill: { ...skill, canonicalPath: null }, toolCallId: "invoke", outcome: "success", model }),
      fact("invoke-error", { kind: "skill-invocation", skill: { ...skill, canonicalPath: null }, toolCallId: "invoke-error", outcome: "error", model }),
      fact("request", { kind: "command-intent", skillName: skill.name, source: "rpc" }),
      fact("wrapper", { kind: "wrapper-observed", skill, wrapperSource: "expanded-prompt" }),
      fact("support-only", access("/skills/other/references/support.md", { operationId: "support", resource: location("/skills/other/references/support.md", { ownerSkillPath: "/skills/other/SKILL.md" }) })),
      fact("inventory", { kind: "inventory-snapshot", scanId: "inventory", filesystemId: "mount-one", rootPath: "/skills", origin: "configured", scope: "account", phase: "batch", batchIndex: 0, resources: [location("/skills/inventory-only.md", { ownerSkillPath: null })], error: null }),
    ]);
    const expected = { successfulReads: 2, failedReads: 1, readAttempts: 1, fsOpens: 1, fsAccesses: 1, invocations: 1, invocationFailures: 1, requests: 1, wrappers: 1 };
    for (const measure of Object.keys(contentMeasures)) if (isContentMeasure(measure)) for (const split of ["item", "agent", "model", "agent-model"] as const) {
      const result = await store.queryContentAnalytics({ ...query, measure, split });
      assert.deepEqual(result.overall.counts, expected);
      assert.equal(result.overall.count, measure === "activity" ? 10 : expected[measure]);
      conserved(result);
      const owner = result.selection.rows.find(row => row.identity.kind === "owner" && row.identity.location.canonicalPath === skill.canonicalPath);
      assert.ok(owner); assert.equal(owner.counts.fsOpens, 1); assert.equal(owner.counts.failedReads, 1);
      assert.equal(result.selection.rows.some(row => JSON.stringify(row.identity).includes("inventory-only")), false);
    }
    const result = await store.queryContentAnalytics(query);
    assert.ok(result.selection.rows.some(row => row.identity.kind === "owner" && row.label === "other" && row.count === 1));
    assert.equal((await store.queryOverview({})).successfulReadCount, 1);
    const resources = await store.queryContentAnalytics({ ...query, content: "resources", measure: "activity" });
    assert.equal(resources.overall.count, 6); assert.ok(resources.selection.rows.every(row => row.identity.kind === "file" && row.children.length === 0));
    assert.equal(resources.overall.lastEvidenceAt, at(5));
  } finally { await store.close(); }
});

test("mirrors resolve before inclusive global and half-open selected boundaries using legacy time", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([fact("read", read(), 0), fact("resource", access(), 1), fact("newest", access("/skills/mako/playbooks/new.md", { operationId: "newest" }), 3_600_000)]);
    const before = await store.queryContentAnalytics({ ...query, filter: { toObservedAt: at(0) } });
    assert.equal(before.overall.count, 1); assert.equal(before.overall.lastEvidenceAt, at(0));
    const after = await store.queryContentAnalytics({ ...query, filter: { fromObservedAt: at(1), toObservedAt: at(2) } });
    assert.equal(after.overall.count, 0);
    const files = await store.queryContentAnalytics({ ...query, content: "resources", measure: "activity", filter: { fromObservedAt: at(1), toObservedAt: at(1) } });
    assert.equal(files.overall.count, 1);
    const full = await store.queryContentAnalytics(query);
    const selected = await store.queryContentAnalytics({ ...query, selection: { kind: "interval", startAt: at(0), endAt: at(1) } });
    assert.equal(selected.selection.count, 1); assert.deepEqual(selected.displayed, full.displayed);
    const empty = await store.queryContentAnalytics({ ...query, selection: { kind: "interval", startAt: at(1), endAt: at(3_600_000) } });
    assert.equal(empty.selection.count, 0); assert.deepEqual(empty.displayed, full.displayed);
    assert.deepEqual(empty.selection.series.map(series => series.key), full.selection.series.map(series => series.key));
    assert.equal(full.overall.lastEvidenceAt, at(3_600_000));
    assert.equal(full.displayed.activity.kind, "bucketed");
    if (full.displayed.activity.kind === "bucketed") assert.equal(full.displayed.activity.endAt, at(7_200_000));
  } finally { await store.close(); }
});

test("mirror matching handles catalog entrypoints and preserves aliases, namespaces, conflicting outcomes and reused operations", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const standalone = "/skills/catalog-entry.md";
    await store.record([fact("catalog-read", { ...read("catalog"), skill: { ...skill, canonicalPath: standalone } }),
      fact("catalog-resource", access(standalone, { operationId: "catalog", resource: location(standalone, { ownerSkillPath: null }) })),
      fact("alias-read", read("alias")), fact("real", access(skill.canonicalPath, { operationId: "alias" })),
      fact("alias", access(skill.canonicalPath, { operationId: "alias", resource: location(skill.canonicalPath, { observedPath: "/alias/mako/SKILL.md" }) })),
      fact("fs-read", read("namespace")), fact("fs-one", access(skill.canonicalPath, { operationId: "namespace" })),
      fact("fs-two", access(skill.canonicalPath, { operationId: "namespace", resource: location(skill.canonicalPath, { filesystemId: "mount-two" }) })),
      fact("conflict-read", read("conflict")), fact("conflict-resource", access(skill.canonicalPath, { operationId: "conflict", outcome: "error" })),
      fact("session-read", read("session")), fact("session-resource", access(skill.canonicalPath, { operationId: "session" }), 0, { scope: { ...fact("scope", read()).scope, sessionId: "another" } }),
      fact("native-invoke", { kind: "skill-invocation", skill, toolCallId: "invoke", outcome: "success", model }),
      fact("native-file", access(skill.canonicalPath, { operationId: "invoke" })),
    ]);
    const result = await store.queryContentAnalytics(query);
    assert.equal(result.overall.count, 13); conserved(result);
    assert.equal(result.selection.rows.filter(row => row.identity.kind === "owner").length, 2);
    assert.ok(result.selection.rows.some(row => row.identity.kind === "skill" && row.count >= 1));
    assert.ok(result.selection.rows.some(row => row.identity.kind === "file" && row.identity.location.canonicalPath === standalone && row.count === 1));
  } finally { await store.close(); }
});

test("content facets and exact scopes retain resource-only models, unknown attribution and command source meaning", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([
      fact("known", access()),
      fact("other-model", access("/skills/mako/two.md", { operationId: "two", model: { provider: "two", id: "shared" } })),
      fact("unknown", access("/skills/mako/unknown.md", { operationId: "unknown", model: null })),
      fact("other-host", access("/skills/mako/other.md", { operationId: "other", model: null }), 0, { host: "codex" }),
      fact("other-project", access("/skills/mako/project.md", { operationId: "project" }), 0, { scope: { ...fact("scope", read()).scope, projectCwd: "/other" } }),
      fact("unowned", access("/skills/unowned.md", { operationId: "unowned", resource: location("/skills/unowned.md", { ownerSkillPath: null }), mechanism: "fanotify", access: "open", outcome: "unknown", model: null, attribution: "non-agent" }), 0, { host: "unknown" }),
      fact("uncertain", access("/skills/uncertain.md", { operationId: "uncertain", mechanism: "fanotify", access: "access", outcome: "unknown", model: null, attribution: "unknown" }), 0, { host: "unknown" }),
      fact("request", { kind: "command-intent", skillName: "mako", source: "rpc" }),
    ]);
    const exact = await store.queryContentAnalytics({ ...query, split: "agent-model", filter: { projectCwd: "/project", host: "claude-code", modelSelection: { kind: "known", model } } });
    assert.equal(exact.overall.count, 1); assert.equal(exact.selection.series.length, 1);
    assert.ok(exact.filterOptions.agentModelPairs.some(pair => pair.host === "codex" && pair.model === null));
    assert.ok(exact.filterOptions.agentModelPairs.some(pair => pair.model?.provider === "two"));
    const impossible = await store.queryContentAnalytics({ ...query, filter: { host: "codex", modelSelection: { kind: "known", model } } });
    assert.equal(impossible.overall.count, 0);
    const unknown = await store.queryContentAnalytics({ ...query, split: "agent-model", filter: { modelSelection: { kind: "unknown" } } });
    assert.equal(unknown.overall.count, 4); assert.ok(unknown.displayed.series.some(series => series.actor === "non-agent"));
    assert.ok(unknown.displayed.series.some(series => series.actor === "unknown"));
    const requests = await store.queryContentAnalytics({ ...query, split: "model", filter: { source: "rpc" } });
    assert.equal(requests.overall.count, 1); assert.equal(requests.selection.series[0]?.modelAttribution, "none");
    const resourceRequests = await store.queryContentAnalytics({ ...query, content: "resources", measure: "activity", filter: { source: "rpc" } });
    assert.equal(resourceRequests.overall.count, 0);
  } finally { await store.close(); }
});

test("physical ownership changes preserve owner-series and grid conservation; resource mode remains flat", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    const path = "/skills/shared/file.md";
    await store.record([fact("old", access(path, { resource: location(path) })),
      fact("new", access(path, { operationId: "new", resource: location(path, { ownerSkillPath: "/skills/new/SKILL.md" }) }), 1000)]);
    const grouped = await store.queryContentAnalytics(query);
    assert.equal(grouped.selection.rows.length, 2); conserved(grouped);
    assert.equal(new Set(grouped.selection.rows.flatMap(row => row.children.map(child => child.key))).size, 2);
    for (const row of grouped.selection.rows) assert.equal(grouped.displayed.series.find(series => series.key === row.key)?.count, row.count);
    const flat = await store.queryContentAnalytics({ ...query, content: "resources", measure: "activity" });
    assert.equal(flat.selection.rows.length, 1); assert.equal(flat.selection.rows[0]?.count, 2);
  } finally { await store.close(); }
});

test("content source identities remain distinct in an aggregate, including identical observation and operation ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-content-source-"));
  const databasePath = join(directory, "aggregate.sqlite");
  const aggregate = openAggregateStore({ databasePath });
  try {
    const sources = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].map(sourceId => ({ machineId: parseMachineId("machine"), sourceId: parseSourceId(sourceId) }));
    for (const source of sources) await aggregate.ingest({ source, observations: [fact("legacy", read()), fact("resource", access(), 1)] });
    const opened = openHotplateReadStore({ databasePath }); assert.equal(opened.kind, "ready");
    if (opened.kind !== "ready") return;
    try {
      const result = await opened.store.queryContentAnalytics(query);
      assert.equal(result.overall.count, 2); assert.equal(result.selection.rows.length, 2); conserved(result);
      assert.notEqual(result.selection.rows[0]?.key, result.selection.rows[1]?.key);
    } finally { await opened.store.close(); }
  } finally { await aggregate.close(); await rm(directory, { recursive: true, force: true }); }
});

test("undated evidence stays out of chart totals and exact selections", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([fact("dated", access()), fact("undated", access("/skills/mako/undated.md", { operationId: "undated" }), 0, { observedAt: "undated" })]);
    const result = await store.queryContentAnalytics(query);
    assert.equal(result.overall.count, 2); assert.equal(result.overall.undatedCount, 1); assert.equal(result.displayed.count, 1);
    const selected = await store.queryContentAnalytics({ ...query, selection: { kind: "interval", startAt: at(0), endAt: at(1) } });
    assert.equal(selected.selection.count, 1); assert.equal(selected.selection.undatedCount, 0);
  } finally { await store.close(); }
});

test("unowned filesystem candidates prevent ambiguous legacy ownership", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([
      fact("wrapper", { kind: "wrapper-observed", skill, wrapperSource: "expanded-prompt" }),
      fact("owned", access()),
      fact("unowned", access(skill.canonicalPath, { operationId: "unowned", resource: location(skill.canonicalPath, { filesystemId: "other-mount", ownerSkillPath: null }) })),
    ]);
    const result = await store.queryContentAnalytics(query);
    assert.equal(result.selection.rows.length, 3); conserved(result);
    assert.equal(result.selection.rows.find(row => row.identity.kind === "skill")?.counts.wrappers, 1);
    assert.equal(result.selection.rows.find(row => row.identity.kind === "owner")?.counts.wrappers, 0);
  } finally { await store.close(); }
});
