import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import type {
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionStartEvent,
  SessionTreeEvent,
  SlashCommandInfo,
  ToolResultEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Evidence, GapReason, HotplateStore, ModelRef, Observation, ObservationScope, SegmentReason } from "../domain.js";
import { openHotplateStore } from "../store.js";
import { buildSkillCatalog, commandIntentSkillName, skillFromReadPath, skillWrappersFromPrompt, type SkillCatalog } from "./skills.js";

const MAX_QUEUE = 1_000;
const SHUTDOWN_DEADLINE_MS = 500;

export type HotplateCollectorOptions = {
  openStore?: () => HotplateStore;
  producerId?: string;
  now?: () => Date;
};

export class HotplateCollector {
  readonly #openStore: () => HotplateStore;
  readonly #producerId: string;
  readonly #now: () => Date;

  #store: HotplateStore | null = null;
  #catalog: SkillCatalog = { byPath: new Map(), skills: [] };
  #queue: Observation[] = [];
  #flushing = false;
  #closed = false;
  #sequence = 0;
  #pendingQueueOverflow = 0;
  #pendingDbDropped = 0;
  #lastInputIntentKey: string | null = null;
  #pendingInputSkillNames: string[] = [];
  #toolCallModels = new Map<string, ModelRef>();
  #scope: ObservationScope = {
    projectCwd: process.cwd(),
    sessionId: null,
    sessionFile: null,
    segmentId: randomUUID(),
    segmentReason: "unknown",
    runId: null,
    turnId: null,
    leafId: null,
  };

  constructor(options: HotplateCollectorOptions = {}) {
    this.#openStore = options.openStore ?? openHotplateStore;
    this.#producerId = options.producerId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
  }

  sessionStart(event: SessionStartEvent, ctx: ExtensionContext, commands: () => readonly SlashCommandInfo[]): void {
    this.#safe(() => {
      this.#closed = false;
      this.#store ??= this.#openStore();
      this.#catalog = buildSkillCatalog(commands());
      this.#startSegment(event.reason, ctx);
      if (this.#catalog.skills.length > 0) {
        this.#enqueue({ kind: "catalog-snapshot", skills: this.#catalog.skills }, ctx);
      }
    });
  }

  input(event: InputEvent, ctx: ExtensionContext): void {
    this.#safe(() => {
      const skillName = commandIntentSkillName(event.text);
      if (!skillName) {
        return;
      }
      const intentKey = `${event.source}\u0000${skillName}\u0000${event.text}`;
      if (this.#lastInputIntentKey === intentKey) {
        return;
      }
      this.#lastInputIntentKey = intentKey;
      this.#pendingInputSkillNames.push(skillName);
      this.#enqueue({ kind: "command-intent", skillName, source: event.source }, ctx);
    });
  }

  beforeAgentStart(prompt: string, ctx: ExtensionContext): void {
    this.#safe(() => {
      this.#scope = { ...this.#scope, runId: randomUUID(), turnId: null, leafId: ctx.sessionManager.getLeafId() ?? null };
      for (const skill of skillWrappersFromPrompt(prompt, this.#catalog)) {
        const matchedIndex = this.#pendingInputSkillNames.findIndex((name) => name === skill.name);
        const wrapperSource = matchedIndex >= 0 ? "expanded-prompt" : "unknown-pasted-or-transformed";
        if (matchedIndex >= 0) {
          this.#pendingInputSkillNames.splice(matchedIndex, 1);
        }
        this.#enqueue({ kind: "wrapper-observed", skill, wrapperSource }, ctx);
      }
      this.#pendingInputSkillNames = [];
      this.#lastInputIntentKey = null;
    });
  }

  agentStart(ctx: ExtensionContext): void {
    this.#safe(() => {
      if (this.#scope.runId === null) {
        this.#scope = { ...this.#scope, runId: randomUUID(), turnId: null, leafId: ctx.sessionManager.getLeafId() ?? null };
      }
    });
  }

  turnStart(event: TurnStartEvent, ctx: ExtensionContext): void {
    this.#safe(() => {
      const runId = this.#scope.runId ?? randomUUID();
      this.#scope = {
        ...this.#scope,
        runId,
        turnId: `${runId}:turn:${event.turnIndex}`,
        leafId: ctx.sessionManager.getLeafId() ?? null,
      };
    });
  }

  messageEnd(event: MessageEndEvent): void {
    this.#safe(() => {
      if (event.message.role !== "assistant") {
        return;
      }
      const model = modelFromAssistantMessage(event.message);
      for (const block of event.message.content) {
        if (block.type === "toolCall") {
          this.#toolCallModels.set(block.id, model);
        }
      }
    });
  }

  toolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
    this.#safe(() => {
      if (event.toolName !== "read") {
        return;
      }

      const inputPath = stringRecordValue(event.input, "path");
      if (inputPath === null) {
        return;
      }

      const skill = skillFromReadPath(inputPath, ctx.cwd, this.#catalog);
      if (!skill) {
        return;
      }

      this.#enqueue(
        {
          kind: "read-result",
          skill,
          toolCallId: event.toolCallId,
          outcome: event.isError ? "error" : "success",
          model: this.#toolCallModels.get(event.toolCallId) ?? null,
        },
        ctx,
      );
      this.#toolCallModels.delete(event.toolCallId);
    });
  }

  sessionTree(event: SessionTreeEvent, ctx: ExtensionContext): void {
    this.#safe(() => {
      if (event.newLeafId !== event.oldLeafId) {
        this.#startSegment("branch", ctx);
      }
    });
  }

  async shutdown(reason: Exclude<SegmentReason, "startup" | "branch" | "unknown"> | "quit", ctx: ExtensionContext): Promise<void> {
    await this.#safeAsync(async () => {
      this.#closed = true;
      if (this.#pendingQueueOverflow > 0) {
        this.#enqueueGap(this.#pendingQueueOverflow, "queue-overflow", ctx);
        this.#pendingQueueOverflow = 0;
      }
      if (this.#pendingDbDropped > 0) {
        this.#enqueueGap(this.#pendingDbDropped, "db-error", ctx);
        this.#pendingDbDropped = 0;
      }
      await this.#flush();
      if (this.#queue.length > 0) {
        const dropped = this.#queue.length;
        this.#queue = [];
        this.#enqueueGap(dropped, "shutdown-deadline", ctx);
        await this.#flush();
      }
      await this.#store?.close({ deadlineMs: SHUTDOWN_DEADLINE_MS });
      this.#store = null;
      this.#scope = { ...this.#scope, segmentReason: reason === "quit" ? "unknown" : reason };
    });
  }

  #startSegment(reason: SegmentReason, ctx: ExtensionContext): void {
    this.#scope = {
      projectCwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId() ?? null,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      segmentId: randomUUID(),
      segmentReason: reason,
      runId: null,
      turnId: null,
      leafId: ctx.sessionManager.getLeafId() ?? null,
    };
    this.#pendingInputSkillNames = [];
    this.#lastInputIntentKey = null;
    this.#toolCallModels.clear();
  }

  #enqueue(evidence: Evidence, ctx: ExtensionContext): void {
    if (this.#closed && evidence.kind !== "capture-gap") {
      return;
    }

    if (this.#pendingQueueOverflow > 0) {
      this.#enqueueGap(this.#pendingQueueOverflow, "queue-overflow", ctx);
      this.#pendingQueueOverflow = 0;
    }
    if (this.#pendingDbDropped > 0) {
      this.#enqueueGap(this.#pendingDbDropped, "db-error", ctx);
      this.#pendingDbDropped = 0;
    }

    if (this.#queue.length >= MAX_QUEUE) {
      this.#pendingQueueOverflow += 1;
      return;
    }

    this.#queue.push({
      id: `${this.#producerId}:${this.#sequence + 1}`,
      producerId: this.#producerId,
      sequence: this.#sequence + 1,
      observedAt: this.#now().toISOString(),
      scope: { ...this.#scope, leafId: ctx.sessionManager.getLeafId() ?? null },
      evidence,
    });
    this.#sequence += 1;
    this.#scheduleFlush();
  }

  #enqueueGap(dropped: number, reason: GapReason, ctx: ExtensionContext): void {
    if (dropped <= 0 || this.#queue.length >= MAX_QUEUE) {
      return;
    }
    this.#queue.push({
      id: `${this.#producerId}:${this.#sequence + 1}`,
      producerId: this.#producerId,
      sequence: this.#sequence + 1,
      observedAt: this.#now().toISOString(),
      scope: { ...this.#scope, leafId: ctx.sessionManager.getLeafId() ?? null },
      evidence: { kind: "capture-gap", dropped, reason },
    });
    this.#sequence += 1;
  }

  #scheduleFlush(): void {
    if (this.#flushing) {
      return;
    }
    this.#flushing = true;
    setImmediate(() => {
      void this.#safeAsync(async () => {
        await this.#flush();
      });
    });
  }

  async #flush(): Promise<void> {
    const store = this.#store;
    if (!store) {
      this.#queue = [];
      this.#flushing = false;
      return;
    }

    while (this.#queue.length > 0) {
      const batch = this.#queue;
      this.#queue = [];
      const summary = await store.record(batch);
      if (summary.dropped > 0) {
        this.#pendingDbDropped += summary.dropped;
      }
    }
    this.#flushing = false;
  }

  #safe(work: () => void): void {
    try {
      work();
    } catch {
      this.#pendingDbDropped += 1;
    }
  }

  async #safeAsync(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch {
      this.#pendingDbDropped += 1;
    }
  }
}

function modelFromAssistantMessage(message: Extract<MessageEndEvent["message"], { role: "assistant" }>): ModelRef {
  return { provider: message.provider, id: message.responseModel ?? message.model };
}

function stringRecordValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
