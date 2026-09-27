import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedDemoDatabase } from "../src/cli.js";
import { startDashboardServer } from "../src/server.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hotplate-dashboard-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("dashboard reports a missing database without creating it", async () => {
  await withTempDir(async (dir) => {
    const databasePath = join(dir, "missing.sqlite");
    const server = await startDashboardServer({ databasePath, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/dashboard`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("content-security-policy")?.includes("default-src 'none'"), true);
      const payload = await jsonRecord(response);
      assert.equal(getString(payload, "kind"), "missing");
      assert.equal(getString(payload, "databasePath"), databasePath);
      assert.equal("report" in payload, false);
      assert.equal(existsSync(databasePath), false);
    } finally {
      await server.close();
    }
  });
});

test("dashboard serves filtered data, static assets, and rejects unsafe origins", async () => {
  await withTempDir(async (dir) => {
    const databasePath = join(dir, "demo.sqlite");
    await seedDemoDatabase({ databasePath, force: true });
    const server = await startDashboardServer({ databasePath, port: 0 });
    try {
      const html = await fetch(`${server.url}/`);
      assert.equal(html.status, 200);
      assert.equal(await html.text().then((body) => body.includes("<script>alert(1)</script>")), false);
      assert.equal(html.headers.get("content-security-policy")?.includes("script-src 'self'"), true);

      const js = await fetch(`${server.url}/assets/app.js`).then((response) => response.text());
      assert.equal(js.includes("innerHTML"), false);
      assert.equal(js.includes("textContent"), true);

      const payload = await jsonRecord(await fetch(`${server.url}/api/dashboard`));
      assert.equal(getString(payload, "kind"), "ready");
      const overview = getRecord(payload, "overview");
      assert.equal(getNumber(overview, "observationCount"), 12);
      assert.equal(getNumber(overview, "catalogSkillCount"), 6);
      assert.equal(getNumber(overview, "successfulReadCount"), 3);
      assert.equal(getNumber(overview, "failedReadCount"), 1);
      assert.equal(getNumber(overview, "droppedObservationCount"), 2);
      const filterOptions = getRecord(payload, "filterOptions");
      assert.equal(getStringArray(filterOptions, "projects").includes("/demo/hotplate-alpha"), true);
      assert.equal(getStringArray(filterOptions, "modelProviders").includes("openai"), true);
      assert.equal(sourceSplitHas(payload, "Unknown wrapper source", 1), true);
      assert.equal(hasUnusedCatalogRow(payload), true);
      assert.equal(getArray(getRecord(payload, "chains"), "runs").length, 3);
      const report = getRecord(payload, "report");
      assert.deepEqual(getRecord(report, "counts"), { requests: 3, wrappers: 2, successfulReads: 3, failedReads: 1 });
      assert.equal(getNumber(report, "skillsRead"), 2);
      assert.equal(getArray(report, "routes").length, 3);
      assert.deepEqual(getRecord(report, "coverage"), {
        captureGaps: 1, droppedObservations: 2, filteredOmissions: 0, undatedEvidence: 0, catalogContext: "machine-project-time",
      });

      const projectParams = new URLSearchParams({ projectCwd: "/demo/hotplate-beta" });
      const projectPayload = await jsonRecord(await fetch(`${server.url}/api/dashboard?${projectParams}`));
      assert.equal(getString(projectPayload, "kind"), "ready");
      assert.equal(getNumber(getRecord(projectPayload, "overview"), "observationCount"), 3);
      assert.equal(getArray(getRecord(projectPayload, "chains"), "runs").length, 1);

      const chainParams = new URLSearchParams({ chainSkill: "typescript" });
      const chainPayload = await jsonRecord(await fetch(`${server.url}/api/dashboard?${chainParams}`));
      assert.equal(getString(chainPayload, "kind"), "ready");
      assert.equal(getString(chainPayload, "chainSkillName"), "typescript");
      assert.equal(hasFilteredIntermediateGap(chainPayload), true);
      assert.deepEqual(getRecord(chainPayload, "report"), report);
      const projectReport = getRecord(projectPayload, "report");
      assert.equal(getArray(projectReport, "routes").length, 1);
      assert.deepEqual(getRecord(projectReport, "scope"), { projectCwd: "/demo/hotplate-beta" });

      const head = await fetch(`${server.url}/api/dashboard`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal(head.headers.get("cache-control"), "no-store");
      const post = await fetch(`${server.url}/api/dashboard`, { method: "POST" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET, HEAD");

      const badHost = await requestStatus(`${server.url}/api/dashboard`, { Host: "evil.example" });
      assert.equal(badHost, 403);
      const badOrigin = await fetch(`${server.url}/api/dashboard`, { headers: { Origin: "http://evil.example" } });
      assert.equal(badOrigin.status, 403);
      const wrongPort = new URL(server.url);
      wrongPort.port = String(Number(wrongPort.port) + 1);
      assert.equal((await fetch(`${server.url}/api/dashboard`, { headers: { Origin: wrongPort.origin } })).status, 403);
      assert.equal((await fetch(`${server.url}/api/dashboard`, { headers: { Origin: server.url } })).status, 200);
      assert.equal(await requestStatus(`${server.url}/api/dashboard`, { Host: wrongPort.host }), 403);
    } finally {
      await server.close();
    }
  });
});

test("dashboard normalizes time bounds and reports invalid or reversed ranges as errors", async () => {
  await withTempDir(async (dir) => {
    const databasePath = join(dir, "demo.sqlite");
    await seedDemoDatabase({ databasePath, force: true });
    const server = await startDashboardServer({ databasePath, port: 0 });
    try {
      for (const params of [
        { fromObservedAt: "not-a-date" },
        { toObservedAt: "not-a-date" },
        { fromObservedAt: "2026-02-30T00:00:00Z" },
        { toObservedAt: "2026-01-01T00:00:00" },
        { toObservedAt: "+275760-09-13T00:00:00.000Z" },
        { fromObservedAt: "2026-01-03T00:00:00Z", toObservedAt: "2026-01-01T00:00:00Z" },
      ]) {
        const query = new URLSearchParams(params);
        const payload = await jsonRecord(await fetch(`${server.url}/api/dashboard?${query}`));
        assert.equal(payload.kind, "error");
        assert.match(getString(payload, "message"), /must/);
        assert.equal("report" in payload, false);
      }
      const query = new URLSearchParams({ fromObservedAt: "2050-01-01T02:00:00+02:00", toObservedAt: "2050-01-03T00:00:00Z" });
      const payload = await jsonRecord(await fetch(`${server.url}/api/dashboard?${query}`));
      assert.equal(payload.kind, "ready");
      const report = getRecord(payload, "report");
      assert.deepEqual(getRecord(report, "scope"), { fromObservedAt: "2050-01-01T00:00:00.000Z", toObservedAt: "2050-01-03T00:00:00.000Z" });
      const activity = getRecord(report, "activity");
      assert.equal(activity.kind, "bucketed");
      assert.equal(getArray(activity, "bins").length, 49);
      assert.deepEqual(getRecord(report, "counts"), { requests: 0, wrappers: 0, successfulReads: 0, failedReads: 0 });
    } finally {
      await server.close();
    }
  });
});

test("dashboard preserves database error payloads without an analytics report", async () => {
  await withTempDir(async (dir) => {
    const databasePath = join(dir, "broken.sqlite");
    await writeFile(databasePath, "not a SQLite database");
    const server = await startDashboardServer({ databasePath, port: 0 });
    try {
      const payload = await jsonRecord(await fetch(`${server.url}/api/dashboard`));
      assert.equal(payload.kind, "error");
      assert.equal("report" in payload, false);
      assert.ok(getString(payload, "message").length > 0);
    } finally {
      await server.close();
    }
  });
});

test("demo seeding requires force before replacing an explicit path", async () => {
  await withTempDir(async (dir) => {
    const databasePath = join(dir, "demo.sqlite");
    await seedDemoDatabase({ databasePath, force: true });
    await assert.rejects(() => seedDemoDatabase({ databasePath }), /already exists/);
    await seedDemoDatabase({ databasePath, force: true });
  });
});

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return requireRecord(parsed);
}

function sourceSplitHas(payload: Record<string, unknown>, label: string, count: number): boolean {
  return getArray(payload, "sourceSplit").some((value) => {
    if (!isRecord(value)) return false;
    return value.label === label && value.count === count;
  });
}

function hasUnusedCatalogRow(payload: Record<string, unknown>): boolean {
  const skills = getRecord(payload, "skills");
  return getArray(skills, "rows").some((value) => {
    if (!isRecord(value)) return false;
    return value.skillName === "unused-catalog" && value.uniqueObservedRunActivations === 0;
  });
}

function hasFilteredIntermediateGap(payload: Record<string, unknown>): boolean {
  const chains = getRecord(payload, "chains");
  return getArray(chains, "runs").some((runValue) => {
    if (!isRecord(runValue)) return false;
    return getArray(runValue, "steps").some((stepValue) => isRecord(stepValue) && stepValue.kind === "gap" && stepValue.reason === "filtered-intermediates");
  });
}

function getRecord(source: Record<string, unknown>, name: string): Record<string, unknown> {
  return requireRecord(source[name]);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw new Error("Expected record");
}

function getArray(source: Record<string, unknown>, name: string): readonly unknown[] {
  const value = source[name];
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`Expected ${name} to be an array`);
}

function getStringArray(source: Record<string, unknown>, name: string): readonly string[] {
  const values = getArray(source, name);
  if (values.every((value) => typeof value === "string")) {
    return values;
  }
  throw new Error(`Expected ${name} to contain strings`);
}

function getString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${name} to be a string`);
}

function getNumber(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`Expected ${name} to be a number`);
}

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const clientRequest = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
