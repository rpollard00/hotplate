const models = [
  { provider: "openai", id: "gpt-6-astra" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "anthropic", id: "claude-opus-4.6" },
];
const projects = ["/preview/hotplate", "/preview/pi-subagents", "/preview/skills"];
const hosts = ["pi", "pi", "pi", "claude-code", "codex", "opencode-v2"];
const routes = [
  [["mako"], ["how"], ["architect"], ["typescript-best-practices", "codebase-design"], ["writing"], ["deslop"]],
  [["mako"], ["how"], ["bug-fix"], ["typescript-best-practices"], ["deslop"]],
  [["mako"], ["grill-me"], ["domain-modeling"], ["writing"]],
  [["writing"], ["simple-technical-english", "unslop"]],
  [["mako"], ["how"], ["architect"], ["codebase-design"], ["interrogate"], ["deslop"]],
  [["how"], ["typescript-best-practices"], ["writing"]],
];

function skill(name) {
  return { name, canonicalPath: `/preview/skills/${encodeURIComponent(name)}/SKILL.md`, version: "synthetic-v1" };
}

export function dashboardFixture({ now = new Date() } = {}) {
  const end = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  if (!Number.isFinite(end)) throw new Error("Preview requires a valid date");
  const catalog = [...new Set(routes.flat(2)), "perf-issue", "refine-ui", "runtime-forensics", "<script>synthetic</script>"];
  const observations = [];
  let sequence = 0;
  for (let day = 20; day >= 0; day -= 1) {
    const sessions = 6 + ((20 - day) % 6);
    for (let index = 0; index < sessions; index += 1) {
      const serial = (20 - day) * 12 + index;
      const model = models[serial % models.length];
      const projectCwd = projects[Math.floor(serial / models.length) % projects.length];
      const sessionId = `preview-session-${String(serial + 1).padStart(3, "0")}`;
      const startedAt = end - day * 86_400_000 - 3 * 3_600_000 + index * 15 * 60_000;
      const route = routes[(serial + Math.floor(serial / 5)) % routes.length];
      const host = hosts[serial % hosts.length];
      const native = host !== "pi";
      const add = (evidence, turn, seconds = 0) => {
        sequence += 1;
        observations.push({
          ...(host === "pi" && day >= 18 ? {} : { host }),
          id: `preview-${sequence}`, producerId: "hotplate-synthetic-preview", sequence,
          observedAt: new Date(startedAt + turn * 60_000 + seconds * 1000).toISOString(),
          scope: {
            projectCwd, sessionId, sessionFile: null, segmentId: native ? sessionId : `${sessionId}-segment`, segmentReason: "startup",
            runId: host === "codex" ? `turn-${turn}` : native ? null : `${sessionId}-run`, turnId: `turn-${turn}`, leafId: `leaf-${turn}`,
          },
          evidence,
        });
      };
      if (!native) add({ kind: "catalog-snapshot", skills: catalog.map(skill) }, 0);
      if (!native && serial % 3 === 0) {
        const name = route[0][0];
        add({ kind: "command-intent", skillName: name, source: serial % 2 === 0 ? "interactive" : "rpc" }, 0, 1);
        add({ kind: "wrapper-observed", skill: skill(name), wrapperSource: "expanded-prompt" }, 0, 2);
      }
      route.forEach((names, turn) => {
        names.forEach((name, item) => {
          const toolCallId = `tool-${sequence + 1}`;
          const outcome = serial % 17 === 0 && turn === 2 ? "error" : "success";
          const invoked = (host === "claude-code" && item === 0) || (host === "opencode-v2" && turn === 0 && item === 0);
          const evidence = host === "codex" ? { kind: "read-attempt", skill: skill(name), toolCallId, model: null }
            : invoked ? { kind: "skill-invocation", skill: { name, canonicalPath: null, version: null }, toolCallId, outcome, model: host === "claude-code" ? null : model }
            : { kind: "read-result", skill: skill(name), toolCallId, outcome, model: host === "claude-code" || serial % 29 === 0 ? null : model };
          add(evidence, turn + 1, item * 4);
        });
        if (!native && serial % 23 === 0 && turn === 2) add({ kind: "capture-gap", dropped: 2, reason: "queue-overflow" }, turn + 1, 20);
      });
    }
  }
  return observations;
}
