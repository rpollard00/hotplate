import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createFixture, createSessionFromLocalPackage, fakeModel } from "./fixtures/sdk-session.js";
import { startDashboardServer } from "../src/server.js";

test("local pi package load captures SDK skill rows and serves dashboard JSON", async () => {
  const fixture = await createFixture();
  const previousDb = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = fixture.databasePath;

  try {
    const session = await createSessionFromLocalPackage(fixture);
    try {
      await session.prompt("/skill:integration-skill", { source: "interactive" });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }

    const server = await startDashboardServer({ databasePath: fixture.databasePath, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/dashboard?projectCwd=${encodeURIComponent(fixture.projectDir)}`);
      assert.equal(response.status, 200);
      const payload = await jsonRecord(response);
      assert.equal(getString(payload, "kind"), "ready");

      const overview = getRecord(payload, "overview");
      assert.equal(getNumber(overview, "commandIntentCount"), 1);
      assert.equal(getNumber(overview, "wrapperObservedCount"), 1);
      assert.equal(getNumber(overview, "successfulReadCount"), 1);
      assert.equal(getNumber(overview, "failedReadCount"), 0);

      const matrixRows = getArray(getRecord(payload, "matrix"), "rows");
      assert.equal(matrixRows.length, 1);
      const model = getRecord(requireRecord(matrixRows[0]), "model");
      assert.equal(getString(model, "provider"), fakeModel.provider);
      assert.equal(getString(model, "id"), fakeModel.id);

      assert.equal(sourceSplitHas(payload, "Interactive command intents", 1), true);
      assert.equal(sourceSplitHas(payload, "Successful model reads", 1), true);
      assert.equal(skillRowHas(payload, "integration-skill", { commandIntents: 1, wrappers: 1, successfulReads: 1 }), true);
      assert.equal(getArray(getRecord(payload, "chains"), "runs").length, 2);
    } finally {
      await server.close();
    }
  } finally {
    restoreHotplateDb(previousDb);
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
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

function skillRowHas(payload: Record<string, unknown>, skillName: string, counts: { commandIntents: number; wrappers: number; successfulReads: number }): boolean {
  let commandIntents = 0;
  let wrappers = 0;
  let successfulReads = 0;
  for (const value of getArray(getRecord(payload, "skills"), "rows")) {
    if (!isRecord(value) || value.skillName !== skillName) {
      continue;
    }
    commandIntents += getNumber(value, "commandIntentCount");
    wrappers += getNumber(value, "wrapperObservedCount");
    successfulReads += getNumber(value, "successfulReadCount");
  }
  return commandIntents === counts.commandIntents && wrappers === counts.wrappers && successfulReads === counts.successfulReads;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreHotplateDb(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.HOTPLATE_DB;
    return;
  }
  process.env.HOTPLATE_DB = previous;
}
