import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { startDashboardServer } from "../src/server.js";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const fakeModel: Model<Api> = {
  id: "fake-hotplate-integration",
  name: "Fake Hotplate integration",
  api: "pi-messages",
  provider: "hotplate-fake",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
};

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "hotplate-integration-"));
  const projectDir = join(rootDir, "project");
  const agentDir = join(rootDir, "agent");
  const skillDir = join(projectDir, ".agents", "skills", "integration-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    `---\nname: integration-skill\ndescription: Use for Hotplate integration tests.\n---\n\n# Integration skill\n\nRead this file during the test.\n`,
    "utf8",
  );

  return {
    rootDir,
    projectDir,
    agentDir,
    skillPath,
    databasePath: join(rootDir, "analytics.sqlite"),
  };
}

async function createSessionFromLocalPackage(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const skill: Skill = {
    name: "integration-skill",
    description: "Use for Hotplate integration tests.",
    filePath: fixture.skillPath,
    baseDir: dirname(fixture.skillPath),
    sourceInfo: createSyntheticSourceInfo(fixture.skillPath, { source: "test" }),
    disableModelInvocation: false,
  };

  const settingsManager = SettingsManager.inMemory({ packages: [packageRoot], retry: { enabled: false } }, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: fixture.projectDir,
    agentDir: fixture.agentDir,
    settingsManager,
    extensionFactories: [fakeProviderExtension(fixture.skillPath)],
    skillsOverride: () => ({ skills: [skill], diagnostics: [] }),
  });
  await loader.reload({ resolveProjectTrust: async () => true });

  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.some((extension) => extension.path === join(packageRoot, "src", "extension.ts")), true);

  const { session } = await createAgentSession({
    cwd: fixture.projectDir,
    agentDir: fixture.agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(fixture.projectDir),
    settingsManager,
    model: fakeModel,
    thinkingLevel: "off",
    tools: ["read"],
  });
  await session.bindExtensions({});
  return session;
}

function fakeProviderExtension(skillPath: string) {
  return (pi: ExtensionAPI): void => {
    pi.registerProvider("hotplate-fake", {
      api: "pi-messages",
      apiKey: "test-key",
      streamSimple: (model, context, options) => fakeStream(model, context, options, skillPath),
      models: [
        {
          id: fakeModel.id,
          name: fakeModel.name,
          api: fakeModel.api,
          baseUrl: fakeModel.baseUrl,
          reasoning: fakeModel.reasoning,
          input: fakeModel.input,
          cost: fakeModel.cost,
          contextWindow: fakeModel.contextWindow,
          maxTokens: fakeModel.maxTokens,
        },
      ],
    });
  };
}

function fakeStream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, skillPath: string) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    void (async () => {
      await options?.onPayload?.({ messageCount: context.messages.length }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      const message = context.messages.some((entry) => entry.role === "toolResult") ? assistantTextMessage() : assistantReadMessage(skillPath);
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    })().catch((error: unknown) => {
      stream.push({ type: "error", reason: "error", error: assistantErrorMessage(error) });
    });
  });
  return stream;
}

function assistantReadMessage(path: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "read-integration-skill", name: "read", arguments: { path } }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function assistantTextMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "The skill file was read." }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantErrorMessage(error: unknown): AssistantMessage {
  return {
    ...assistantTextMessage(),
    content: [{ type: "text", text: error instanceof Error ? error.message : "fake provider error" }],
  };
}

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
