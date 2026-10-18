import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Observation } from "../src/domain.js";
import { openHotplateStore } from "../src/store.js";
import { startDashboardServer } from "../src/server.js";

function field(value: unknown, name: string): unknown {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Reflect.get(value, name);
}

test("dashboard exposes resource evidence and unavailable coverage without changing skill read totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-resource-dashboard-"));
  const databasePath = join(directory, "capture.sqlite");
  const store = openHotplateStore({ databasePath });
  const base = { host: "codex", producerId: "test", sequence: 0, observedAt: "2026-10-18T00:00:00.000Z",
    scope: { projectCwd: "/project", sessionId: "session", sessionFile: null, segmentId: "segment", segmentReason: "unknown", runId: null, turnId: null, leafId: null } } as const;
  const events: Observation[] = [
    { ...base, id: "read", evidence: { kind: "resource-access", resource: { filesystemId: "host", canonicalPath: "/skills/<script>literal</script>.md", observedPath: "/skills/<script>literal</script>.md", rootPath: "/skills", kind: "reference", ownerSkillPath: null }, operationId: "read", mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" } },
    { ...base, id: "unavailable", sequence: 1, evidence: { kind: "observer-coverage", observerId: "observer", mechanism: "fanotify", filesystemId: "host", rootPaths: ["/skills"], heartbeatMs: 1000, status: "unavailable", reason: "permission-denied" } },
  ];
  assert.equal((await store.record(events)).accepted, 2);
  await store.close();
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    const payload = await fetch(`${server.url}/api/dashboard`).then(response => response.json());
    assert.partialDeepStrictEqual(payload, { kind: "ready", resources: { rows: [{ successfulReadCount: 1, resource: { canonicalPath: "/skills/<script>literal</script>.md" } }] },
      resourceCoverage: { rows: [{ status: "unavailable", reason: "permission-denied" }] }, overview: { successfulReadCount: 0 }, report: { counts: { successfulReads: 0 } } });
    const resources = field(field(payload, "resources"), "rows");
    assert.ok(Array.isArray(resources));
    assert.equal(resources.length, 1);
    const filtered = await fetch(`${server.url}/api/dashboard?host=claude-code`).then(response => response.json());
    assert.deepEqual(field(filtered, "resources"), { rows: [] });
    const html = await fetch(server.url).then(response => response.text());
    assert.match(html, /data-workspace="resources"/);
    assert.match(html, /id="resource-search"/);
    const js = await fetch(`${server.url}/assets/app.js`).then(response => response.text());
    assert.ok(!js.includes("innerHTML"));
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
