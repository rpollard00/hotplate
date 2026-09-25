export type InputSource = "interactive" | "rpc" | "extension";

export type ModelRef =
  | {
      provider: string;
      id: string;
    }
  | null;

export type SkillRef = {
  name: string;
  canonicalPath: string;
  version: string | null;
};

export type GapReason =
  | "queue-overflow"
  | "db-busy"
  | "db-error"
  | "shutdown-deadline"
  | "invalid-observation";

export type Evidence =
  | {
      kind: "command-intent";
      skillName: string;
      source: InputSource;
    }
  | {
      kind: "wrapper-observed";
      skill: SkillRef;
      wrapperSource: "expanded-prompt" | "unknown-pasted-or-transformed";
    }
  | {
      kind: "read-result";
      skill: SkillRef;
      toolCallId: string;
      outcome: "success" | "error";
      model: ModelRef;
    }
  | {
      kind: "catalog-snapshot";
      skills: readonly SkillRef[];
    }
  | {
      kind: "capture-gap";
      dropped: number;
      reason: GapReason;
    };

export type SegmentReason = "startup" | "reload" | "new" | "resume" | "fork" | "branch" | "unknown";

export type ObservationScope = {
  projectCwd: string;
  sessionId: string | null;
  sessionFile: string | null;
  segmentId: string;
  segmentReason: SegmentReason;
  runId: string | null;
  turnId: string | null;
  leafId: string | null;
};

export type Observation = {
  id: string;
  producerId: string;
  sequence: number;
  observedAt: string;
  scope: ObservationScope;
  evidence: Evidence;
};

export type CaptureWriteSummary = {
  accepted: number;
  duplicate: number;
  dropped: number;
};

export type DashboardFilter = {
  projectCwd?: string;
  sessionId?: string | null;
  runId?: string | null;
  source?: InputSource;
  modelProvider?: string | null;
  modelId?: string | null;
  fromObservedAt?: string;
  toObservedAt?: string;
};

export type ChainFilter = DashboardFilter & {
  skillName?: string;
  includeCommandIntent?: boolean;
  includeWrapperObserved?: boolean;
  includeReadResult?: boolean;
};

export type OverviewView = {
  observationCount: number;
  commandIntentCount: number;
  rpcCommandIntentCount: number;
  wrapperObservedCount: number;
  readResultCount: number;
  successfulReadCount: number;
  failedReadCount: number;
  uniqueObservedSkillRunActivations: number;
  catalogSkillCount: number;
  captureGapCount: number;
  droppedObservationCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
};

export type SkillTableRow = {
  skillName: string;
  canonicalPath: string | null;
  version: string | null;
  cataloged: boolean;
  commandIntentCount: number;
  interactiveCommandIntentCount: number;
  rpcCommandIntentCount: number;
  extensionCommandIntentCount: number;
  wrapperObservedCount: number;
  successfulReadCount: number;
  failedReadCount: number;
  readResultCount: number;
  uniqueObservedRunActivations: number;
  lastObservedAt: string | null;
};

export type SkillTableView = {
  rows: readonly SkillTableRow[];
};

export type ModelMatrixRow = {
  skillName: string;
  canonicalPath: string;
  model: ModelRef;
  successfulReadCount: number;
  failedReadCount: number;
  readResultCount: number;
  uniqueObservedRunActivations: number;
};

export type ModelMatrixView = {
  rows: readonly ModelMatrixRow[];
};

export type ChainObservation = {
  observationId: string;
  observedAt: string;
  sequence: number;
  evidence:
    | Extract<Evidence, { kind: "command-intent" }>
    | Extract<Evidence, { kind: "wrapper-observed" }>
    | Extract<Evidence, { kind: "read-result" }>;
};

export type SkillChainStep =
  | {
      kind: "observations";
      observedAt: string;
      turnId: string | null;
      leafId: string | null;
      items: readonly ChainObservation[];
    }
  | {
      kind: "gap";
      observedAt: string | null;
      omitted: number;
      reason: "filtered-intermediates" | GapReason;
    };

export type SkillChainRun = {
  sessionId: string | null;
  segmentId: string;
  runId: string | null;
  projectCwd: string;
  steps: readonly SkillChainStep[];
};

export type SkillChainView = {
  runs: readonly SkillChainRun[];
};

export type CaptureHealthReasonRow = {
  reason: GapReason;
  eventCount: number;
  droppedObservationCount: number;
  lastObservedAt: string | null;
};

export type CaptureHealthView = {
  captureGapCount: number;
  droppedObservationCount: number;
  byReason: readonly CaptureHealthReasonRow[];
  lastGapAt: string | null;
};

export interface HotplateStore {
  record(observation: Observation | readonly Observation[]): Promise<CaptureWriteSummary>;

  queryOverview(filter: DashboardFilter): Promise<OverviewView>;
  querySkillTable(filter: DashboardFilter): Promise<SkillTableView>;
  queryModelMatrix(filter: DashboardFilter): Promise<ModelMatrixView>;
  querySkillChain(filter: ChainFilter): Promise<SkillChainView>;
  queryCaptureHealth(filter: DashboardFilter): Promise<CaptureHealthView>;

  close(options?: { deadlineMs?: number }): Promise<void>;
}
