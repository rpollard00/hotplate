import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/domain.js";
import type { ContentQuery, ContentRow, ContentTimelines } from "../src/content-analytics.js";
import { openHotplateStore } from "../src/store.js";
import { startDashboardServer } from "../src/server.js";

const at = (hours: number) => new Date(Date.parse("2026-10-20T00:00:00.000Z") + hours * 3_600_000).toISOString();
const query: ContentQuery = { content: "both", measure: "toolActivity", split: "agent-model", filter: {}, selection: { kind: "all" } };
function fact(id: string, hours: number, host: "codex" | "claude-code", dated = true): Observation {
  return { id, producerId: id, sequence: 0, observedAt: dated ? at(hours) : hours === -1 ? "+275760-09-13T00:00:00.000Z" : "undated", host,
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: "run", turnId: null, leafId: null },
    evidence: { kind: "resource-access", resource: { filesystemId: "fs", rootPath: "/skills", canonicalPath: `/skills/mako/${id === "support" ? "references/use.md" : "SKILL.md"}`,
      observedPath: `/skills/mako/${id === "support" ? "references/use.md" : "SKILL.md"}`, kind: id === "support" ? "reference" : "skill", ownerSkillPath: "/skills/mako/SKILL.md" },
      mechanism: "host-tool", access: "read", outcome: "success", operationId: id, model: host === "codex" ? null : { provider: "test", id: "model" }, attribution: "session", process: null } };
}
function descendants(rows: readonly ContentRow[]): ContentRow[] { return rows.flatMap(row => [row, ...descendants(row.children)]); }
function verify(timelines: ContentTimelines): void {
  for (const row of timelines.rows) {
    assert.equal(row.count, row.datedCount + row.undatedCount);
    assert.equal(row.values.reduce((sum, value) => sum + value, 0), row.datedCount);
  }
  if (timelines.kind === "bucketed") { assert.ok(timelines.binCount <= 256); for (const row of timelines.rows) assert.equal(row.values.length, timelines.binCount); }
}

test("content timelines conserve root/child/cohort counts and keep the displayed axis under selection", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([fact("read", 0, "codex"), fact("support", 2, "claude-code"), fact("undated", 3, "codex", false), fact("extreme", -1, "codex", false)]);
    for (const content of ["resources", "both"] as const) for (const split of ["item", "agent", "model", "agent-model"] as const) {
      const current: ContentQuery = content === "resources" ? { ...query, content, split, measure: "toolActivity" } : { ...query, content, split };
      const report = await store.queryContentAnalytics(current);
      const rows = descendants(report.selection.rows); const rowKeys = rows.map(row => row.key);
      const total = await store.queryContentTimelines({ query: current, projection: { rowKeys, cohortKeys: [] } }); verify(total);
      for (const row of rows) assert.equal(total.rows.find(value => value.rowKey === row.key)?.count, row.count);
      const cohortKeys = report.selection.series.map(series => series.key);
      const sliced = await store.queryContentTimelines({ query: current, projection: { rowKeys, cohortKeys } }); verify(sliced);
      for (const row of rows) for (const cohortKey of cohortKeys) assert.equal(sliced.rows.find(value => value.rowKey === row.key && value.cohortKey === cohortKey)?.count, row.cells.find(cell => cell.key === cohortKey)?.count ?? 0);
      const selected = await store.queryContentTimelines({ query: { ...current, selection: { kind: "interval", startAt: at(1), endAt: at(3) } }, projection: { rowKeys, cohortKeys: [] } }); verify(selected);
      assert.equal(total.kind, "bucketed"); assert.equal(selected.kind, "bucketed");
      if (total.kind === "bucketed" && selected.kind === "bucketed") { assert.equal(total.startAt, selected.startAt); assert.equal(total.endAt, selected.endAt); assert.equal(total.binCount, selected.binCount); }
      assert.ok(selected.rows.every(row => row.values[0] === 0));
    }
  } finally { await store.close(); }
});

test("timeline HTTP rejects unbounded projections before opening the database and returns zeros for unknown keys", async t => {
  const missing = await startDashboardServer({ databasePath: "/tmp/hotplate-timeline-missing-do-not-create.sqlite", port: 0 }); t.after(() => missing.close());
  for (const params of [new URLSearchParams(), new URLSearchParams(Array.from({ length: 25 }, (_, i): [string, string] => ["rowKey", String(i)])), new URLSearchParams([["rowKey", "x"], ["rowKey", "x"]]), new URLSearchParams([["rowKey", "x"], ...Array.from({ length: 7 }, (_, i): [string, string] => ["cohortKey", String(i)])])]) {
    const response = await fetch(`${missing.url}/api/content-timelines?${params}`);
    assert.partialDeepStrictEqual(await response.json(), { kind: "error" });
  }
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([fact("read", 0, "codex")]);
    const result = await store.queryContentTimelines({ query: { ...query, filter: { fromObservedAt: at(0), toObservedAt: at(168) } }, projection: { rowKeys: ["unknown"], cohortKeys: ["missing"] } });
    verify(result); assert.equal(result.kind, "bucketed");
    if (result.kind === "bucketed") assert.equal(result.binCount, 169);
    assert.equal(result.rows[0]?.count, 0);
  } finally { await store.close(); }
});
