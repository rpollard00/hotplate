import type { HostId, ModelRef } from "../domain.js";
import type { DashboardReport } from "./analytics.js";

export type MetricMeasure = "successfulReads" | "failedReads" | "uses" | "invocations" | "invocationFailures" | "readAttempts" | "requests" | "wrappers";
export type MetricsPresentation = Readonly<{ split: "skill" | "agent" | "model" | "agent-model" } & (
  | { measure: MetricMeasure; display: "count" | "timeline" }
  | { measure: "uses"; display: "session-share" }
)>;
export type MetricCounts = Readonly<Record<MetricMeasure, number>>;
export type MetricCell = Readonly<{ key: string; count: number; counts: MetricCounts; sessions: number; eligibleSessions: number; share: number | null; routeKeys: readonly string[] }>;
export type MetricSeries = Readonly<{ key: string; label: string; host: HostId | null; model: ModelRef; attribution: "known" | "unknown" | "none"; count: number; counts: MetricCounts; sessions: number; eligibleSessions: number; routeKeys: readonly string[] }>;
export type MetricTimelineProjection = Readonly<{ skillNames: readonly string[]; cohortKeys: readonly string[] }>;
export type MetricRowTimeline = Readonly<{ name: string; cohortKey: string | null; count: number; datedCount: number; undatedCount: number; values: readonly number[] }>;
export type MetricsView = Readonly<{
  presentation: MetricsPresentation; totals: MetricCounts; undatedCount: number;
  series: readonly MetricSeries[];
  timeline: readonly Readonly<{ startAt: string; endAt: string; count: number; values: readonly Readonly<{ key: string; count: number }>[] }>[];
  rowTimelines: readonly MetricRowTimeline[];
  skills: readonly Readonly<{ name: string; count: number; counts: MetricCounts; sessions: number; eligibleSessions: number; share: number | null; skillKeys: readonly string[]; routeKeys: readonly string[]; cells: readonly MetricCell[] }>[];
}>;

export function projectMetrics(report: DashboardReport, presentation: MetricsPresentation, projection?: MetricTimelineProjection): MetricsView {
  type Counts = { -readonly [K in keyof MetricCounts]: number };
  type Tally = { counts: Counts; sessions: Set<string>; routes: Set<string> };
  type Cohort = Tally & { key: string; label: string; host: HostId | null; model: ModelRef; attribution: MetricSeries["attribution"] };
  const emptyCounts = (): Counts => ({ successfulReads: 0, failedReads: 0, uses: 0, invocations: 0, invocationFailures: 0, readAttempts: 0, requests: 0, wrappers: 0 });
  const tally = (): Tally => ({ counts: emptyCounts(), sessions: new Set(), routes: new Set() });
  const totals = emptyCounts();
  const sessions = new Set<string>();
  const cohorts = new Map<string, Cohort>();
  const skills = new Map<string, Tally & { name: string; skillKeys: Set<string>; cells: Map<string, Tally> }>();
  const timeline = report.activity.kind === "bucketed" ? report.activity.bins.map(bin => ({ startAt: bin.startAt, endAt: bin.endAt, count: 0, values: new Map<string, number>() })) : [];
  const activity = report.activity;
  const projectedNames = new Set(projection?.skillNames.slice(0, 12));
  const projectedCohorts = new Set(projection?.cohortKeys.slice(0, 6));
  const rowTimelines = new Map<string, { name: string; cohortKey: string | null; count: number; undatedCount: number; values: number[] }>();
  const first = report.scope.fromObservedAt === undefined ? -Infinity : Date.parse(report.scope.fromObservedAt);
  const last = report.scope.toObservedAt === undefined ? Infinity : Date.parse(report.scope.toObservedAt);
  let undatedCount = 0;
  for (const route of report.routes) {
    const host = route.scope.host ?? "unknown";
    const session = JSON.stringify([host, route.scope.machineId, route.scope.sourceId, route.scope.sessionId ?? `segment:${route.scope.segmentId}`]);
    for (const step of route.steps) {
      if (step.kind !== "observations") continue;
      for (const item of step.items) {
        const evidence = item.evidence;
        let measure: Exclude<MetricMeasure, "uses">;
        let name: string;
        let model: ModelRef = null;
        let attribution: MetricSeries["attribution"] = "none";
        switch (evidence.kind) {
          case "read-result": measure = evidence.outcome === "success" ? "successfulReads" : "failedReads"; name = evidence.skill.name; model = evidence.model; attribution = model === null ? "unknown" : "known"; break;
          case "skill-invocation": measure = evidence.outcome === "success" ? "invocations" : "invocationFailures"; name = evidence.skill.name; model = evidence.model; attribution = model === null ? "unknown" : "known"; break;
          case "read-attempt": measure = "readAttempts"; name = evidence.skill.name; model = evidence.model; attribution = model === null ? "unknown" : "known"; break;
          case "command-intent": measure = "requests"; name = evidence.skillName; break;
          case "wrapper-observed": measure = "wrappers"; name = evidence.skill.name; break;
          default: { const exhaustive: never = evidence; return exhaustive; }
        }
        const use = measure === "successfulReads" || measure === "invocations" || measure === "readAttempts";
        const selected = presentation.measure === measure || (presentation.measure === "uses" && use);
        const targeted = presentation.display === "session-share" ? use : selected;
        const modelLabel = attribution === "none" ? "No model attribution" : model === null ? "Unknown model" : `${model.provider} / ${model.id}`;
        const modelKey = JSON.stringify([attribution, model?.provider ?? null, model?.id ?? null]);
        const key = presentation.split === "skill" ? JSON.stringify(["skill", name]) : presentation.split === "agent" ? JSON.stringify(["agent", host]) : presentation.split === "model" ? modelKey : JSON.stringify(["agent-model", host, modelKey]);
        const cohort = cohorts.get(key) ?? { ...tally(), key, label: presentation.split === "skill" ? name : presentation.split === "agent" ? host : presentation.split === "model" ? modelLabel : `${host} · ${modelLabel}`, host: presentation.split === "agent" || presentation.split === "agent-model" ? host : null, model: presentation.split === "model" || presentation.split === "agent-model" ? model : null, attribution: presentation.split === "model" || presentation.split === "agent-model" ? attribution : "none" };
        const skill = skills.get(name) ?? { ...tally(), name, skillKeys: new Set<string>(), cells: new Map<string, Tally>() };
        const cell = skill.cells.get(key) ?? tally();
        totals[measure] += 1;
        if (use) { totals.uses += 1; sessions.add(session); }
        for (const target of [cohort, skill, cell]) {
          target.counts[measure] += 1;
          if (use) { target.counts.uses += 1; target.sessions.add(session); }
          if (targeted) target.routes.add(route.key);
        }
        skill.skillKeys.add(item.skillKey);
        skill.cells.set(key, cell); skills.set(name, skill); cohorts.set(key, cohort);
        const parsedTime = Date.parse(item.observedAt);
        const time = Number.isFinite(parsedTime) && Number.isFinite(new Date(Math.floor(parsedTime / 86_400_000) * 86_400_000 + 86_400_000).getTime()) ? parsedTime : null;
        let rowTimeline: ReturnType<typeof rowTimelines.get>;
        if (selected && projectedNames.has(name) && (projectedCohorts.size === 0 || projectedCohorts.has(key))) {
          const cohortKey = projectedCohorts.size === 0 ? null : key;
          const rowKey = JSON.stringify([name, cohortKey]);
          rowTimeline = rowTimelines.get(rowKey) ?? { name, cohortKey, count: 0, undatedCount: 0, values: timeline.map(() => 0) };
          rowTimeline.count += 1;
          if (time === null) rowTimeline.undatedCount += 1;
          rowTimelines.set(rowKey, rowTimeline);
        }
        if (selected && time === null) undatedCount += 1;
        if (!selected || time === null || time < first || time > last || activity.kind !== "bucketed") continue;
        const index = Math.floor((time - Date.parse(activity.startAt)) / activity.binWidthMs);
        const bin = timeline[index];
        if (bin === undefined || time >= Date.parse(bin.endAt)) continue;
        bin.count += 1; bin.values.set(key, (bin.values.get(key) ?? 0) + 1);
        if (rowTimeline) rowTimeline.values[index] = (rowTimeline.values[index] ?? 0) + 1;
      }
    }
  }
  const ordered = [...cohorts.values()].filter(cohort => presentation.display === "session-share" ? cohort.sessions.size > 0 : cohort.counts[presentation.measure] > 0)
    .sort((left, right) => right.counts[presentation.measure] - left.counts[presentation.measure] || left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
  const value = (entry: Tally, eligible: number) => ({ count: entry.counts[presentation.measure], counts: entry.counts, sessions: entry.sessions.size, eligibleSessions: eligible, share: eligible === 0 ? null : entry.sessions.size / eligible, routeKeys: [...entry.routes].sort() });
  return {
    presentation, totals, undatedCount,
    series: ordered.map(cohort => ({ key: cohort.key, label: cohort.label, host: cohort.host, model: cohort.model, attribution: cohort.attribution, ...value(cohort, cohort.sessions.size) })),
    timeline: timeline.map(bin => ({ startAt: bin.startAt, endAt: bin.endAt, count: bin.count, values: ordered.map(cohort => ({ key: cohort.key, count: bin.values.get(cohort.key) ?? 0 })) })),
    rowTimelines: [...rowTimelines.values()].map(row => ({ ...row, datedCount: row.values.reduce((sum, value) => sum + value, 0) })),
    skills: [...skills.values()].map(skill => ({ name: skill.name, ...value(skill, sessions.size), skillKeys: [...skill.skillKeys].sort(), cells: ordered.map(cohort => ({ key: cohort.key, ...value(skill.cells.get(cohort.key) ?? tally(), cohort.sessions.size) })) }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
  };
}
