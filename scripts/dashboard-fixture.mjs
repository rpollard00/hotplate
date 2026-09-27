const models = [
  { provider: "openai", id: "gpt-6-astra" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "anthropic", id: "claude-opus-4.6" },
];
const projects = ["/preview/hotplate", "/preview/pi-subagents", "/preview/skills"];
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
    const sessions = 3 + ((20 - day) % 6);
    for (let index = 0; index < sessions; index += 1) {
      const serial = (20 - day) * 8 + index;
      const model = models[serial % models.length];
      const projectCwd = projects[Math.floor(serial / models.length) % projects.length];
      const sessionId = `preview-session-${String(serial + 1).padStart(3, "0")}`;
      const startedAt = end - day * 86_400_000 - 3 * 3_600_000 + index * 15 * 60_000;
      const route = routes[(serial + Math.floor(serial / 5)) % routes.length];
      const add = (evidence, turn, seconds = 0) => {
        sequence += 1;
        observations.push({
          id: `preview-${sequence}`, producerId: "hotplate-synthetic-preview", sequence,
          observedAt: new Date(startedAt + turn * 60_000 + seconds * 1000).toISOString(),
          scope: {
            projectCwd, sessionId, sessionFile: null, segmentId: `${sessionId}-segment`,
            segmentReason: "startup", runId: `${sessionId}-run`, turnId: `turn-${turn}`, leafId: `leaf-${turn}`,
          },
          evidence,
        });
      };
      add({ kind: "catalog-snapshot", skills: catalog.map(skill) }, 0);
      if (serial % 3 === 0) {
        const name = route[0][0];
        add({ kind: "command-intent", skillName: name, source: serial % 2 === 0 ? "interactive" : "rpc" }, 0, 1);
        add({ kind: "wrapper-observed", skill: skill(name), wrapperSource: "expanded-prompt" }, 0, 2);
      }
      route.forEach((names, turn) => {
        names.forEach((name, item) => {
          add({
            kind: "read-result", skill: skill(name), toolCallId: `tool-${sequence + 1}`,
            outcome: serial % 17 === 0 && turn === 2 ? "error" : "success",
            model: serial % 29 === 0 ? null : model,
          }, turn + 1, item * 4);
        });
        if (serial % 23 === 0 && turn === 2) add({ kind: "capture-gap", dropped: 2, reason: "queue-overflow" }, turn + 1, 20);
      });
    }
  }
  return observations;
}
