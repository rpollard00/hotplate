import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const packageRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const fakeModel: Model<Api> = {
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

export async function createFixture() {
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

export async function createSessionFromLocalPackage(fixture: Awaited<ReturnType<typeof createFixture>>, duplicatePackage = false) {
  const skill: Skill = {
    name: "integration-skill",
    description: "Use for Hotplate integration tests.",
    filePath: fixture.skillPath,
    baseDir: dirname(fixture.skillPath),
    sourceInfo: createSyntheticSourceInfo(fixture.skillPath, { source: "test" }),
    disableModelInvocation: false,
  };

  const settingsManager = SettingsManager.inMemory({ packages: duplicatePackage ? [packageRoot, packageRoot] : [packageRoot], retry: { enabled: false } }, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: fixture.projectDir,
    agentDir: fixture.agentDir,
    settingsManager,
    extensionFactories: [fakeProviderExtension(fixture.skillPath)],
    skillsOverride: () => ({ skills: [skill], diagnostics: [] }),
  });
  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(fixture.rootDir, "account-data");
  try { await loader.reload({ resolveProjectTrust: async () => true }); }
  finally {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }

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

