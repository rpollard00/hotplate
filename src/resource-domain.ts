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

export type ResourceAccessEvidence = {
  kind: "resource-access";
  resource: ResourceLocation;
  operationId: string;
  mechanism: "host-tool" | "fanotify";
  access: "attempt" | "read" | "open" | "access";
  outcome: "success" | "error" | "unknown";
  model: ModelRef;
  process: ProcessIdentity | null;
  attribution: "session" | "harness" | "non-agent" | "unknown";
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

export type ResourceEvidence = ResourceAccessEvidence | InventorySnapshotEvidence | ObserverCoverageEvidence;

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
  failedReadCount: number;
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
