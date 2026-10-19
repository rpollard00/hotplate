import type { ChainObservation, HostId, SkillChainRun, SkillChainView } from "../domain.js";

export const AGENT_HOST_ORDER: readonly HostId[] = ["pi", "claude-code", "codex", "opencode-v1", "opencode-v2", "unknown"];

export type SkillUseCounts = Readonly<{ reads: number; invocations: number; attempts: number; failures: number }>;
export type AgentSummary = Readonly<{
  host: HostId;
  uses: SkillUseCounts;
  sessions: number;
  skills: number;
  lastUseAt: string | null;
}>;
export type AgentSkillCell = Readonly<{ host: HostId; uses: SkillUseCounts; sessions: number }>;
export type AgentSkillRow = Readonly<{ name: string; uses: number; cells: readonly AgentSkillCell[] }>;
export type AgentComparison = Readonly<{ hosts: readonly AgentSummary[]; skills: readonly AgentSkillRow[] }>;

type UseKind = keyof SkillUseCounts;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Tally = { uses: Mutable<SkillUseCounts>; sessions: Set<string> };
type HostTally = Tally & { skills: Set<string>; lastUseAt: number | null };

export function skillUseKind(evidence: ChainObservation["evidence"]): UseKind | null {
  return skillUse(evidence)?.kind ?? null;
}

export function compareAgentHosts(left: HostId, right: HostId): number {
  const rank = (host: HostId) => {
    const index = AGENT_HOST_ORDER.indexOf(host);
    return index === -1 ? AGENT_HOST_ORDER.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

export function isSkillUse(kind: UseKind | null): kind is Exclude<UseKind, "failures"> {
  return kind !== null && kind !== "failures";
}

export function buildAgentComparison(chains: SkillChainView): AgentComparison {
  const hosts = new Map<HostId, HostTally>();
  const skills = new Map<string, Map<HostId, Tally>>();
  for (const run of chains.runs) {
    const host = run.host ?? "unknown";
    const session = agentSessionKey(run);
    for (const step of run.steps) {
      if (step.kind !== "observations") continue;
      for (const item of step.items) {
        const use = skillUse(item.evidence);
        if (use === null) continue;
        const hostTally = hosts.get(host) ?? { uses: emptyUses(), sessions: new Set(), skills: new Set(), lastUseAt: null };
        const cells = skills.get(use.name) ?? new Map<HostId, Tally>();
        const cell = cells.get(host) ?? { uses: emptyUses(), sessions: new Set() };
        hostTally.uses[use.kind] += 1;
        cell.uses[use.kind] += 1;
        if (isSkillUse(use.kind)) {
          hostTally.sessions.add(session);
          hostTally.skills.add(use.name);
          cell.sessions.add(session);
          const time = Date.parse(item.observedAt);
          if (Number.isFinite(time)) hostTally.lastUseAt = Math.max(hostTally.lastUseAt ?? time, time);
        }
        hosts.set(host, hostTally);
        cells.set(host, cell);
        skills.set(use.name, cells);
      }
    }
  }
  return {
    hosts: [...hosts].sort(([left], [right]) => compareAgentHosts(left, right)).map(([host, tally]) => ({
      host, uses: tally.uses, sessions: tally.sessions.size, skills: tally.skills.size,
      lastUseAt: tally.lastUseAt === null ? null : new Date(tally.lastUseAt).toISOString(),
    })),
    skills: [...skills].map(([name, cells]): AgentSkillRow => ({
      name,
      uses: [...cells.values()].reduce((total, cell) => total + totalUses(cell.uses), 0),
      cells: [...cells].sort(([left], [right]) => compareAgentHosts(left, right))
        .map(([host, cell]) => ({ host, uses: cell.uses, sessions: cell.sessions.size })),
    })).sort((left, right) => right.uses - left.uses || left.name.localeCompare(right.name)),
  };
}

function skillUse(evidence: ChainObservation["evidence"]): Readonly<{ kind: UseKind; name: string }> | null {
  switch (evidence.kind) {
    case "read-result": return { kind: evidence.outcome === "success" ? "reads" : "failures", name: evidence.skill.name };
    case "skill-invocation": return { kind: evidence.outcome === "success" ? "invocations" : "failures", name: evidence.skill.name };
    case "read-attempt": return { kind: "attempts", name: evidence.skill.name };
    case "command-intent":
    case "wrapper-observed": return null;
    default: {
      const exhaustive: never = evidence;
      return exhaustive;
    }
  }
}

function agentSessionKey(run: SkillChainRun): string {
  return JSON.stringify([run.host ?? "unknown", run.machineId, run.sourceId, run.sessionId ?? `segment:${run.segmentId}`]);
}

function emptyUses(): Mutable<SkillUseCounts> {
  return { reads: 0, invocations: 0, attempts: 0, failures: 0 };
}

function totalUses(uses: SkillUseCounts): number {
  return uses.reads + uses.invocations + uses.attempts;
}
