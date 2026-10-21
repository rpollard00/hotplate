import type { MachineId, ModelRef, SourceId } from "./domain.js";

export type ProcessIdentity = { bootId: string; pid: number; startTicks: string };
export type ResourceKind = "skill" | "principle" | "reference" | "script" | "file";
export type ResourceLocation = {
  filesystemId: string;
  canonicalPath: string;
  observedPath: string;
  rootPath: string;
  kind: ResourceKind;
  ownerSkillPath: string | null;
};

type ResourceAccessIdentity = {
  kind: "resource-access";
  resource: ResourceLocation;
  operationId: string;
  model: ModelRef;
  process: ProcessIdentity | null;
  attribution: "session" | "harness" | "non-agent" | "unknown";
};


export type ReadPortion = { kind: "unknown" } | { kind: "whole" }
  | { kind: "lines"; start: number; count: number | null };
export type ReadDelivery = { kind: "unknown" }
  | { kind: "known"; returned: ReadPortion; truncated: boolean };
export type ToolReadMetadata = {
  kind: "structured-read" | "literal-command";
  requested: ReadPortion;
  delivery: ReadDelivery;
  revision: { kind: "unknown" } | { kind: "known"; value: string };
};
export type ResourceAccessEvidence = ResourceAccessIdentity & (
  | { mechanism: "fanotify"; access: "open" | "access"; outcome: "unknown"; toolRead?: never }
  | ({ mechanism: "host-tool" } & (
    | { access: "read"; outcome: "success" | "error"; toolRead?: ToolReadMetadata & { kind: "structured-read" } }
    | { access: "attempt"; outcome: "unknown"; toolRead?: ToolReadMetadata }
    | { access: "inferred-read"; outcome: "success"; toolRead: ToolReadMetadata & { kind: "literal-command" } }
    | { access: "execute"; outcome: "success" | "unknown"; toolRead?: never }
  ))
);
export type ToolCoverageEvidence = {
  kind: "tool-coverage";
  operationId: string;
  family: "file" | "shell" | "python" | "other";
  outcome: "success" | "error" | "unknown";
  model: ModelRef;
  recognition: { kind: "recognized"; resourceCount: number }
    | { kind: "opaque"; reason: "unsupported-syntax" | "missing-input" | "unsupported-tool" | "limit" };
};

export type InventoryOrigin = "configured" | "conventional" | "host";
export type InventoryScope = "account" | "project" | "session" | "unassigned";
export type InventoryError = "unreadable" | "missing" | "limit" | "cancelled" | "io-error";
type InventoryIdentity = {
  kind: "inventory-snapshot";
  scanId: string;
  filesystemId: string;
  rootPath: string;
  origin: InventoryOrigin;
  scope: InventoryScope;
};
export type InventorySnapshotEvidence = InventoryIdentity & (
  | { phase: "started"; resources: readonly []; error: null }
  | { phase: "batch"; resources: readonly ResourceLocation[]; batchIndex: number; error: null }
  | { phase: "complete"; resources: readonly []; batchCount: number; error: null }
  | { phase: "incomplete"; resources: readonly []; batchCount: number; error: InventoryError }
);

export type ObserverCoverageReason = "permission-denied" | "unsupported" | "helper-unavailable" | "queue-overflow" | "process-exited" | "io-error";
export type ObserverCoverageEvidence = {
  kind: "observer-coverage";
  observerId: string;
  mechanism: "fanotify" | "host-tool";
  filesystemId: string;
  rootPaths: readonly string[];
  heartbeatMs: number;
} & (
  | { status: "active" | "stopped"; reason: null }
  | { status: "unavailable" | "overflow"; reason: ObserverCoverageReason }
);

export type ResourceEvidence = ResourceAccessEvidence | InventorySnapshotEvidence | ObserverCoverageEvidence | ToolCoverageEvidence;

export type ResourceRow = {
  resourceId: string;
  machineId: MachineId;
  sourceId: SourceId | "local";
  resource: ResourceLocation;
  rootPaths: readonly string[];
  presence: "present" | "absent" | "unknown";
  firstInventoriedAt: string | null;
  lastInventoriedAt: string | null;
  lastAccessAt: string | null;
  attemptCount: number;
  successfulReadCount: number;
  inferredReadCount: number;
  failedReadCount: number;
  executeCount: number;
  openCount: number;
  accessCount: number;
  attributedAccessCount: number;
  unattributedAccessCount: number;
  nonAgentAccessCount: number;
  observation: "observed" | "not-observed" | "unknown";
  coverageFrom: string | null;
  coverageTo: string | null;
};
export type ResourceView = { rows: readonly ResourceRow[] };
export type ResourceCoverageRow = {
  machineId: MachineId;
  sourceId: SourceId | "local";
  observerId: string;
  filesystemId: string;
  rootPath: string;
  mechanism: "host-tool" | "fanotify";
  status: "active" | "stopped" | "unavailable" | "overflow" | "stale";
  reason: ObserverCoverageReason | null;
  lastObservedAt: string;
  heartbeatMs: number;
};
export type ResourceCoverageView = { rows: readonly ResourceCoverageRow[] };
