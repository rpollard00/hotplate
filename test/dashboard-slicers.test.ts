import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DashboardFilter, Evidence, Observation } from "../src/domain.js";
import { openHotplateStore } from "../src/store.js";
import { startDashboardServer } from "../src/server.js";

const at = "2026-01-01T12:00:00.000Z";
const skill = { name: "plugin:mako", canonicalPath: "/skills/mako/SKILL.md", version: null };
const one = { provider: "one", id: "shared" };
const two = { provider: "two", id: "shared" };
function observation(id: string, evidence: Evidence, host: Observation["host"] = "codex", projectCwd = "/project"): Observation {
  return { id, producerId: "slicers", sequence: Number(id), observedAt: at, ...(host === undefined ? {} : { host }), scope: { projectCwd, sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "startup", runId: "run", turnId: null, leafId: null }, evidence };
}
const fixture = [
  observation("1", { kind: "read-result", skill, model: one, outcome: "success", toolCallId: "1" }),
  observation("2", { kind: "read-result", skill, model: two, outcome: "success", toolCallId: "2" }, "claude-code"),
  observation("3", { kind: "read-result", skill, model: null, outcome: "success", toolCallId: "3" }),
  observation("4", { kind: "skill-invocation", skill, model: null, outcome: "error", toolCallId: "4" }),
  observation("5", { kind: "read-attempt", skill, model: null, toolCallId: "5" }),
  observation("6", { kind: "skill-invocation", skill, model: one, outcome: "success", toolCallId: "6" }),
  observation("7", { kind: "command-intent", skillName: skill.name, source: "rpc" }),
  observation("8", { kind: "wrapper-observed", skill, wrapperSource: "expanded-prompt" }),
  observation("9", { kind: "read-result", skill, model: two, outcome: "success", toolCallId: "9" }, "pi", "/other"),
];

test("SQLite exact and unknown slicers agree across SQL views and gap-preserving chain evidence", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    assert.equal((await store.record(fixture)).accepted, fixture.length);
    const cases: readonly [DashboardFilter, number, number, number][] = [
      [{ modelSelection: { kind: "known", model: one } }, 1, 1, 0],
      [{ modelSelection: { kind: "known", model: two } }, 2, 0, 0],
      [{ modelSelection: { kind: "unknown" } }, 1, 1, 1],
      [{ modelSelection: { kind: "known", model: one }, host: "claude-code" }, 0, 0, 0],
    ];
    for (const [filter, reads, invocations, attempts] of cases) {
      const overview = await store.queryOverview(filter);
      assert.equal(overview.successfulReadCount, reads);
      assert.equal(overview.skillInvocationCount, invocations);
      assert.equal(overview.readAttemptCount, attempts);
      assert.equal(overview.commandIntentCount, 0); assert.equal(overview.wrapperObservedCount, 0);
      const chain = await store.querySkillChain(filter);
      const items = chain.runs.flatMap(run => run.steps.flatMap(step => step.kind === "observations" ? step.items : []));
      assert.equal(items.length, reads + invocations + attempts);
      assert.ok(items.every(item => "model" in item.evidence));
      assert.equal((await store.querySkillTable(filter)).rows.reduce((sum, row) => sum + row.successfulReadCount, 0), reads);
    }
    const unknown = await store.querySkillChain({ modelSelection: { kind: "unknown" } });
    assert.ok(unknown.runs.some(run => run.steps.some(step => step.kind === "gap" && step.reason === "filtered-intermediates")));
    assert.equal((await store.queryOverview({ modelProvider: null })).commandIntentCount, 1, "legacy null semantics remain");
  } finally { await store.close(); }
});

test("facets ignore host/model self-selection and honor project, period, source, and observed exact pairs", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record(fixture);
    const options = await store.queryFilterOptions({ projectCwd: "/project", host: "pi", modelSelection: { kind: "known", model: two } });
    assert.deepEqual(options.agentModelPairs, [ { host: "claude-code", model: two }, { host: "codex", model: null }, { host: "codex", model: one } ]);
    assert.deepEqual((await store.queryFilterOptions({ fromObservedAt: "2026-01-02T00:00:00.000Z" })).agentModelPairs, []);
    assert.deepEqual((await store.queryFilterOptions({ source: "rpc" })).agentModelPairs, []);
    assert.equal((await store.queryFilterOptions({ projectCwd: "/other" })).agentModelPairs[0]?.host, "pi");
  } finally { await store.close(); }
});

test("HTTP model tuple validates and preserves exact provider identity, unknown, and impossible combinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-slicers-"));
  const databasePath = join(dir, "metrics.sqlite");
  const store = openHotplateStore({ databasePath });
  await store.record(fixture); await store.close();
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    const get = async (model: string, host?: string) => {
      const params = new URLSearchParams({ model }); if (host !== undefined) params.set("host", host);
      const response = await fetch(`${server.url}/api/dashboard?${params}`);
      assert.equal(response.status, 200);
      const value: unknown = await response.json();
      assert.ok(value !== null && typeof value === "object");
      return value;
    };
    const known = await get(JSON.stringify(["two", "shared"]));
    assert.ok("kind" in known && known.kind === "ready");
    assert.ok("report" in known && known.report !== null && typeof known.report === "object" && "counts" in known.report);
    assert.deepEqual(known.report.counts, { requests: 0, wrappers: 0, successfulReads: 2, failedReads: 0, readAttempts: 0, invocations: 0 });
    const unknown = await get("unknown");
    assert.ok("report" in unknown && unknown.report !== null && typeof unknown.report === "object" && "counts" in unknown.report);
    assert.deepEqual(unknown.report.counts, { requests: 0, wrappers: 0, successfulReads: 1, failedReads: 0, readAttempts: 1, invocations: 1 });
    const impossible = await get(JSON.stringify(["one", "shared"]), "claude-code");
    assert.ok("report" in impossible && impossible.report !== null && typeof impossible.report === "object" && "routes" in impossible.report);
    assert.ok("counts" in impossible.report);
    assert.deepEqual(impossible.report.counts, { requests: 0, wrappers: 0, successfulReads: 0, failedReads: 0, readAttempts: 0, invocations: 0 });
    assert.ok(Array.isArray(impossible.report.routes) && impossible.report.routes.every(route => route.steps.every((step: {kind: string}) => step.kind === "gap")));
    for (const invalid of ["not-json", "null", "{}", '["one"]', '["","shared"]', '["one",1]', '["one","shared","extra"]']) {
      const payload = await get(invalid); assert.ok("kind" in payload && payload.kind === "error");
    }
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("resource model slices restrict activity while retaining inventory context and unknown attribution", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  const resource = { filesystemId: "local:fs", canonicalPath: "/skills/file.md", observedPath: "/skills/file.md", rootPath: "/skills", kind: "reference", ownerSkillPath: null } as const;
  try {
    const base = { kind: "inventory-snapshot", scanId: "scan", filesystemId: "local:fs", rootPath: "/skills", origin: "configured", scope: "project" } as const;
    await store.record([
      observation("10", { ...base, phase: "started", resources: [], error: null }),
      observation("11", { ...base, phase: "batch", batchIndex: 0, resources: [resource], error: null }),
      observation("12", { ...base, phase: "complete", batchCount: 1, resources: [], error: null }),
      ...[one, two, null].map((model, index) => observation(String(13 + index), { kind: "resource-access", resource, operationId: String(index), mechanism: "host-tool", access: "read", outcome: "success", model, attribution: "session", process: null })),
    ]);
    const unknown = (await store.queryResources({ modelSelection: { kind: "unknown" } })).rows[0];
    assert.equal(unknown?.presence, "present"); assert.equal(unknown?.successfulReadCount, 1); assert.equal(unknown?.attributedAccessCount, 1);
    const exact = (await store.queryResources({ modelSelection: { kind: "known", model: one } })).rows[0];
    assert.equal(exact?.presence, "present"); assert.equal(exact?.successfulReadCount, 1); assert.equal(exact?.unattributedAccessCount, 1);
    const absent = (await store.queryResources({ modelSelection: { kind: "known", model: { provider: "missing", id: "missing" } } })).rows[0];
    assert.equal(absent?.presence, "present"); assert.equal(absent?.successfulReadCount, 0); assert.equal(absent?.observation, "unknown");
  } finally { await store.close(); }
});
