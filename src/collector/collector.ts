import { randomUUID } from "node:crypto";
import { setImmediate as nextTick } from "node:timers/promises";
import type {
  ExtensionContext, InputEvent, MessageEndEvent, SessionStartEvent, SessionTreeEvent,
  SlashCommandInfo, ToolResultEvent, TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Evidence, GapReason, HotplateStore, ModelRef, Observation, ObservationScope, SegmentReason } from "../domain.js";
import { openHotplateStore } from "../store.js";
import { buildSkillCatalog, commandIntentSkillName, skillFromReadPath, skillWrappersFromPrompt, type SkillCatalog } from "./skills.js";

const MAX_QUEUE = 1_000;
const SHUTDOWN_DEADLINE_MS = 500;

type CollectorContext = {
  cwd: string;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getSessionId" | "getSessionFile">;
  ui: Pick<ExtensionContext["ui"], "setStatus">;
};
type CaptureState = { kind: "inactive" } | { kind: "active" | "closing"; store: HotplateStore; abort: AbortController };
export type HotplateCollectorOptions = {
  openStore?: () => HotplateStore;
  producerId?: string;
  now?: () => Date;
};

export class HotplateCollector {
  readonly #openStore: () => HotplateStore;
  readonly #producerId: string;
  readonly #now: () => Date;
  #state: CaptureState = { kind: "inactive" };
  #catalog: SkillCatalog = { byPath: new Map(), skills: [] };
  #queue: Observation[] = [];
  #gaps = new Map<string, Observation>();
  #flushPromise: Promise<void> | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #sequence = 0;
  #dropped = 0;
  #warned = false;
  #context: CollectorContext | null = null;
  #toolCallModels = new Map<string, ModelRef>();
  #scope: ObservationScope = {
    projectCwd: process.cwd(), sessionId: null, sessionFile: null,
    segmentId: randomUUID(), segmentReason: "unknown", runId: null, turnId: null, leafId: null,
  };

  constructor(options: HotplateCollectorOptions = {}) {
    this.#openStore = options.openStore ?? openHotplateStore;
    this.#producerId = options.producerId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
  }

  async sessionStart(event: SessionStartEvent, ctx: CollectorContext, commands: () => readonly SlashCommandInfo[]): Promise<void> {
    if (this.#state.kind !== "inactive") await this.shutdown("reload", ctx);
    this.#shutdownPromise = null;
    this.#context = ctx;
    this.#startSegment(event.reason, ctx);
    this.#safe(() => {
      this.#state = { kind: "active", store: this.#openStore(), abort: new AbortController() };
      this.#catalog = buildSkillCatalog(commands());
      this.#enqueue({ kind: "catalog-snapshot", skills: this.#catalog.skills });
    });
  }

  input(event: InputEvent, _ctx: CollectorContext): void {
    this.#safe(() => {
      const skillName = commandIntentSkillName(event.text);
      if (skillName) this.#enqueue({ kind: "command-intent", skillName, source: event.source }, { ...this.#scope, runId: null, turnId: null });
    });
  }

  beforeAgentStart(_prompt: string, ctx: CollectorContext): void {
    this.#safe(() => {
      this.#toolCallModels.clear();
      this.#scope = { ...this.#scope, runId: randomUUID(), turnId: null, leafId: ctx.sessionManager.getLeafId() ?? null };
    });
  }

  agentStart(ctx: CollectorContext): void {
    if (this.#scope.runId === null) this.beforeAgentStart("", ctx);
  }

  agentEnd(): void {
    this.#toolCallModels.clear();
    this.#scope = { ...this.#scope, runId: null, turnId: null };
  }

  turnStart(event: TurnStartEvent, ctx: CollectorContext): void {
    this.#safe(() => {
      this.#toolCallModels.clear();
      const runId = this.#scope.runId ?? randomUUID();
      this.#scope = { ...this.#scope, runId, turnId: `${runId}:turn:${event.turnIndex}`, leafId: ctx.sessionManager.getLeafId() ?? null };
    });
  }

  messageEnd(event: MessageEndEvent): void {
    this.#safe(() => {
      if (event.message.role === "user") {
        const text = typeof event.message.content === "string" ? event.message.content
          : event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        for (const skill of skillWrappersFromPrompt(text, this.#scope.projectCwd)) {
          this.#enqueue({ kind: "wrapper-observed", skill, wrapperSource: "unknown-pasted-or-transformed" });
        }
      } else if (event.message.role === "assistant") {
        const model = { provider: event.message.provider, id: event.message.responseModel ?? event.message.model };
        for (const block of event.message.content) {
          if (block.type === "toolCall" && block.name === "read") this.#toolCallModels.set(block.id, model);
        }
      }
    });
  }

  toolResult(event: ToolResultEvent, ctx: CollectorContext): void {
    this.#safe(() => {
      const model = this.#toolCallModels.get(event.toolCallId) ?? null;
      this.#toolCallModels.delete(event.toolCallId);
      if (event.toolName !== "read" || typeof event.input.path !== "string") return;
      const skill = skillFromReadPath(event.input.path, ctx.cwd, this.#catalog);
      if (skill) this.#enqueue({ kind: "read-result", skill, toolCallId: event.toolCallId, outcome: event.isError ? "error" : "success", model });
    });
  }

  sessionTree(event: SessionTreeEvent, ctx: CollectorContext): void {
    this.#safe(() => {
      if (event.newLeafId !== event.oldLeafId) this.#startSegment("branch", ctx);
    });
  }

  shutdown(_reason: Exclude<SegmentReason, "startup" | "branch" | "unknown"> | "quit", _ctx: CollectorContext): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    const state = this.#state;
    if (state.kind === "inactive") return Promise.resolve();
    this.#state = { ...state, kind: "closing" };
    this.#shutdownPromise = this.#close(state);
    return this.#shutdownPromise;
  }

  async #close(state: Exclude<CaptureState, { kind: "inactive" }>): Promise<void> {
    const timeout = setTimeout(() => state.abort.abort(), SHUTDOWN_DEADLINE_MS);
    try {
      await this.#scheduleFlush();
    } finally {
      clearTimeout(timeout);
      try { await state.store.close(); } catch { this.#reportFailure(); }
      this.#state = { kind: "inactive" };
      this.#toolCallModels.clear();
    }
  }

  #startSegment(reason: SegmentReason, ctx: CollectorContext): void {
    this.#scope = {
      projectCwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() ?? null,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null, segmentId: randomUUID(), segmentReason: reason,
      runId: null, turnId: null, leafId: ctx.sessionManager.getLeafId() ?? null,
    };
    this.#toolCallModels.clear();
  }

  #fact(evidence: Evidence, scope = this.#scope): Observation {
    this.#sequence += 1;
    return { id: `${this.#producerId}:${this.#sequence}`, producerId: this.#producerId,
      sequence: this.#sequence, observedAt: this.#now().toISOString(), scope: { ...scope }, evidence };
  }

  #enqueue(evidence: Evidence, scope = this.#scope): void {
    if (this.#state.kind === "closing") return;
    const observation = this.#fact(evidence, scope);
    if (this.#state.kind === "inactive") {
      this.#rememberLoss(observation, "db-error");
      return;
    }
    if (this.#queue.length >= MAX_QUEUE) this.#rememberLoss(observation, "queue-overflow");
    else this.#queue.push(observation);
    void this.#scheduleFlush();
  }

  #rememberLoss(observation: Observation, reason: GapReason): void {
    const count = observation.evidence.kind === "capture-gap" ? observation.evidence.dropped : 1;
    const gapReason = observation.evidence.kind === "capture-gap" ? observation.evidence.reason : reason;
    const key = JSON.stringify([observation.scope, gapReason]);
    const previous = this.#gaps.get(key);
    if (previous?.evidence.kind === "capture-gap") {
      this.#gaps.set(key, { ...previous, evidence: { ...previous.evidence, dropped: previous.evidence.dropped + count } });
    } else if (this.#gaps.size < MAX_QUEUE) {
      this.#gaps.set(key, observation.evidence.kind === "capture-gap" ? observation
        : this.#fact({ kind: "capture-gap", dropped: count, reason: gapReason }, observation.scope));
    }
    if (observation.evidence.kind !== "capture-gap") this.#dropped += count;
    this.#reportFailure();
  }

  #scheduleFlush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = nextTick().then(() => this.#drain()).catch(() => {
      for (const item of this.#queue.splice(0)) this.#rememberLoss(item, "db-error");
      this.#reportFailure();
    }).finally(() => { this.#flushPromise = null; });
    return this.#flushPromise;
  }

  async #drain(): Promise<void> {
    const state = this.#state;
    if (state.kind === "inactive") return;
    const gaps = [...this.#gaps.values()];
    this.#gaps.clear();
    let batch = [...this.#queue.splice(0), ...gaps];
    while (batch.length > 0) {
      if (state.abort.signal.aborted) {
        for (const item of batch) this.#rememberLoss(item, "shutdown-deadline");
      } else {
        try {
          const summary = await state.store.record(batch, { signal: state.abort.signal });
          for (const item of batch.slice(batch.length - summary.dropped)) {
            this.#rememberLoss(item, state.abort.signal.aborted ? "shutdown-deadline" : "db-error");
          }
        } catch {
          for (const item of batch) this.#rememberLoss(item, "db-error");
        }
      }
      batch = this.#queue.splice(0);
    }
  }

  #safe(work: () => void): void {
    try { work(); } catch {
      this.#rememberLoss(this.#fact({ kind: "capture-gap", dropped: 1, reason: "db-error" }), "db-error");
    }
  }

  #reportFailure(): void {
    try { this.#context?.ui.setStatus("hotplate", `Hotplate: capture incomplete (${this.#dropped} lost). Check HOTPLATE_DB and /reload.`); } catch {}
    if (!this.#warned) {
      this.#warned = true;
      process.stderr.write(`${JSON.stringify({ type: "hotplate_capture_incomplete", action: "Check HOTPLATE_DB and reload pi" })}\n`);
    }
  }
}
