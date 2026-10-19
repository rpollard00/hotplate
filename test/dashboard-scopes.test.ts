import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedDemoDatabase } from "../src/cli.js";
import type { Observation } from "../src/domain.js";
import { startDashboardServer } from "../src/server.js";
import { openHotplateReadStore, openHotplateStore } from "../src/store.js";

async function read(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assert.ok(typeof payload === "object" && payload !== null && !Array.isArray(payload));
  return Object.fromEntries(Object.entries(payload));
}

test("compact dashboard scopes preserve filtered views without querying other workspaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-scopes-"));
  const databasePath = join(directory, "capture.sqlite");
  await seedDemoDatabase({ databasePath, force: true });
  const store = openHotplateStore({ databasePath });
  const observation: Observation = {
    id: "resource", producerId: "scopes", sequence: 0, host: "codex", observedAt: "2050-01-02T00:00:00.000Z",
    scope: { projectCwd: "/demo/hotplate-alpha", sessionId: "resource", sessionFile: null, segmentId: "resource", segmentReason: "startup", runId: null, turnId: null, leafId: null },
    evidence: { kind: "resource-access", resource: { filesystemId: "host", canonicalPath: "/skills/file.md", observedPath: "/skills/file.md", rootPath: "/skills", kind: "reference", ownerSkillPath: null }, operationId: "resource", mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" },
  };
  assert.equal((await store.record(observation)).accepted, 1);
  await store.close();
  const opened = openHotplateReadStore({ databasePath });
  assert.equal(opened.kind, "ready");
  assert.ok(opened.kind === "ready");
  const prototype: unknown = Object.getPrototypeOf(opened.store);
  assert.ok(typeof prototype === "object" && prototype !== null);
  await opened.store.close();
  const methods = ["queryFilterOptions", "queryOverview", "querySkillTable", "queryModelMatrix", "queryCaptureHealth", "queryResources", "queryResourceCoverage", "querySkillChain"];
  const descriptors = new Map<string, PropertyDescriptor>();
  const calls: string[] = [];
  for (const method of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    assert.ok(descriptor);
    const original: unknown = descriptor.value;
    assert.equal(typeof original, "function");
    assert.ok(typeof original === "function");
    descriptors.set(method, descriptor);
    Object.defineProperty(prototype, method, { ...descriptor, value: function (this: unknown, ...args: unknown[]) {
      calls.push(method);
      return Reflect.apply(original, this, args);
    } });
  }
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    for (const filter of [
      {}, { host: "codex" }, { projectCwd: "/demo/hotplate-beta" }, { model: "unknown" },
      { source: "rpc" }, { chainSkill: "typescript" },
      { fromObservedAt: "2050-01-02T00:00:00Z", toObservedAt: "2050-01-03T00:00:00Z" },
    ]) {
      const params = new URLSearchParams(filter);
      calls.length = 0;
      const full = await read(`${server.url}/api/dashboard?${params}`);
      assert.equal(full.kind, "ready");
      assert.equal("scope" in full, false);
      for (const method of methods) assert.ok(calls.includes(method), `Full response runs ${method}`);

      params.set("scope", "skills"); calls.length = 0;
      const skills = await read(`${server.url}/api/dashboard?${params}`);
      assert.deepEqual(skills, { kind: "ready", scope: "skills", databasePath, report: full.report, filterOptions: full.filterOptions });
      assert.deepEqual(calls.toSorted(), ["queryFilterOptions", "querySkillChain", "querySkillTable"]);

      params.set("scope", "resources"); calls.length = 0;
      const resources = await read(`${server.url}/api/dashboard?${params}`);
      assert.deepEqual(resources, { kind: "ready", scope: "resources", databasePath, resources: full.resources, resourceCoverage: full.resourceCoverage, filterOptions: full.filterOptions });
      assert.deepEqual(calls.toSorted(), ["queryFilterOptions", "queryResourceCoverage", "queryResources"]);
    }
    const full = await read(`${server.url}/api/dashboard`);
    assert.partialDeepStrictEqual(full.resources, { rows: [{ successfulReadCount: 1, resource: { canonicalPath: "/skills/file.md" } }] }, "positive resource control");
  } finally {
    await server.close();
    for (const [method, descriptor] of descriptors) Object.defineProperty(prototype, method, descriptor);
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard scopes preserve missing/error responses, read-only methods, and origin guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-scope-errors-"));
  const databasePath = join(directory, "missing.sqlite");
  const server = await startDashboardServer({ databasePath, port: 0 });
  try {
    for (const scope of ["skills", "resources"]) {
      const url = `${server.url}/api/dashboard?scope=${scope}`;
      const payload = await read(url);
      assert.equal(payload.kind, "missing");
      assert.equal("report" in payload, false);
      assert.equal("resources" in payload, false);
      assert.equal(existsSync(databasePath), false);
      assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
      assert.equal((await fetch(url, { method: "POST" })).status, 405);
      assert.equal((await fetch(url, { headers: { Origin: "http://wrong.invalid" } })).status, 403);
    }
    await seedDemoDatabase({ databasePath, force: true });
    assert.deepEqual(await read(`${server.url}/api/dashboard?scope=full`), await read(`${server.url}/api/dashboard`));
    for (const query of ["scope=unknown", "scope=", "scope=skills&fromObservedAt=invalid", "scope=resources&model=invalid"]) {
      const payload = await read(`${server.url}/api/dashboard?${query}`);
      assert.equal(payload.kind, "error");
      assert.equal("report" in payload, false);
      assert.equal("resources" in payload, false);
    }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
