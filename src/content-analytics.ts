import { createHash } from "node:crypto";
import { analyticsEvidenceTime } from "./analytics-time.js";
import type { DashboardFilter, DashboardFilterOptions, Evidence, HostId, MachineId, ModelRef, Observation, SourceId } from "./domain.js";
import type { ReadDelivery, ReadPortion, ResourceAccessEvidence, ToolCoverageEvidence, ToolReadMetadata } from "./resource-domain.js";

export const contentMeasures = {
  toolActivity: { label: "Tool activity", resources: true },
  successfulReads: { label: "Confirmed reads", resources: true },
  inferredReads: { label: "Inferred reads", resources: true },
  failedReads: { label: "Read failures", resources: true },
  readAttempts: { label: "Read attempts", resources: true },
  activity: { label: "All recorded activity", resources: true },
  fsOpens: { label: "Filesystem opens", resources: true },
  fsAccesses: { label: "Filesystem accesses", resources: true },
  invocations: { label: "Native invocations", resources: false },
  invocationFailures: { label: "Invocation failures", resources: false },
  requests: { label: "Requests", resources: false },
  wrappers: { label: "Wrappers", resources: false },
} as const;

export type ContentMode = "resources" | "both";
export type ContentMeasure = keyof typeof contentMeasures;
export type ResourceMeasure = { [K in ContentMeasure]: typeof contentMeasures[K]["resources"] extends true ? K : never }[ContentMeasure];
export type EvidenceCategory = Exclude<ContentMeasure, "activity" | "toolActivity">;
export type ContentSplit = "item" | "agent" | "model" | "agent-model";
export type ContentInterval = { kind: "all" } | { kind: "interval"; startAt: string; endAt: string };
export type ContentQuery = { filter: DashboardFilter; split: ContentSplit; selection: ContentInterval } & (
  | { content: "resources"; measure: ResourceMeasure }
  | { content: "both"; measure: ContentMeasure }
);
export type EvidenceCounts = Record<EvidenceCategory, number>;
export type ContentAttribution = "session" | "harness" | "non-agent" | "unknown" | "none";
export type ContentStats = {
  count: number; counts: EvidenceCounts; datedCount: number; undatedCount: number;
  firstEvidenceAt: string | null; lastEvidenceAt: string | null;
  attributionCounts: Record<ContentAttribution, number>;
};
export type PhysicalLocation = { machineId: MachineId; sourceId: SourceId | "local"; filesystemId: string; canonicalPath: string };
export type ContentIdentity =
  | { kind: "owner"; location: PhysicalLocation }
  | { kind: "file"; location: PhysicalLocation; observedPath: string; ownerSkillPath: string | null; resourceKind: ResourceAccessEvidence["resource"]["kind"] }
  | { kind: "skill"; machineId: MachineId; sourceId: SourceId | "local"; host: HostId; name: string; canonicalPath: string | null };
export type ContentCohort = {
  key: string; label: string; host: HostId | null; model: ModelRef;
  modelAttribution: "known" | "unknown" | "none";
  actor: "agent" | "unknown" | "non-agent" | "mixed";
};
export type ContentSeries = ContentCohort & ContentStats;
type ReadCategory = Extract<EvidenceCategory, "successfulReads" | "inferredReads" | "failedReads" | "readAttempts">;
export type ContentReadGroup = {
  category: ReadCategory; count: number; requested: ReadPortion; delivery: ReadDelivery; revision: ToolReadMetadata["revision"];
};
export type ContentReadDetails = { groups: ContentReadGroup[]; omittedCount: number };
export type ContentCell = ContentStats & { key: string; readDetails: ContentReadDetails };
export type ContentRow = ContentStats & { key: string; label: string; identity: ContentIdentity; cells: readonly ContentCell[]; children: readonly ContentRow[]; readDetails: ContentReadDetails };
export type ContentActivity = { kind: "empty"; timezone: "UTC" } | {
  kind: "bucketed"; timezone: "UTC"; startAt: string; endAt: string; binWidthMs: number;
  bins: readonly { startAt: string; endAt: string; count: number; values: readonly { key: string; count: number }[] }[];
};
export type ContentReport = {
  query: ContentQuery; filterOptions: DashboardFilterOptions; overall: ContentStats;
  displayed: ContentStats & { series: readonly ContentSeries[]; activity: ContentActivity };
  selection: ContentStats & { interval: ContentInterval; series: readonly ContentSeries[]; rows: readonly ContentRow[] };
  coverage: { completeness: "unknown"; overall: ContentToolCoverage; displayed: ContentToolCoverage; selection: ContentToolCoverage };
};
export type ContentToolCoverage = {
  observedOperations: number; recognizedOperations: number; opaqueOperations: number; recognizedResources: number; undatedOperations: number;
  outcomes: Record<ToolCoverageEvidence["outcome"], number>;
  opaqueReasons: Record<Extract<ToolCoverageEvidence["recognition"], { kind: "opaque" }>["reason"], number>;
};
export type ContentSkillEvidence = Extract<Evidence, { kind: "read-result" | "read-attempt" | "skill-invocation" | "command-intent" | "wrapper-observed" }>;
export type ContentFact<E extends ContentSkillEvidence | ResourceAccessEvidence | ToolCoverageEvidence = ContentSkillEvidence | ResourceAccessEvidence> =
  Omit<Observation, "evidence"> & { machineId: MachineId; sourceId: SourceId | "local"; evidence: E; aggregate?: { count: number; lastObservedAt: string } };
export type ContentInput = {
  skills: readonly ContentFact<ContentSkillEvidence>[];
  resources: () => Iterable<ContentFact<ResourceAccessEvidence>>;
  resourceProjects?: readonly string[];
  coverage?: () => Iterable<ContentFact<ToolCoverageEvidence>>;
};
export type ContentTimelineRequest = { query: ContentQuery; projection: { rowKeys: readonly string[]; cohortKeys: readonly string[] } };
export type ContentRowTimeline = { rowKey: string; cohortKey: string | null; count: number; datedCount: number; undatedCount: number; values: readonly number[] };
export type ContentTimelines =
  | { kind: "empty"; timezone: "UTC"; rows: readonly ContentRowTimeline[] }
  | { kind: "bucketed"; timezone: "UTC"; startAt: string; endAt: string; binWidthMs: number; binCount: number; rows: readonly ContentRowTimeline[] };

export function isContentMeasure(value: string): value is ContentMeasure {
  return Object.hasOwn(contentMeasures, value);
}

export function isResourceMeasure(value: ContentMeasure): value is ResourceMeasure {
  return contentMeasures[value].resources;
}

export function buildContentAnalytics(query: ContentQuery, input: ContentInput): ContentReport {
  return buildContentData(query, input).report;
}

export function buildContentTimelines(request: ContentTimelineRequest, input: ContentInput): ContentTimelines {
  return buildContentData(request.query, input, request.projection).timelines;
}

function buildContentData(query: ContentQuery, input: ContentInput, projection?: ContentTimelineRequest["projection"]): { report: ContentReport; timelines: ContentTimelines } {
  const legacy = new Map<string, ContentFact<ContentSkillEvidence>[]>();
  const resources = new Map<string, { count: number; fact: ContentFact<ResourceAccessEvidence> }>();
  const owners = new Map<string, Map<string, PhysicalLocation>>();
  const filesystems = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  if (query.content === "both") {
    for (const fact of input.skills) {
      const key = mirrorKey(fact);
      if (key !== null) {
        const group = legacy.get(key) ?? [];
        group.push(fact); legacy.set(key, group);
      }
      if (fact.evidence.kind !== "command-intent" && fact.evidence.skill.canonicalPath !== null) {
        const key = pathKey(fact, fact.evidence.skill.canonicalPath);
        const labels = names.get(key) ?? new Set<string>();
        labels.add(fact.evidence.skill.name); names.set(key, labels);
      }
    }
    for (const fact of input.resources()) {
      const resource = fact.evidence.resource;
      for (const path of resource.ownerSkillPath === null ? [resource.canonicalPath] : [resource.canonicalPath, resource.ownerSkillPath]) {
        const key = pathKey(fact, path);
        const namespaces = filesystems.get(key) ?? new Set<string>();
        namespaces.add(resource.filesystemId); filesystems.set(key, namespaces);
      }
      if (resource.ownerSkillPath !== null) {
        const location = physical(fact, resource.ownerSkillPath);
        for (const path of [resource.canonicalPath, resource.ownerSkillPath]) {
          const key = pathKey(fact, path);
          const candidates = owners.get(key) ?? new Map<string, PhysicalLocation>();
          candidates.set(locationKey(location), location); owners.set(key, candidates);
        }
      }
      const key = mirrorKey(fact);
      if (key !== null && legacy.has(key)) {
        const previous = resources.get(key);
        if (previous) previous.count += 1;
        else resources.set(key, { count: 1, fact });
      }
    }
  }
  const paired = new Map<string, ContentFact<ContentSkillEvidence>>();
  for (const [key, group] of legacy) {
    const fact = group[0];
    if (group.length === 1 && fact && resources.get(key)?.count === 1) paired.set(key, fact);
  }
  const events = function* (): Generator<Event> {
    if (query.content === "both") for (const fact of input.skills) {
      const key = mirrorKey(fact);
      if (key !== null && paired.has(key)) continue;
      yield event(fact, null);
    }
    for (const fact of input.resources()) {
      const key = query.content === "both" ? mirrorKey(fact) : null;
      const match = key === null ? undefined : paired.get(key);
      yield event(match ?? fact, fact.evidence);
    }
  };
  const filterOptions: DashboardFilterOptions = { hosts: [], machines: [], projects: [], agentModelPairs: [], modelProviders: [], modelIds: [], timeRange: { firstObservedAt: null, lastObservedAt: null } };
  const hosts = new Set<HostId>(); const machines = new Set<MachineId>(); const projects = new Set<string>();
  for (const project of input.resourceProjects ?? []) projects.add(project);
  const pairs = new Map<string, { host: HostId; model: ModelRef }>();
  const providers = new Set<string>(); const models = new Set<string>();
  const { host: ignoredHost, modelSelection: ignoredSelection, modelProvider: ignoredProvider, modelId: ignoredModel, ...facetFilter } = query.filter;
  let first: number | undefined; let last: number | undefined;
  function addFacet(item: ScopedEvent): void {
    if (matches(item, facetFilter)) {
      hosts.add(item.host); machines.add(item.fact.machineId); projects.add(item.fact.scope.projectCwd);
      if (item.modelAttribution !== "none") pairs.set(JSON.stringify([item.host, item.model]), { host: item.host, model: item.model });
      if (item.model) { providers.add(item.model.provider); models.add(item.model.id); }
      if (item.time !== null) {
        filterOptions.timeRange.firstObservedAt = earlier(filterOptions.timeRange.firstObservedAt, item.fact.observedAt);
        filterOptions.timeRange.lastObservedAt = later(filterOptions.timeRange.lastObservedAt, item.fact.aggregate?.lastObservedAt ?? item.fact.observedAt);
      }
    }
  }
  for (const item of events()) {
    if (query.measure !== "toolActivity" || targets(item, query.measure)) addFacet(item);
    if (!targets(item, query.measure) || !matches(item, query.filter) || item.time === null) continue;
    first = Math.min(first ?? item.time, item.time);
    const lastTime = Date.parse(item.fact.aggregate?.lastObservedAt ?? item.fact.observedAt);
    last = Math.max(last ?? lastTime, lastTime);
  }
  const coverage: ContentReport["coverage"] = {
    completeness: "unknown", overall: coverageStats(), displayed: coverageStats(), selection: coverageStats(),
  };
  const coveredOperations = new Set<string>();
  for (const fact of input.coverage?.() ?? []) {
    const key = JSON.stringify([fact.machineId, fact.sourceId, fact.host, fact.scope.projectCwd, fact.scope.sessionId,
      fact.scope.segmentId, fact.scope.runId, fact.scope.turnId, fact.scope.leafId, fact.evidence.operationId]);
    if (coveredOperations.has(key)) continue;
    coveredOperations.add(key);
    const item = coverageEvent(fact);
    addFacet(item);
    if (!matches(item, query.filter)) continue;
    addCoverage(coverage.overall, fact.evidence, item.time);
    if (item.time !== null) addCoverage(coverage.displayed, fact.evidence, item.time);
    if (selectedTime(item.time, query.selection)) addCoverage(coverage.selection, fact.evidence, item.time);
  }
  filterOptions.hosts = [...hosts].sort(); filterOptions.machines = [...machines].sort(); filterOptions.projects = [...projects].sort();
  filterOptions.agentModelPairs = [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  filterOptions.modelProviders = [...providers].sort(); filterOptions.modelIds = [...models].sort();
  const activity = activityFor(query.filter, first, last);
  const timelineRows: (ContentRowTimeline & { values: number[] })[] = [];
  const timelineLookup = new Map<string, (ContentRowTimeline & { values: number[] })[]>();
  for (const rowKey of projection?.rowKeys ?? []) {
    const rows = (projection?.cohortKeys.length ? projection.cohortKeys : [null]).map(cohortKey => ({
      rowKey, cohortKey, count: 0, datedCount: 0, undatedCount: 0, values: Array<number>(activity.kind === "bucketed" ? activity.bins.length : 0).fill(0),
    }));
    timelineRows.push(...rows); timelineLookup.set(rowKey, rows);
  }
  const bins = activity.kind === "empty" ? [] : activity.bins.map(bin => ({ ...bin, values: new Map<string, number>() }));
  const overall = stats(); const displayed = stats(); const selected = stats();
  const cohorts = new Map<string, { identity: ContentCohort; all: ContentStats; displayed: ContentStats; selected: ContentStats }>();
  const rows = new Map<string, MutableRow>();
  const ownerLabel = (location: PhysicalLocation): string => {
    const labels = names.get(pathKey(location, location.canonicalPath));
    return labels?.size === 1 ? [...labels][0] ?? basename(parentPath(location.canonicalPath)) : basename(parentPath(location.canonicalPath));
  };
  for (const item of events()) {
    if (!matches(item, query.filter)) continue;
    const identity = rowIdentity(item);
    const physicalRowKey = identityKey(identity);
    let owner: PhysicalLocation | null = null;
    if (query.content === "both") {
      if (item.resource?.resource.ownerSkillPath !== null && item.resource?.resource.ownerSkillPath !== undefined) owner = physical(item.fact, item.resource.resource.ownerSkillPath, item.resource.resource.filesystemId);
      else if (identity.kind === "skill" && identity.canonicalPath !== null) {
        const path = pathKey(item.fact, identity.canonicalPath);
        const candidates = owners.get(path);
        if (candidates?.size === 1 && filesystems.get(path)?.size === 1) owner = [...candidates.values()][0] ?? null;
      }
    }
    const parentKey = owner === null ? null : identityKey({ kind: "owner", location: owner });
    const rowKey = query.content === "both" && parentKey !== null ? createHash("sha256").update(JSON.stringify([physicalRowKey, parentKey])).digest("hex") : physicalRowKey;
    const label = identity.kind === "file" ? basename(identity.location.canonicalPath) : identity.kind === "skill" ? identity.name : ownerLabel(identity.location);
    const rootKey = parentKey ?? rowKey;
    const rootLabel = owner === null ? label : ownerLabel(owner);
    const cohortIdentity = cohortFor(item, query.split, rootKey, rootLabel);
    let cohort = cohorts.get(cohortIdentity.key);
    if (!cohort) { cohort = { identity: cohortIdentity, all: stats(), displayed: stats(), selected: stats() }; cohorts.set(cohortIdentity.key, cohort); }
    add(overall, item, query.measure); add(cohort.all, item, query.measure);
    if (item.time !== null) {
      add(displayed, item, query.measure); add(cohort.displayed, item, query.measure);
      if (activity.kind === "bucketed" && targets(item, query.measure)) {
        const bin = bins[Math.floor((item.time - Date.parse(activity.startAt)) / activity.binWidthMs)];
        const count = item.fact.aggregate?.count ?? 1;
        if (bin) { bin.count += count; bin.values.set(cohortIdentity.key, (bin.values.get(cohortIdentity.key) ?? 0) + count); }
      }
    }
    if (!selectedTime(item.time, query.selection)) continue;
    if (targets(item, query.measure)) for (const key of parentKey === null ? [rowKey] : [rowKey, parentKey]) {
      for (const timeline of timelineLookup.get(key) ?? []) {
        if (timeline.cohortKey !== null && timeline.cohortKey !== cohortIdentity.key) continue;
        const count = item.fact.aggregate?.count ?? 1;
        timeline.count += count;
        if (item.time === null) timeline.undatedCount += count;
        else {
          timeline.datedCount += count;
          if (activity.kind === "bucketed") {
            const index = Math.floor((item.time - Date.parse(activity.startAt)) / activity.binWidthMs);
            if (index >= 0 && index < timeline.values.length) timeline.values[index] = (timeline.values[index] ?? 0) + count;
          }
        }
      }
    }
    add(selected, item, query.measure); add(cohort.selected, item, query.measure);
    let row = rows.get(rowKey);
    if (!row) { row = { ...stats(), key: rowKey, identity, label, parentKey, cells: new Map(), readDetails: readDetails() }; rows.set(rowKey, row); }
    add(row, item, query.measure);
    addReadDetails(row.readDetails, item);
    let cell = row.cells.get(cohortIdentity.key);
    if (!cell) { cell = { ...stats(), key: cohortIdentity.key, readDetails: readDetails() }; row.cells.set(cohortIdentity.key, cell); }
    add(cell, item, query.measure);
    addReadDetails(cell.readDetails, item);
    if (owner !== null && parentKey !== null && !rows.has(parentKey)) rows.set(parentKey, {
      ...stats(), key: parentKey, identity: { kind: "owner", location: owner }, label: rootLabel, parentKey: null, cells: new Map(), readDetails: readDetails(),
    });
  }
  const ordered = [...cohorts.values()].filter(cohort => cohort.all.count > 0)
    .sort((a, b) => b.displayed.count - a.displayed.count || b.all.count - a.all.count || a.identity.label.localeCompare(b.identity.label) || a.identity.key.localeCompare(b.identity.key));
  const orderedKeys = new Map(ordered.map((cohort, index) => [cohort.identity.key, index]));
  const children = new Map<string, ContentRow[]>();
  const finalized: ContentRow[] = [];
  for (const row of rows.values()) {
    if (row.identity.kind === "owner") continue;
    const { parentKey, cells, ...rest } = row;
    const finished: ContentRow = { ...rest, cells: [...cells.values()].filter(cell => orderedKeys.has(cell.key)).sort((a, b) => (orderedKeys.get(a.key) ?? 0) - (orderedKeys.get(b.key) ?? 0)), children: [] };
    if (parentKey === null) finalized.push(finished);
    else { const group = children.get(parentKey) ?? []; group.push(finished); children.set(parentKey, group); }
  }
  for (const [key, descendants] of children) {
    const owner = rows.get(key);
    if (!owner) continue;
    const totals = stats(); const cells = new Map<string, ContentCell>();
    for (const child of descendants) {
      merge(totals, child);
      for (const cell of child.cells) {
        const total = cells.get(cell.key) ?? { ...stats(), key: cell.key, readDetails: readDetails() };
        merge(total, cell); cells.set(cell.key, total);
      }
    }
    finalized.push({ ...totals, key, label: owner.label, identity: owner.identity, readDetails: readDetails(),
      cells: [...cells.values()].sort((a, b) => (orderedKeys.get(a.key) ?? 0) - (orderedKeys.get(b.key) ?? 0)), children: descendants.sort(compareRows) });
  }
  const report: ContentReport = {
    query, filterOptions, overall, coverage,
    displayed: { ...displayed, series: ordered.map(cohort => ({ ...cohort.identity, ...cohort.displayed })),
      activity: activity.kind === "empty" ? activity : { ...activity, bins: bins.map(bin => ({ ...bin, values: [...bin.values].map(([key, count]) => ({ key, count })) })) } },
    selection: { ...selected, interval: query.selection, series: ordered.map(cohort => ({ ...cohort.identity, ...cohort.selected })), rows: finalized.sort(compareRows) },
  };
  return { report, timelines: activity.kind === "empty" ? { kind: "empty", timezone: "UTC", rows: timelineRows }
    : { kind: "bucketed", timezone: "UTC", startAt: activity.startAt, endAt: activity.endAt,
      binWidthMs: activity.binWidthMs, binCount: activity.bins.length, rows: timelineRows } };
}

type ScopedEvent = { fact: ContentFact<ContentSkillEvidence | ResourceAccessEvidence | ToolCoverageEvidence>; host: HostId; model: ModelRef;
  modelAttribution: ContentCohort["modelAttribution"]; attribution: ContentAttribution; actor: Exclude<ContentCohort["actor"], "mixed">; time: number | null };
type Event = ScopedEvent & { fact: ContentFact; resource: ResourceAccessEvidence | null; category: EvidenceCategory };
type MutableRow = ContentStats & { key: string; identity: ContentIdentity; label: string; parentKey: string | null; cells: Map<string, ContentCell>; readDetails: ContentReadDetails };

function event(fact: ContentFact, resource: ResourceAccessEvidence | null): Event {
  const evidence = fact.evidence;
  const attributed = evidence.kind !== "command-intent" && evidence.kind !== "wrapper-observed";
  const model = attributed ? evidence.model : null;
  const host = fact.host ?? "unknown";
  const attribution = resource?.attribution ?? (attributed ? fact.scope.sessionId === null ? "harness" : "session" : "none");
  const time = analyticsEvidenceTime(fact.observedAt);
  return { fact, resource, category: categoryOf(evidence), host, model, modelAttribution: attributed ? model === null ? "unknown" : "known" : "none",
    attribution, actor: attribution === "non-agent" ? "non-agent" : host === "unknown" ? "unknown" : "agent", time };
}

function categoryOf(evidence: ContentFact["evidence"]): EvidenceCategory {
  switch (evidence.kind) {
    case "read-result": return evidence.outcome === "success" ? "successfulReads" : "failedReads";
    case "read-attempt": return "readAttempts";
    case "skill-invocation": return evidence.outcome === "success" ? "invocations" : "invocationFailures";
    case "command-intent": return "requests";
    case "wrapper-observed": return "wrappers";
    case "resource-access":
      switch (evidence.access) {
        case "read": return evidence.outcome === "success" ? "successfulReads" : "failedReads";
        case "inferred-read": return "inferredReads";
        case "attempt": return "readAttempts";
        case "open": return "fsOpens";
        case "access": return "fsAccesses";
        default: { const exhaustive: never = evidence; return exhaustive; }
      }
    default: { const exhaustive: never = evidence; return exhaustive; }
  }
}

function mirrorKey(fact: ContentFact): string | null {
  const evidence = fact.evidence;
  let path: string; let operation: string;
  if (evidence.kind === "read-result" || evidence.kind === "read-attempt") { path = evidence.skill.canonicalPath; operation = evidence.toolCallId; }
  else if (evidence.kind === "resource-access" && evidence.mechanism === "host-tool") { path = evidence.resource.canonicalPath; operation = evidence.operationId; }
  else return null;
  const scope = fact.scope;
  return JSON.stringify([fact.machineId, fact.sourceId, fact.host ?? "unknown", scope.projectCwd, scope.sessionId, scope.segmentId, scope.runId, scope.turnId, scope.leafId,
    operation, path, categoryOf(evidence), evidence.model]);
}

function matches(item: ScopedEvent, filter: DashboardFilter): boolean {
  const fact = item.fact;
  if (filter.machineId !== undefined && fact.machineId !== filter.machineId) return false;
  if (filter.host !== undefined && (item.host !== filter.host || item.actor === "non-agent" && filter.host !== "unknown")) return false;
  if (filter.projectCwd !== undefined && fact.scope.projectCwd !== filter.projectCwd) return false;
  if (filter.sessionId !== undefined && fact.scope.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && fact.scope.runId !== filter.runId) return false;
  if (filter.source !== undefined && (fact.evidence.kind !== "command-intent" || fact.evidence.source !== filter.source)) return false;
  if (filter.modelSelection !== undefined) {
    if (item.modelAttribution === "none") return false;
    if (filter.modelSelection.kind === "unknown" ? item.model !== null : item.model?.provider !== filter.modelSelection.model.provider || item.model?.id !== filter.modelSelection.model.id) return false;
  } else {
    if (filter.modelProvider !== undefined && (item.model?.provider ?? null) !== filter.modelProvider) return false;
    if (filter.modelId !== undefined && (item.model?.id ?? null) !== filter.modelId) return false;
  }
  if (filter.fromObservedAt !== undefined && (item.time === null || item.time < Date.parse(filter.fromObservedAt))) return false;
  if (filter.toObservedAt !== undefined && (item.time === null || item.time > Date.parse(filter.toObservedAt))) return false;
  return true;
}

function physical(fact: Pick<ContentFact, "machineId" | "sourceId"> & { evidence?: ContentFact["evidence"] }, canonicalPath: string, filesystemId?: string): PhysicalLocation {
  const namespace = filesystemId ?? (fact.evidence?.kind === "resource-access" ? fact.evidence.resource.filesystemId : "");
  return { machineId: fact.machineId, sourceId: fact.sourceId, filesystemId: namespace, canonicalPath };
}

function rowIdentity(item: Event): ContentIdentity {
  if (item.resource) {
    const resource = item.resource.resource;
    return { kind: "file", location: physical(item.fact, resource.canonicalPath, resource.filesystemId), observedPath: resource.observedPath, ownerSkillPath: resource.ownerSkillPath, resourceKind: resource.kind };
  }
  const evidence = item.fact.evidence;
  if (evidence.kind === "resource-access") return { kind: "file", location: physical(item.fact, evidence.resource.canonicalPath), observedPath: evidence.resource.observedPath, ownerSkillPath: evidence.resource.ownerSkillPath, resourceKind: evidence.resource.kind };
  return { kind: "skill", machineId: item.fact.machineId, sourceId: item.fact.sourceId, host: item.host,
    name: evidence.kind === "command-intent" ? evidence.skillName : evidence.skill.name, canonicalPath: evidence.kind === "command-intent" ? null : evidence.skill.canonicalPath };
}

function locationKey(location: PhysicalLocation): string { return JSON.stringify([location.machineId, location.sourceId, location.filesystemId, location.canonicalPath]); }
function pathKey(source: Pick<PhysicalLocation, "machineId" | "sourceId">, path: string): string { return JSON.stringify([source.machineId, source.sourceId, path]); }
function identityKey(identity: ContentIdentity): string {
  const value = identity.kind === "skill" ? [identity.kind, identity.machineId, identity.sourceId, identity.host, identity.name, identity.canonicalPath] : [identity.kind, locationKey(identity.location)];
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cohortFor(item: Event, split: ContentSplit, rowKey: string, label: string): ContentCohort {
  const modelKey = [item.modelAttribution, item.model?.provider ?? null, item.model?.id ?? null];
  const modelLabel = item.modelAttribution === "none" ? "No model attribution" : item.model === null ? "Unknown model" : `${item.model.provider} / ${item.model.id}`;
  const hostLabel = item.actor === "non-agent" ? "Non-agent" : item.host === "unknown" ? "Unknown host" : item.host;
  if (split === "item") return { key: rowKey, label, host: null, model: null, modelAttribution: "none", actor: "mixed" };
  if (split === "agent") return { key: JSON.stringify(["agent", item.actor, item.host]), label: hostLabel, host: item.host, model: null, modelAttribution: "none", actor: item.actor };
  if (split === "model") return { key: JSON.stringify(["model", item.actor === "non-agent" ? "non-agent" : "agent", modelKey]), label: item.actor === "non-agent" ? `Non-agent · ${modelLabel}` : modelLabel,
    host: null, model: item.model, modelAttribution: item.modelAttribution, actor: item.actor === "non-agent" ? "non-agent" : "mixed" };
  return { key: JSON.stringify(["agent-model", item.actor, item.host, modelKey]), label: `${hostLabel} · ${modelLabel}`, host: item.host, model: item.model, modelAttribution: item.modelAttribution, actor: item.actor };
}

function stats(): ContentStats {
  return { count: 0, datedCount: 0, undatedCount: 0, firstEvidenceAt: null, lastEvidenceAt: null,
    counts: { successfulReads: 0, inferredReads: 0, failedReads: 0, readAttempts: 0, fsOpens: 0, fsAccesses: 0, invocations: 0, invocationFailures: 0, requests: 0, wrappers: 0 },
    attributionCounts: { session: 0, harness: 0, "non-agent": 0, unknown: 0, none: 0 } };
}
function targets(item: Event, measure: ContentMeasure): boolean {
  return measure === "activity" || measure === item.category || measure === "toolActivity"
    && item.category !== "fsOpens" && item.category !== "fsAccesses" && item.category !== "requests" && item.category !== "wrappers";
}
function add(tally: ContentStats, item: Event, measure: ContentMeasure): void {
  const count = item.fact.aggregate?.count ?? 1;
  tally.counts[item.category] += count;
  if (!targets(item, measure)) return;
  tally.count += count; tally.attributionCounts[item.attribution] += count;
  if (item.time === null) { tally.undatedCount += count; return; }
  tally.datedCount += count;
  const timestamp = new Date(item.time).toISOString();
  tally.firstEvidenceAt = earlier(tally.firstEvidenceAt, timestamp);
  const lastTime = analyticsEvidenceTime(item.fact.aggregate?.lastObservedAt ?? item.fact.observedAt);
  tally.lastEvidenceAt = later(tally.lastEvidenceAt, lastTime === null ? timestamp : new Date(lastTime).toISOString());
}
function merge(tally: ContentStats, other: ContentStats): void {
  tally.count += other.count; tally.datedCount += other.datedCount; tally.undatedCount += other.undatedCount;
  for (const key of Object.keys(contentMeasures)) if (isContentMeasure(key) && key !== "activity" && key !== "toolActivity") tally.counts[key] += other.counts[key];
  for (const key of ["session", "harness", "non-agent", "unknown", "none"] as const) tally.attributionCounts[key] += other.attributionCounts[key];
  if (other.firstEvidenceAt !== null) tally.firstEvidenceAt = earlier(tally.firstEvidenceAt, other.firstEvidenceAt);
  if (other.lastEvidenceAt !== null) tally.lastEvidenceAt = later(tally.lastEvidenceAt, other.lastEvidenceAt);
}
function earlier(left: string | null, right: string): string { return left === null || Date.parse(right) < Date.parse(left) ? right : left; }
function later(left: string | null, right: string): string { return left === null || Date.parse(right) > Date.parse(left) ? right : left; }
function basename(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
function parentPath(path: string): string { return path.replace(/[\\/][^\\/]+$/u, ""); }
function compareRows(a: ContentRow, b: ContentRow): number { return b.count - a.count || a.label.localeCompare(b.label) || a.key.localeCompare(b.key); }

function selectedTime(time: number | null, selection: ContentInterval): boolean {
  return selection.kind === "all" || time !== null && time >= Date.parse(selection.startAt) && time < Date.parse(selection.endAt);
}

function coverageEvent(fact: ContentFact<ToolCoverageEvidence>): ScopedEvent {
  const time = analyticsEvidenceTime(fact.observedAt);
  const host = fact.host ?? "unknown";
  return { fact, host, model: fact.evidence.model, modelAttribution: fact.evidence.model === null ? "unknown" : "known",
    attribution: fact.scope.sessionId === null ? "harness" : "session", actor: host === "unknown" ? "unknown" : "agent", time };
}

function coverageStats(): ContentToolCoverage {
  return { observedOperations: 0, recognizedOperations: 0, opaqueOperations: 0, recognizedResources: 0, undatedOperations: 0,
    outcomes: { success: 0, error: 0, unknown: 0 },
    opaqueReasons: { "unsupported-syntax": 0, "missing-input": 0, "unsupported-tool": 0, limit: 0 } };
}

function addCoverage(tally: ContentToolCoverage, evidence: ToolCoverageEvidence, time: number | null): void {
  tally.observedOperations += 1;
  tally.outcomes[evidence.outcome] += 1;
  if (time === null) tally.undatedOperations += 1;
  if (evidence.recognition.kind === "recognized") {
    tally.recognizedOperations += 1;
    tally.recognizedResources += evidence.recognition.resourceCount;
  } else {
    tally.opaqueOperations += 1;
    tally.opaqueReasons[evidence.recognition.reason] += 1;
  }
}

function readDetails(): ContentReadDetails { return { groups: [], omittedCount: 0 }; }

function addReadDetails(details: ContentReadDetails, item: Event): void {
  if (item.category !== "successfulReads" && item.category !== "inferredReads" && item.category !== "failedReads" && item.category !== "readAttempts") return;
  const metadata = item.resource?.toolRead ?? (item.fact.evidence.kind === "resource-access" ? item.fact.evidence.toolRead : undefined);
  const group: ContentReadGroup = { category: item.category, count: 1, requested: metadata?.requested ?? { kind: "unknown" },
    delivery: metadata?.delivery ?? { kind: "unknown" }, revision: metadata?.revision ?? { kind: "unknown" } };
  const key = readGroupKey(group);
  const existing = details.groups.find(value => readGroupKey(value) === key);
  if (existing) existing.count += 1;
  else if (details.groups.length < 8) details.groups.push(group);
  else details.omittedCount += 1;
}

function readGroupKey(group: ContentReadGroup): string {
  return JSON.stringify([group.category, group.requested, group.delivery, group.revision]);
}

function activityFor(filter: DashboardFilter, first: number | undefined, last: number | undefined): ContentActivity {
  first = filter.fromObservedAt === undefined ? first : analyticsEvidenceTime(filter.fromObservedAt) ?? undefined;
  last = filter.toObservedAt === undefined ? last : analyticsEvidenceTime(filter.toObservedAt) ?? undefined;
  if (first === undefined || last === undefined || first > last) return { kind: "empty", timezone: "UTC" };
  const hour = 3_600_000; const day = 24 * hour;
  const step = last - first <= 7 * day ? hour : day;
  const start = Math.floor(first / step) * step; const end = Math.floor(last / step) * step + step;
  const binWidthMs = step === hour ? hour : Math.ceil((end - start) / day / 90) * day;
  const bins: Extract<ContentActivity, { kind: "bucketed" }>["bins"][number][] = [];
  for (let time = start; time < end; time += binWidthMs) bins.push({ startAt: new Date(time).toISOString(), endAt: new Date(Math.min(time + binWidthMs, end)).toISOString(), count: 0, values: [] });
  return { kind: "bucketed", timezone: "UTC", startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), binWidthMs, bins };
}
