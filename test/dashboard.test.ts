import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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

      const badHost = await requestStatus(`${server.url}/api/dashboard`, { Host: "evil.example" });
      assert.equal(badHost, 403);
      const badOrigin = await fetch(`${server.url}/api/dashboard`, { headers: { Origin: "http://evil.example" } });
      assert.equal(badOrigin.status, 403);
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
