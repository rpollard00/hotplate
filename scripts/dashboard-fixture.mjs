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
  const location = (path, ownerSkillPath = null, kind = "reference") => ({
    filesystemId: "preview:skills", canonicalPath: path, observedPath: path,
    rootPath: "/preview/skills", kind, ownerSkillPath,
  });
  const mirror = observations.findLast(record => record.evidence.kind === "read-result" && record.evidence.skill.name === "mako");
  if (mirror) observations.push({ ...mirror, id: "preview-resource-mirror", sequence: ++sequence,
    evidence: { kind: "resource-access", resource: location(mirror.evidence.skill.canonicalPath, mirror.evidence.skill.canonicalPath, "skill"),
      operationId: mirror.evidence.toolCallId, mechanism: "host-tool", access: "read", outcome: mirror.evidence.outcome,
      model: mirror.evidence.model, process: null, attribution: "session" } });
  const resource = (name, offset, file, access = "read", outcome = "success", model = models[2], attribution = "session") => {
    observations.push({ id: "preview-resource-" + name, producerId: "hotplate-synthetic-preview", sequence: ++sequence,
      host: "claude-code", observedAt: new Date(end - 3_600_000 + offset * 60_000).toISOString(),
      scope: { projectCwd: projects[0], sessionId: "preview-resource-session", sessionFile: null,
        segmentId: "preview-resource-session", segmentReason: "startup", runId: null, turnId: "resource-turn", leafId: null },
      evidence: { kind: "resource-access", resource: file, operationId: "preview-resource-" + name,
        mechanism: access === "open" || access === "access" ? "fanotify" : "host-tool", access, outcome,
        model, process: null, attribution } });
  };
  const owner = "/preview/skills/mako/SKILL.md";
  resource("playbook", 10, location("/preview/skills/mako/playbooks/feature.md", owner));
  resource("repeat", 20, location("/preview/skills/mako/playbooks/feature.md", owner));
  resource("failure", 30, location("/preview/skills/mako/references/unavailable.md", owner), "read", "error");
  resource("attempt", 40, location("/preview/skills/mako/references/execution.md", owner), "attempt", "unknown", null);
  resource("support-only", 50, location("/preview/skills/owner-with-only-supporting-activity/references/a-long-reference-name-for-responsive-layout-verification.md", "/preview/skills/owner-with-only-supporting-activity/SKILL.md"));
  resource("unowned", 55, location("/preview/skills/shared/standalone-reference.md"));
  resource("other-entrypoint", 56, location("/preview/skills/second-owner/SKILL.md", "/preview/skills/second-owner/SKILL.md", "skill"));
  resource("open", 58, location(owner, owner, "skill"), "open", "unknown", null, "harness");
  resource("latest", 59, location("/preview/skills/mako/references/execution.md", owner), "access", "unknown", null, "harness");
  resource("unattributed", 57, location("/preview/skills/shared/unknown-access.md"), "access", "unknown", null, "unknown");
  return observations;
}

export function toolActivityFixture({ now = new Date(), filesystemEvents = 400 } = {}) {
  const end = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  if (!Number.isFinite(end)) throw new Error("Preview requires a valid date");
  const rootPath = "/preview/skills";
  const filesystemId = "preview:tool-activity";
  const observations = [];
  const scope = { projectCwd: "/preview/hotplate", sessionId: "tool-activity-session", sessionFile: null,
    segmentId: "tool-activity-session", segmentReason: "startup", runId: null, turnId: "tool-activity-turn", leafId: null };
  const add = (id, evidence, host = "claude-code", offset = 0) => observations.push({
    id, producerId: "tool-activity-preview", sequence: observations.length, host,
    observedAt: new Date(end - 3_600_000 + offset * 60_000).toISOString(), scope, evidence,
  });
  const location = (path, owner = "/preview/skills/review/SKILL.md") => ({
    filesystemId, canonicalPath: path, observedPath: path, rootPath, kind: path.endsWith("/SKILL.md") ? "skill" : "reference", ownerSkillPath: owner,
  });
  const metadata = (kind, requested = { kind: "whole" }, delivery = { kind: "unknown" }) => ({
    kind, requested, delivery, revision: { kind: "unknown" },
  });
  const resource = (id, file, access, outcome, toolRead, host = "claude-code", offset = 0) => {
    add(id, { kind: "resource-access", resource: file, operationId: id, mechanism: "host-tool", access, outcome,
      model: host === "codex" ? null : models[2], process: null, attribution: "session", toolRead }, host, offset);
    add(id + "-coverage", { kind: "tool-coverage", operationId: id, family: toolRead.kind === "literal-command" ? "shell" : "file",
      outcome, model: host === "codex" ? null : models[2], recognition: { kind: "recognized", resourceCount: 1 } }, host, offset);
  };
  resource("entrypoint", location("/preview/skills/review/SKILL.md"), "read", "success", metadata("structured-read"), "claude-code", 1);
  add("legacy-entrypoint", { kind: "read-result", skill: { name: "review", canonicalPath: "/preview/skills/review/SKILL.md", version: null },
    toolCallId: "entrypoint", outcome: "success", model: models[2] }, "claude-code", 1);
  resource("partial", location("/preview/skills/review/references/partial.md"), "read", "success",
    metadata("structured-read", { kind: "lines", start: 10, count: 20 }, { kind: "known", returned: { kind: "lines", start: 10, count: 5 }, truncated: true }), "claude-code", 10);
  resource("inferred", location("/preview/skills/reference-only/references/usage.md", "/preview/skills/reference-only/SKILL.md"),
    "inferred-read", "success", metadata("literal-command"), "opencode-v2", 20);
  resource("attempt", location("/preview/skills/review/references/unknown.md"), "attempt", "unknown", metadata("literal-command"), "codex", 30);
  resource("failed", location("/preview/skills/review/references/unavailable.md"), "read", "error", metadata("structured-read"), "claude-code", 40);
  add("invocation", { kind: "skill-invocation", skill: { name: "native-skill", canonicalPath: null, version: null },
    toolCallId: "invocation", outcome: "success", model: models[2] }, "claude-code", 45);
  add("opaque", { kind: "tool-coverage", operationId: "opaque", family: "python", outcome: "success", model: models[2],
    recognition: { kind: "opaque", reason: "unsupported-syntax" } }, "claude-code", 50);
  for (let index = 0; index < filesystemEvents; index++) {
    add(`poll-${index}`, { kind: "resource-access", resource: location("/preview/skills/catalog-polling/SKILL.md", "/preview/skills/catalog-polling/SKILL.md"),
      operationId: `poll-${index}`, mechanism: "fanotify", access: index % 2 ? "access" : "open", outcome: "unknown",
      model: null, process: null, attribution: "harness" }, "pi", 59);
  }
  return observations;
}
