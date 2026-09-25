import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
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
import hotplateExtension from "../src/extension.js";
import { openHotplateReadStore } from "../src/store.js";

const fakeModel: Model<Api> = {
  id: "fake-skill-reader",
  name: "Fake skill reader",
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

test("pi SDK records skill command expansion and model SKILL.md read", async () => {
  const fixture = await createFixture();
  const previousDb = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = fixture.databasePath;

  try {
    const session = await createSession(fixture);
    try {
      await session.prompt("/skill:test-skill", { source: "interactive" });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }

    const open = openHotplateReadStore({ databasePath: fixture.databasePath });
    assert.equal(open.kind, "ready");
    if (open.kind !== "ready") return;

    const overview = await open.store.queryOverview({ projectCwd: fixture.projectDir });
    assert.equal(overview.commandIntentCount, 1);
    assert.equal(overview.wrapperObservedCount, 1);
    assert.equal(overview.successfulReadCount, 1);
    assert.equal(overview.failedReadCount, 0);
    assert.equal(overview.catalogSkillCount, 1);

    const skills = await open.store.querySkillTable({ projectCwd: fixture.projectDir });
    const testSkillRows = skills.rows.filter((row) => row.skillName === "test-skill");
    assert.equal(sum(testSkillRows.map((row) => row.interactiveCommandIntentCount)), 1);
    assert.equal(sum(testSkillRows.map((row) => row.wrapperObservedCount)), 1);
    assert.equal(sum(testSkillRows.map((row) => row.successfulReadCount)), 1);

    const matrix = await open.store.queryModelMatrix({ projectCwd: fixture.projectDir });
    assert.equal(matrix.rows.length, 1);
    assert.deepEqual(matrix.rows[0]?.model, { provider: "hotplate-fake", id: "fake-skill-reader" });

    await open.store.close();
  } finally {
    restoreHotplateDb(previousDb);
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("pi SDK records failed SKILL.md reads without storing error bodies", async () => {
  const fixture = await createFixture();
  const previousDb = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = fixture.databasePath;

  try {
    const session = await createSession(fixture);
    try {
      await session.prompt("Please read the missing skill file.", { source: "interactive" });
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }

    const open = openHotplateReadStore({ databasePath: fixture.databasePath });
    assert.equal(open.kind, "ready");
    if (open.kind !== "ready") return;

    const overview = await open.store.queryOverview({ projectCwd: fixture.projectDir });
    assert.equal(overview.successfulReadCount, 0);
    assert.equal(overview.failedReadCount, 1);

    const skills = await open.store.querySkillTable({ projectCwd: fixture.projectDir });
    const missing = skills.rows.find((row) => row.skillName === "missing-skill");
    assert.equal(missing?.failedReadCount, 1);

    await open.store.close();
  } finally {
    restoreHotplateDb(previousDb);
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("pi SDK captures every repeated queued request and delivered skill wrapper", async () => {
  const fixture = await createFixture();
  const previousDb = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = fixture.databasePath;
  try {
    const session = await createSession(fixture);
    try {
      await session.steer("/skill:test-skill", undefined, { source: "rpc" });
      await session.steer("/skill:test-skill", undefined, { source: "rpc" });
      await session.prompt("Start this run.");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    const open = openHotplateReadStore({ databasePath: fixture.databasePath });
    assert.equal(open.kind, "ready");
    if (open.kind !== "ready") return;
    try {
      const overview = await open.store.queryOverview({});
      assert.equal(overview.commandIntentCount, 2);
      assert.equal(overview.wrapperObservedCount, 2);
      const wrappers = (await open.store.querySkillChain({})).runs.flatMap(run => run.steps.flatMap(step => step.kind === "observations" ? step.items : []));
      for (const item of wrappers) {
        if (item.evidence.kind === "wrapper-observed") assert.equal(item.evidence.wrapperSource, "unknown-pasted-or-transformed");
      }
    } finally { await open.store.close(); }
  } finally {
    restoreHotplateDb(previousDb);
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

test("repeated handled commands remain separate intents without inferred loads", async () => {
  const fixture = await createFixture();
  const previousDb = process.env.HOTPLATE_DB;
  process.env.HOTPLATE_DB = fixture.databasePath;
  try {
    const session = await createSession(fixture, [pi => {
      pi.on("input", () => ({ action: "handled" }));
    }]);
    try {
      await session.prompt("/skill:test-skill");
      await session.prompt("/skill:test-skill");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    const open = openHotplateReadStore({ databasePath: fixture.databasePath });
    assert.equal(open.kind, "ready");
    if (open.kind !== "ready") return;
    try {
      const overview = await open.store.queryOverview({});
      assert.equal(overview.commandIntentCount, 2);
      assert.equal(overview.wrapperObservedCount, 0);
    } finally { await open.store.close(); }
  } finally {
    restoreHotplateDb(previousDb);
    await rm(fixture.rootDir, { recursive: true, force: true });
  }
});

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "hotplate-collector-"));
  const projectDir = join(rootDir, "project");
  const agentDir = join(rootDir, "agent");
  const skillDir = join(projectDir, ".agents", "skills", "test-skill");
  const missingSkillDir = join(projectDir, ".agents", "skills", "missing-skill");
  await mkdir(skillDir, { recursive: true });
  await mkdir(missingSkillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const missingSkillPath = join(missingSkillDir, "SKILL.md");
  await writeFile(
    skillPath,
    `---\nname: test-skill\ndescription: Use for collector tests.\n---\n\n# Test skill\n\nRead this file during the test.\n`,
    "utf8",
  );

  return {
    rootDir,
    projectDir,
    agentDir,
    skillPath,
    missingSkillPath,
    databasePath: join(rootDir, "analytics.sqlite"),
  };
}

async function createSession(fixture: Awaited<ReturnType<typeof createFixture>>, extensions: Array<(pi: ExtensionAPI) => void> = []) {
  const skill: Skill = {
    name: "test-skill",
    description: "Use for collector tests.",
    filePath: fixture.skillPath,
    baseDir: join(fixture.projectDir, ".agents", "skills", "test-skill"),
    sourceInfo: createSyntheticSourceInfo(fixture.skillPath, { source: "test" }),
    disableModelInvocation: false,
  };

  const loader = new DefaultResourceLoader({
    cwd: fixture.projectDir,
    agentDir: fixture.agentDir,
    skillsOverride: () => ({ skills: [skill], diagnostics: [] }),
    extensionFactories: [fakeProviderExtension(fixture.skillPath, fixture.missingSkillPath), hotplateExtension, ...extensions],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: fixture.projectDir,
    agentDir: fixture.agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(fixture.projectDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    model: fakeModel,
    thinkingLevel: "off",
    tools: ["read"],
  });
  await session.bindExtensions({});
  return session;
}

function fakeProviderExtension(skillPath: string, missingSkillPath: string) {
  return (pi: ExtensionAPI): void => {
    pi.registerProvider("hotplate-fake", {
      api: "pi-messages",
      apiKey: "test-key",
      streamSimple: (model, context, options) => fakeStream(model, context, options, skillPath, missingSkillPath),
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

function fakeStream(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  skillPath: string,
  missingSkillPath: string,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    void (async () => {
      await options?.onPayload?.({ messageCount: context.messages.length }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      const message = context.messages.some((entry) => entry.role === "toolResult")
        ? assistantTextMessage("The skill file was read.")
        : assistantReadMessage(lastUserText(context).includes("missing") ? missingSkillPath : skillPath);
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    })().catch((error: unknown) => {
      stream.push({ type: "error", reason: "error", error: assistantTextMessage(error instanceof Error ? error.message : "fake provider error") });
    });
  });
  return stream;
}

function assistantReadMessage(path: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "read-skill-file", name: "read", arguments: { path } }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function assistantTextMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: fakeModel.api,
    provider: fakeModel.provider,
    model: fakeModel.id,
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function lastUserText(context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }
  return "";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function restoreHotplateDb(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.HOTPLATE_DB;
  } else {
    process.env.HOTPLATE_DB = previous;
  }
}
