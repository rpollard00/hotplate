import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "../src/domain.js";
import type { ObserverCoverageEvidence, ResourceEvidence, ResourceLocation } from "../src/resource-domain.js";
import { openHotplateStore } from "../src/store.js";

const start = Date.parse("2026-10-17T00:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const filesystemId = "scale-fixture";

function event(id: string, evidence: ResourceEvidence, seconds: number): Observation {
  return { id, producerId: id, sequence: 0, observedAt: at(seconds), host: "unknown",
    scope: { projectCwd: "[unknown project]", sessionId: null, sessionFile: null, segmentId: "observer", segmentReason: "unknown", runId: null, turnId: null, leafId: null }, evidence };
}

function coverage(rootPaths: readonly string[], status: "active" | "unavailable" | "overflow" = "active"): ObserverCoverageEvidence {
  const base = { kind: "observer-coverage", observerId: "observer", mechanism: "fanotify", filesystemId, rootPaths, heartbeatMs: 5000 } as const;
  return status === "active" ? { ...base, status, reason: null }
    : { ...base, status, reason: status === "overflow" ? "queue-overflow" : "permission-denied" };
}

function inventory(rootPath: string, count: number): Observation[] {
  const base = { kind: "inventory-snapshot", scanId: rootPath, filesystemId, rootPath, origin: "configured", scope: "account" } as const;
  const resources: ResourceLocation[] = Array.from({ length: count }, (_, i) => ({ filesystemId, rootPath,
    canonicalPath: `${rootPath}/reference-${i}.md`, observedPath: `${rootPath}/reference-${i}.md`, kind: "reference", ownerSkillPath: null }));
  return [
    event(`${rootPath}-start`, { ...base, phase: "started", resources: [], error: null }, 0),
    event(`${rootPath}-batch`, { ...base, phase: "batch", resources, batchIndex: 0, error: null }, 0),
    event(`${rootPath}-complete`, { ...base, phase: "complete", resources: [], batchCount: 1, error: null }, 0),
  ];
}

test("coverage retains separate unavailable roots and resolves overlapping root sets by event order", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([
      event("missing", coverage(["/missing"], "unavailable"), 0),
      event("valid", coverage(["/valid"]), 1),
      event("overlap", coverage(["/valid", "/other"]), 3),
      event("overflow", coverage(["/valid"], "overflow"), 4),
      event("late-delivery", coverage(["/valid"]), 2),
    ]);
    const earlier = (await store.queryResourceCoverage({ toObservedAt: at(2.5) })).rows;
    assert.deepEqual(earlier.map(row => [row.rootPath, row.status, row.lastObservedAt]), [
      ["/missing", "unavailable", at(0)], ["/valid", "active", at(2)],
    ]);
    const later = (await store.queryResourceCoverage({ toObservedAt: at(4) })).rows;
    assert.deepEqual(later.map(row => [row.rootPath, row.status, row.lastObservedAt]), [
      ["/missing", "unavailable", at(0)], ["/other", "active", at(3)], ["/valid", "overflow", at(4)],
    ]);
    assert.equal((await store.queryResourceCoverage({ toObservedAt: at(20) })).rows.find(row => row.rootPath === "/other")?.status, "stale");
  } finally { await store.close(); }
});

test("overlapping root reports retain independent coverage gaps after out-of-order delivery", async () => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  try {
    await store.record([...inventory("/one", 1), ...inventory("/two", 1),
      event("first", coverage(["/one", "/two"]), 0),
      event("last", coverage(["/one", "/two"]), 5),
      event("gap", coverage(["/one"], "overflow"), 2),
      event("other", coverage(["/two"]), 3),
      event("resume", coverage(["/one", "/two"]), 4),
      event("heartbeat", coverage(["/one", "/two"]), 1),
    ]);
    const rows = (await store.queryResources({ fromObservedAt: at(0), toObservedAt: at(5) })).rows;
    assert.deepEqual(rows.map(row => [row.resource.rootPath, row.observation]), [["/one", "unknown"], ["/two", "not-observed"]]);
    const resumed = (await store.queryResources({ fromObservedAt: at(4), toObservedAt: at(5) })).rows;
    assert.ok(resumed.every(row => row.observation === "not-observed" && row.coverageFrom === at(4) && row.coverageTo === at(5)));
  } finally { await store.close(); }
});

test("one day of coverage across 50 roots has bounded query memory with empty and populated inventory", async t => {
  const store = openHotplateStore({ databasePath: ":memory:" });
  const roots = Array.from({ length: 50 }, (_, i) => `/skills/root-${i}`);
  const report = coverage(roots);
  const reports = 17_280;
  try {
    for (let offset = 0; offset < reports; offset += 100) {
      await store.record(Array.from({ length: Math.min(100, reports - offset) }, (_, index) => {
        const sequence = offset + index;
        return event(`heartbeat-${sequence}`, report, sequence * 5);
      }));
    }
    const filter = { fromObservedAt: at(0), toObservedAt: at((reports - 1) * 5) };
    const emptyBefore = process.memoryUsage();
    const emptyStart = performance.now();
    assert.deepEqual((await store.queryResources(filter)).rows, []);
    assert.equal((await store.queryResourceCoverage(filter)).rows.length, roots.length);
    const emptyMs = performance.now() - emptyStart;
    const emptyAfter = process.memoryUsage();
    assert.ok(emptyAfter.heapUsed - emptyBefore.heapUsed < 128 * 1024 * 1024);
    await store.record(roots.flatMap(root => inventory(root, 20)));
    const populatedBefore = process.memoryUsage();
    const populatedStart = performance.now();
    const resources = (await store.queryResources(filter)).rows;
    const coverageRows = (await store.queryResourceCoverage(filter)).rows;
    const populatedMs = performance.now() - populatedStart;
    const populatedAfter = process.memoryUsage();
    assert.equal(resources.length, 1000);
    assert.ok(resources.every(row => row.observation === "not-observed" && row.coverageFrom === filter.fromObservedAt && row.coverageTo === filter.toObservedAt));
    assert.equal(coverageRows.length, 50);
    assert.ok(coverageRows.every(row => row.status === "active" && row.lastObservedAt === filter.toObservedAt));
    assert.ok(populatedAfter.heapUsed - populatedBefore.heapUsed < 128 * 1024 * 1024);
    t.diagnostic(JSON.stringify({ reports, roots: roots.length, resources: resources.length, emptyMs, populatedMs,
      emptyHeapGrowth: emptyAfter.heapUsed - emptyBefore.heapUsed, populatedHeapGrowth: populatedAfter.heapUsed - populatedBefore.heapUsed,
      rssBefore: emptyBefore.rss, rssAfter: populatedAfter.rss }));
  } finally { await store.close(); }
});
