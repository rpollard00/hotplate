import { createHash } from "node:crypto";
import type {
  HostId, ChainObservation, DashboardFilter, ModelRef, SkillChainRun, SkillChainView, SkillTableView,
} from "../domain.js";

type SkillKey = string & { readonly __brand: "DashboardSkillKey" };
type RouteKey = string & { readonly __brand: "DashboardRouteKey" };
type Counts = Readonly<{ requests: number; wrappers: number; successfulReads: number; failedReads: number; readAttempts: number; invocations: number }>;
type SkillIdentity =
  | Readonly<{ kind: "resolved"; host: HostId; machineId: SkillChainRun["machineId"]; name: string; canonicalPath: string }>
  | Readonly<{ kind: "request-only"; host: HostId; machineId: SkillChainRun["machineId"]; name: string }>;
type SkillSummary = Readonly<{
  key: SkillKey;
  identity: SkillIdentity;
  label: string;
  counts: Counts;
  cataloged: boolean;
  lastEvidenceAt: string | null;
  routeKeys: readonly RouteKey[];
}>;
type SourceStep = SkillChainRun["steps"][number];
type ObservationStep = Extract<SourceStep, { kind: "observations" }>;
type RouteStep =
  | Extract<SourceStep, { kind: "gap" }>
  | Readonly<Omit<ObservationStep, "items"> & {
      items: readonly Readonly<ChainObservation & { skillKey: SkillKey }>[];
    }>;
type Route = Readonly<{
  key: RouteKey;
  scope: Readonly<Omit<SkillChainRun, "steps">>;
  label: string;
  counts: Counts;
  firstEvidenceAt: string | null;
  lastEvidenceAt: string | null;
  steps: readonly RouteStep[];
}>;
type Activity =
  | Readonly<{ kind: "empty"; timezone: "UTC" }>
  | Readonly<{
      kind: "bucketed";
      timezone: "UTC";
      binWidthMs: number;
      startAt: string;
      endAt: string;
      bins: readonly Readonly<{
        startAt: string;
        endAt: string;
        counts: Counts;
        readRuns: number;
        skills: readonly Readonly<{ name: string; readRuns: number; successfulReads: number }>[];
      }>[];
    }>;
type ModelCell = Readonly<{ skillKey: SkillKey; successfulReads: number; failedReads: number }>;
type ModelColumn = Readonly<{
  model: ModelRef;
  successfulReads: number;
  failedReads: number;
  cells: readonly ModelCell[];
}>;
type SkillGroup = Readonly<{
  name: string;
  counts: Counts;
  skillKeys: readonly SkillKey[];
  routeKeys: readonly RouteKey[];
  cataloged: boolean;
  models: readonly Readonly<Omit<ModelColumn, "cells">>[];
}>;
type SameGroupEvidence = Readonly<{ routeKey: RouteKey; stepIndex: number }>;
type NextGroupEvidence = Readonly<{ routeKey: RouteKey; fromStepIndex: number; toStepIndex: number }>;
type Relationship =
  | Readonly<{ kind: "same-group"; skills: readonly [SkillKey, SkillKey]; evidence: readonly SameGroupEvidence[] }>
  | Readonly<{ kind: "next-group"; from: readonly SkillKey[]; to: readonly SkillKey[]; evidence: readonly NextGroupEvidence[] }>;

export type DashboardReport = Readonly<{
  scope: Readonly<DashboardFilter>;
  counts: Counts;
  skillsRead: number;
  skills: readonly SkillSummary[];
  skillGroups: readonly SkillGroup[];
  activity: Activity;
  models: readonly ModelColumn[];
  relationships: readonly Relationship[];
  routes: readonly Route[];
  coverage: Readonly<{
    captureGaps: number;
    droppedObservations: number;
    filteredOmissions: number;
    undatedEvidence: number;
    catalogContext: "machine-project-time";
  }>;
}>;
type ReportInput = Readonly<{ filter: DashboardFilter; skills: SkillTableView; chains: SkillChainView }>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type SkillAccumulator = Mutable<Omit<SkillSummary, "counts" | "routeKeys">> & {
  counts: Mutable<Counts>;
  routeKeys: Set<RouteKey>;
};
type ModelAccumulator = Mutable<Omit<ModelColumn, "cells">> & { cells: Map<SkillKey, Mutable<ModelCell>> };
type SameGroupRelationship = Omit<Extract<Relationship, { kind: "same-group" }>, "evidence"> & { evidence: SameGroupEvidence[] };
type NextGroupRelationship = Omit<Extract<Relationship, { kind: "next-group" }>, "evidence"> & { evidence: NextGroupEvidence[] };
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Inputs are existing store views for the same filter; chains must not use the legacy skill filter. */
export function buildDashboardReport({ filter, skills, chains }: ReportInput): DashboardReport {
  const counts = emptyCounts();
  const skillIndex = new Map<SkillKey, SkillAccumulator>();
  const modelIndex = new Map<string, ModelAccumulator>();
  const timespan: { first: number | undefined; last: number | undefined } = { first: undefined, last: undefined };
  const sameGroups = new Map<string, SameGroupRelationship>();
  const nextGroups = new Map<string, NextGroupRelationship>();
  const coverage: Mutable<DashboardReport["coverage"]> = {
    captureGaps: 0, droppedObservations: 0, filteredOmissions: 0, undatedEvidence: 0, catalogContext: "machine-project-time",
  };

  for (const row of skills.rows) {
    if (!row.cataloged || row.canonicalPath === null) continue;
    getSkill(skillIndex, {
      kind: "resolved", host: row.host ?? "unknown", machineId: row.machineId, name: row.skillName, canonicalPath: row.canonicalPath,
    }).cataloged = true;
  }

  const routes = chains.runs.map((run): Route => {
    const { steps: sourceSteps, ...scope } = run;
    const key = routeKey(run);
    const routeCounts = emptyCounts();
    const times: { first: string | null; last: string | null } = { first: null, last: null };
    let previous: { skills: SkillKey[]; stepIndex: number } | null = null;
    const steps = sourceSteps.map((step, stepIndex): RouteStep => {
      if (step.kind === "gap") {
        previous = null;
        if (step.reason === "filtered-intermediates") coverage.filteredOmissions += step.omitted;
        else {
          coverage.captureGaps += 1;
          coverage.droppedObservations += step.omitted;
        }
        return { ...step };
      }
      const successfulSkills = new Set<SkillKey>();
      const items = step.items.map((item) => {
        const skill = getSkill(skillIndex, observationIdentity(run.host ?? "unknown", run.machineId, item.evidence));
        const countKind = evidenceCountKind(item.evidence);
        counts[countKind] += 1;
        routeCounts[countKind] += 1;
        skill.counts[countKind] += 1;
        skill.routeKeys.add(key);
        const time = activityTime(item.observedAt);
        if (time === null) coverage.undatedEvidence += 1;
        else {
          const timestamp = new Date(item.observedAt).toISOString();
          skill.lastEvidenceAt = latest(skill.lastEvidenceAt, timestamp);
          times.first = earliest(times.first, timestamp);
          times.last = latest(times.last, timestamp);
          timespan.first = Math.min(timespan.first ?? time, time);
          timespan.last = Math.max(timespan.last ?? time, time);
        }
        if (item.evidence.kind === "read-result") {
          addModelRead(modelIndex, skill.key, item.evidence);
          if (item.evidence.outcome === "success") successfulSkills.add(skill.key);
        }
        return { ...item, skillKey: skill.key };
      });
      const group = [...successfulSkills].sort();
      for (const [index, left] of group.entries()) {
        for (const right of group.slice(index + 1)) {
          const relationshipKey = JSON.stringify([left, right]);
          const relationship = sameGroups.get(relationshipKey) ?? {
            kind: "same-group", skills: [left, right], evidence: [],
          } satisfies SameGroupRelationship;
          relationship.evidence.push({ routeKey: key, stepIndex });
          sameGroups.set(relationshipKey, relationship);
        }
      }
      if (previous !== null && group.length > 0) {
        const relationshipKey = JSON.stringify([previous.skills, group]);
        const relationship = nextGroups.get(relationshipKey) ?? {
          kind: "next-group", from: previous.skills, to: group, evidence: [],
        } satisfies NextGroupRelationship;
        relationship.evidence.push({ routeKey: key, fromStepIndex: previous.stepIndex, toStepIndex: stepIndex });
        nextGroups.set(relationshipKey, relationship);
      }
      previous = group.length > 0 ? { skills: group, stepIndex } : null;
      return { ...step, items };
    });
    const projectLabel = run.projectCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? run.projectCwd;
    return {
      key, scope, counts: routeCounts, firstEvidenceAt: times.first, lastEvidenceAt: times.last, steps,
      label: `${projectLabel} · ${times.last?.slice(0, 10) ?? "No matching evidence"}`,
    };
  });
  routes.sort((left, right) => {
    if (left.lastEvidenceAt === null && right.lastEvidenceAt !== null) return 1;
    if (right.lastEvidenceAt === null && left.lastEvidenceAt !== null) return -1;
    const recency = left.lastEvidenceAt !== null && right.lastEvidenceAt !== null
      ? Date.parse(right.lastEvidenceAt) - Date.parse(left.lastEvidenceAt) : 0;
    return recency || left.key.localeCompare(right.key);
  });
  const summaries = [...skillIndex.values()].map((skill): SkillSummary => ({ ...skill, routeKeys: [...skill.routeKeys] }));
  summaries.sort((left, right) => right.counts.successfulReads - left.counts.successfulReads
    || left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
  const skillGroups = buildSkillGroups(summaries, modelIndex);
  return {
    scope: { ...filter }, counts, skillsRead: skillGroups.filter((group) => group.counts.successfulReads > 0).length,
    skills: summaries, skillGroups, activity: buildActivity(filter, timespan, routes),
    models: [...modelIndex.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([, model]) => ({ ...model, cells: [...model.cells.values()].sort((left, right) => left.skillKey.localeCompare(right.skillKey)) })),
    relationships: [...sameGroups.values(), ...nextGroups.values()], routes, coverage,
  };
}

function buildSkillGroups(skills: readonly SkillSummary[], models: ReadonlyMap<string, ModelAccumulator>): SkillGroup[] {
  type GroupAccumulator = {
    name: string;
    counts: Mutable<Counts>;
    skillKeys: SkillKey[];
    routeKeys: Set<RouteKey>;
    cataloged: boolean;
    models: Map<string, Mutable<Omit<ModelColumn, "cells">>>;
  };
  const groups = new Map<string, GroupAccumulator>();
  const groupsBySkill = new Map<SkillKey, GroupAccumulator>();
  for (const skill of skills) {
    const group: GroupAccumulator = groups.get(skill.identity.name) ?? {
      name: skill.identity.name, counts: emptyCounts(), skillKeys: [], routeKeys: new Set(), cataloged: false, models: new Map(),
    };
    group.counts.readAttempts += skill.counts.readAttempts;
    group.counts.invocations += skill.counts.invocations;
    group.counts.requests += skill.counts.requests;
    group.counts.wrappers += skill.counts.wrappers;
    group.counts.successfulReads += skill.counts.successfulReads;
    group.counts.failedReads += skill.counts.failedReads;
    group.skillKeys.push(skill.key);
    for (const key of skill.routeKeys) group.routeKeys.add(key);
    group.cataloged ||= skill.cataloged;
    groups.set(group.name, group);
    groupsBySkill.set(skill.key, group);
  }
  for (const [modelKey, model] of models) {
    for (const cell of model.cells.values()) {
      const group = groupsBySkill.get(cell.skillKey);
      if (!group) continue;
      const totals = group.models.get(modelKey) ?? { model: model.model, successfulReads: 0, failedReads: 0 };
      totals.successfulReads += cell.successfulReads;
      totals.failedReads += cell.failedReads;
      group.models.set(modelKey, totals);
    }
  }
  return [...groups.values()].map((group): SkillGroup => ({
    ...group, routeKeys: [...group.routeKeys],
    models: [...group.models.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, model]) => model),
  })).sort((left, right) => right.counts.successfulReads - left.counts.successfulReads || left.name.localeCompare(right.name));
}

function emptyCounts(): Mutable<Counts> {
  return { requests: 0, wrappers: 0, successfulReads: 0, failedReads: 0, readAttempts: 0, invocations: 0 };
}

function observationIdentity(host: HostId, machineId: SkillChainRun["machineId"], evidence: ChainObservation["evidence"]): SkillIdentity {
  if (evidence.kind === "command-intent") return { kind: "request-only", host, machineId, name: evidence.skillName };
  if (evidence.skill.canonicalPath === null) return { kind: "request-only", host, machineId, name: evidence.skill.name };
  return { kind: "resolved", host, machineId, name: evidence.skill.name, canonicalPath: evidence.skill.canonicalPath };
}

function getSkill(index: Map<SkillKey, SkillAccumulator>, identity: SkillIdentity): SkillAccumulator {
  const key = createHash("sha256").update(JSON.stringify([
    identity.kind, identity.host, identity.machineId, identity.name, identity.kind === "resolved" ? identity.canonicalPath : null,
  ])).digest("hex") as SkillKey;
  const existing = index.get(key);
  if (existing) return existing;
  const skill: SkillAccumulator = {
    key, identity, label: identity.name, counts: emptyCounts(), cataloged: false, lastEvidenceAt: null, routeKeys: new Set(),
  };
  index.set(key, skill);
  return skill;
}

function routeKey(run: SkillChainRun): RouteKey {
  return createHash("sha256").update(JSON.stringify([
    run.host ?? "unknown", run.machineId, run.sourceId, run.projectCwd, run.sessionId, run.segmentId, run.runId,
    run.runId === null && run.host !== undefined && run.host !== "pi" && run.host !== "unknown" ? run.steps : null,
  ])).digest("hex") as RouteKey;
}

function evidenceCountKind(evidence: ChainObservation["evidence"]): keyof Counts {
  switch (evidence.kind) {
    case "read-attempt": return "readAttempts";
    case "skill-invocation": return "invocations";
    case "command-intent": return "requests";
    case "wrapper-observed": return "wrappers";
    case "read-result": return evidence.outcome === "success" ? "successfulReads" : "failedReads";
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
}

function addModelRead(index: Map<string, ModelAccumulator>, skillKey: SkillKey, evidence: Extract<ChainObservation["evidence"], { kind: "read-result" }>): void {
  const key = JSON.stringify(evidence.model === null ? null : [evidence.model.provider, evidence.model.id]);
  const column = index.get(key) ?? { model: evidence.model, successfulReads: 0, failedReads: 0, cells: new Map() };
  const cell = column.cells.get(skillKey) ?? { skillKey, successfulReads: 0, failedReads: 0 };
  const countKind = evidence.outcome === "success" ? "successfulReads" : "failedReads";
  column[countKind] += 1;
  cell[countKind] += 1;
  column.cells.set(skillKey, cell);
  index.set(key, column);
}

function earliest(current: string | null, value: string): string {
  return current === null || Date.parse(value) < Date.parse(current) ? value : current;
}

function latest(current: string | null, value: string): string {
  return current === null || Date.parse(value) > Date.parse(current) ? value : current;
}

function activityTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && Number.isFinite(new Date(Math.floor(time / DAY_MS) * DAY_MS + DAY_MS).getTime()) ? time : null;
}

function buildActivity(filter: DashboardFilter, timespan: { first: number | undefined; last: number | undefined }, routes: readonly Route[]): Activity {
  const first = activityTime(filter.fromObservedAt) ?? timespan.first;
  const lastIncluded = activityTime(filter.toObservedAt) ?? timespan.last;
  if (first === undefined || lastIncluded === undefined || first > lastIncluded) return { kind: "empty", timezone: "UTC" };
  const stepMs = lastIncluded - first <= 7 * DAY_MS ? HOUR_MS : DAY_MS;
  const start = Math.floor(first / stepMs) * stepMs;
  const end = Math.floor(lastIncluded / stepMs) * stepMs + stepMs;
  const binWidthMs = stepMs === HOUR_MS ? HOUR_MS : Math.ceil((end - start) / DAY_MS / 90) * DAY_MS;
  const bins: {
    startAt: string; endAt: string; counts: Mutable<Counts>;
    runs: Set<RouteKey>; skills: Map<string, { runs: Set<RouteKey>; successfulReads: number }>;
  }[] = [];
  for (let cursor = start; cursor < end; cursor += binWidthMs) {
    bins.push({
      startAt: new Date(cursor).toISOString(), endAt: new Date(Math.min(cursor + binWidthMs, end)).toISOString(),
      counts: emptyCounts(), runs: new Set(), skills: new Map(),
    });
  }
  for (const route of routes) for (const step of route.steps) {
    if (step.kind !== "observations") continue;
    for (const item of step.items) {
      const time = activityTime(item.observedAt);
      if (time === null || time < first || time > lastIncluded) continue;
      const bin = bins[Math.floor((time - start) / binWidthMs)];
      if (!bin) continue;
      bin.counts[evidenceCountKind(item.evidence)] += 1;
      if (item.evidence.kind !== "read-result" || item.evidence.outcome !== "success") continue;
      const knownRun = route.scope.runId !== null || route.scope.host === undefined || route.scope.host === "unknown" || route.scope.host === "pi";
      if (knownRun) bin.runs.add(route.key);
      const name = item.evidence.skill.name;
      const skill = bin.skills.get(name) ?? { runs: new Set<RouteKey>(), successfulReads: 0 };
      if (knownRun) skill.runs.add(route.key); skill.successfulReads += 1; bin.skills.set(name, skill);
    }
  }
  return {
    kind: "bucketed", timezone: "UTC", binWidthMs, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    bins: bins.map(({ runs, skills, ...bin }) => ({
      ...bin, readRuns: runs.size,
      skills: [...skills].sort(([left], [right]) => left.localeCompare(right)).map(([name, skill]) => ({ name, readRuns: skill.runs.size, successfulReads: skill.successfulReads })),
    })),
  };
}
