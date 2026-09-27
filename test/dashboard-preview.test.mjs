import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { dashboardFixture } from "../scripts/dashboard-fixture.mjs";
import { startDashboardPreview } from "../scripts/dashboard-preview.mjs";

const now = new Date("2026-09-26T12:00:00Z");

test("dashboard fixture is deterministic and contains distinct workflow evidence", () => {
  const records = dashboardFixture({ now });
  assert.deepEqual(records, dashboardFixture({ now }));
  assert.equal(new Set(records.map(record => record.id)).size, records.length);
  assert.ok(records.every(record => new Date(record.observedAt) <= now));
  assert.equal(new Set(records.map(record => record.scope.projectCwd)).size, 3);
  assert.ok(new Set(records.map(record => record.scope.sessionId)).size > 100);
  assert.ok(records.some(record => record.evidence.kind === "capture-gap"));
  assert.ok(records.some(record => record.evidence.kind === "read-result" && record.evidence.outcome === "error"));
  assert.ok(records.some(record => record.evidence.kind === "read-result" && record.evidence.model === null));
});

test("local previews have isolated disposable databases and real HTTP responses", async () => {
  const rich = await startDashboardPreview({ now });
  const empty = await startDashboardPreview({ scenario: "empty" });
  const missing = await startDashboardPreview({ scenario: "missing" });
  try {
    assert.notEqual(rich.databasePath, empty.databasePath);
    const richPayload = await fetch(new URL("/api/dashboard", rich.url)).then(response => response.json());
    const emptyPayload = await fetch(new URL("/api/dashboard", empty.url)).then(response => response.json());
    const missingPayload = await fetch(new URL("/api/dashboard", missing.url)).then(response => response.json());
    assert.equal(richPayload.kind, "ready");
    assert.ok(richPayload.overview.successfulReadCount > 500);
    assert.equal(emptyPayload.overview.observationCount, 0);
    assert.equal(missingPayload.kind, "missing");
    assert.equal(existsSync(missing.databasePath), false);
    assert.equal(richPayload.filterOptions.modelIds.length, 3);
  } finally {
    await Promise.all([rich.close(), empty.close(), missing.close()]);
  }
  assert.equal(existsSync(rich.directory), false);
  assert.equal(existsSync(empty.directory), false);
  assert.equal(existsSync(missing.directory), false);
  await rich.close();
});
