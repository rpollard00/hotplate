import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { Observation } from "../src/domain.js";
import { startDashboardServer } from "../src/server.js";
import { openHotplateReadStore, openHotplateStore } from "../src/store.js";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test("content endpoint validates its discriminated parameters, preserves security and never creates a missing database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-content-api-"));
  const databasePath = join(directory, "capture.sqlite");
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    const endpoint = `${server.url}/api/content-analytics`;
    assert.deepEqual(await fetch(endpoint).then(response => response.json()), { kind: "missing", databasePath });
    assert.equal(existsSync(databasePath), false);
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 405);
    assert.equal((await fetch(endpoint, { headers: { Origin: "http://wrong.invalid" } })).status, 403);
    const head = await fetch(endpoint, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    for (const invalid of [
      "content=skills", "content=", "measure=uses", "content=resources&measure=invocations", "split=skill",
      "selectionFrom=2026-10-20", "selectionTo=2026-10-20", "selectionFrom=&selectionTo=2026-10-20",
      "selectionFrom=2026-10-20&selectionTo=2026-10-20", "selectionFrom=2026-10-21&selectionTo=2026-10-20",
      "selectionFrom=invalid&selectionTo=2026-10-20", "fromObservedAt=2026-10-21&toObservedAt=2026-10-20", "model=not-json",
    ]) {
      const response = await fetch(`${endpoint}?${invalid}`); assert.equal(response.status, 200);
      const payload = object(await response.json()); assert.equal(payload.kind, "error"); assert.equal(typeof payload.message, "string");
    }
    assert.equal(existsSync(databasePath), false);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("content endpoint defaults to tool activity and exposes compact aggregates without querying inventory or skill chains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-content-api-data-"));
  const databasePath = join(directory, "capture.sqlite");
  const store = openHotplateStore({ databasePath });
  const observation: Observation = { id: "resource", producerId: "resource", sequence: 0, observedAt: "2026-10-20T01:01:00.000Z", host: "claude-code",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null },
    evidence: { kind: "resource-access", resource: { filesystemId: "namespace", canonicalPath: "/skills/mako/references/file.md", observedPath: "/skills/mako/references/file.md", rootPath: "/skills", ownerSkillPath: "/skills/mako/SKILL.md", kind: "reference" }, operationId: "read", mechanism: "host-tool", access: "read", outcome: "success", model: { provider: "resource-only", id: "model" }, process: null, attribution: "session",
      toolRead: { kind: "structured-read", requested: { kind: "lines", start: 10, count: 20 }, delivery: { kind: "known", returned: { kind: "lines", start: 10, count: 5 }, truncated: true }, revision: { kind: "unknown" } } } };
  await store.record([
    observation,
    { ...observation, id: "opaque", sequence: 1, evidence: { kind: "tool-coverage", operationId: "opaque", family: "python", outcome: "unknown",
      model: { provider: "resource-only", id: "model" }, recognition: { kind: "opaque", reason: "unsupported-syntax" } } },
    ...Array.from({ length: 100 }, (_, index): Observation => ({
      ...observation, id: `poll-${index}`, sequence: index + 2, host: "pi", evidence: {
        kind: "resource-access", resource: { filesystemId: "namespace", canonicalPath: "/skills/polling/SKILL.md", observedPath: "/skills/polling/SKILL.md", rootPath: "/skills", ownerSkillPath: "/skills/polling/SKILL.md", kind: "skill" },
        operationId: `poll-${index}`, mechanism: "fanotify", access: "access", outcome: "unknown", model: null, process: null, attribution: "harness",
      },
    })),
  ]);
  await store.close();
  const opened = openHotplateReadStore({ databasePath }); assert.equal(opened.kind, "ready"); if (opened.kind !== "ready") return;
  const prototype: unknown = Object.getPrototypeOf(opened.store); assert.ok(prototype !== null && typeof prototype === "object"); await opened.store.close();
  const descriptors = new Map<string, PropertyDescriptor>(); const calls: string[] = [];
  for (const method of ["queryContentAnalytics", "queryResources", "queryResourceCoverage", "querySkillChain", "querySkillTable", "queryFilterOptions"]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method); assert.ok(descriptor); const original: unknown = descriptor.value; assert.equal(typeof original, "function"); assert.ok(typeof original === "function");
    descriptors.set(method, descriptor);
    Object.defineProperty(prototype, method, { ...descriptor, value: function (this: unknown, ...args: unknown[]) { calls.push(method); return Reflect.apply(original, this, args); } });
  }
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    const endpoint = `${server.url}/api/content-analytics?split=agent-model`;
    const response = await fetch(endpoint); const body = await response.text(); const payload = object(JSON.parse(body));
    assert.equal(payload.kind, "ready"); assert.deepEqual(calls, ["queryContentAnalytics"]);
    const report = object(payload.report);
    assert.equal("filterOptions" in payload, false);
    assert.partialDeepStrictEqual(report.filterOptions, { agentModelPairs: [{ host: "claude-code", model: { provider: "resource-only", id: "model" } }] });
    assert.partialDeepStrictEqual(report, { query: { content: "both", measure: "toolActivity", split: "agent-model", selection: { kind: "all" } },
      overall: { count: 1 }, displayed: { count: 1 }, coverage: { completeness: "unknown", selection: { observedOperations: 1, opaqueOperations: 1, outcomes: { unknown: 1 } } },
      selection: { count: 1, rows: [{ identity: { kind: "owner" }, count: 1, children: [{ identity: { kind: "file" }, count: 1,
        readDetails: { groups: [{ requested: { kind: "lines", start: 10, count: 20 }, delivery: { kind: "known", returned: { kind: "lines", start: 10, count: 5 }, truncated: true }, revision: { kind: "unknown" } }] },
      }] }] } });
    assert.ok(!body.includes('"producerId"') && !body.includes('"operationId"') && !body.includes('"process"') && !body.includes('"routes"'));
    const selectedPayload = object(await fetch(`${endpoint}&selectionFrom=2026-10-20T01:00:00Z&selectionTo=2026-10-20T01:01:00Z`).then(result => result.json()));
    const selectedReport = object(selectedPayload.report);
    assert.deepEqual(selectedReport.displayed, report.displayed); assert.equal(object(selectedReport.selection).count, 0);
    assert.equal(object(object(selectedReport.coverage).selection).observedOperations, 0);
    const diagnostic = object(await fetch(`${endpoint}&measure=activity`).then(result => result.json()));
    assert.equal(object(object(diagnostic.report).overall).count, 101);
    const html = await fetch(server.url).then(result => result.text());
    assert.match(html, /value="both" selected/);
    assert.match(html, /id="tool-coverage"/);
    calls.length = 0;
    await fetch(`${server.url}/api/dashboard?scope=skills`);
    assert.deepEqual(calls.toSorted(), ["queryFilterOptions", "querySkillChain", "querySkillTable"]);
  } finally {
    await server.close();
    for (const [method, descriptor] of descriptors) Object.defineProperty(prototype, method, descriptor);
    await rm(directory, { recursive: true, force: true });
  }
});
