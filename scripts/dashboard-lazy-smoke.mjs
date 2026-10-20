import assert from "node:assert/strict";
import { withBrowser } from "./browser-smoke.mjs";
import { startDashboardPreview } from "./dashboard-preview.mjs";
import { openHotplateStore } from "../dist/src/store.js";

const preview = await startDashboardPreview();
try {
  const store = openHotplateStore({ databasePath: preview.databasePath });
  try {
    const now = new Date().toISOString();
    const observations = ["reference", "skill"].map((kind, index) => ({
      id: `lazy-${index}`, producerId: "lazy-smoke", sequence: index, observedAt: now, host: "codex",
      scope: { projectCwd: "/synthetic/project", sessionId: "lazy", sessionFile: null, segmentId: "lazy", segmentReason: "startup", runId: null, turnId: null, leafId: null },
      evidence: { kind: "resource-access", resource: { filesystemId: "synthetic", canonicalPath: `/synthetic/skills/${kind}.md`, observedPath: `/synthetic/skills/${kind}.md`, rootPath: "/synthetic/skills", kind, ownerSkillPath: null }, operationId: `lazy-${index}`, mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session" },
    }));
    assert.equal((await store.record(observations)).accepted, 2);
  } finally { await store.close(); }
  const payload = await fetch(new URL("/api/dashboard", preview.url)).then(response => response.json());
  const resourceCount = payload.resources.rows.length;
  const referenceCount = payload.resources.rows.filter(row => row.resource.kind === "reference").length;
  await withBrowser(async ({ command, evaluate, until, errors }) => {
    const ready = 'document.getElementById("status-text").textContent === "Ready"';
    const resourcesReady = ready + ' && !document.getElementById("resources-workspace").hidden';
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const change = (id, value, event = "change") => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)}));`);
    const scopes = () => evaluate('window.dashboardRequests.map(value => new URL(value, location.href).searchParams.get("scope"))');
    const rowCount = () => evaluate('document.querySelectorAll("#resource-table tbody tr").length');
    await command("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.dashboardRequests = [];
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        if (String(input).startsWith('/api/dashboard')) window.dashboardRequests.push(String(input));
        return originalFetch(input, init);
      };
    ` });
    await command("Page.navigate", { url: preview.url }); await until(ready);
    assert.deepEqual(await scopes(), ["skills"], "Startup requests only the skills dashboard scope");
    assert.equal(await rowCount(), 0, "Startup does not render hidden Resources");
    await click('[data-workspace="paths"]'); await click('[data-workspace="metrics"]');
    assert.deepEqual(await scopes(), ["skills"], "Skill workspace navigation does not request Resources");
    await evaluate('window.originalNow = Date.now; Date.now = () => window.originalNow() + 60000');
    await click('[data-workspace="resources"]'); await until(resourcesReady);
    await evaluate('Date.now = window.originalNow');
    assert.deepEqual(await scopes(), ["skills", "resources"]);
    const initialParams = await evaluate('window.dashboardRequests.map(value => { const params = new URL(value, location.href).searchParams; params.delete("scope"); return params.toString(); })');
    assert.equal(initialParams[0], initialParams[1], "Lazy Resources retains the exact original date selection");
    assert.equal(await rowCount(), resourceCount);
    await change("resource-kind", "reference");
    await click("#resource-table summary");
    await click('[data-workspace="metrics"]'); await click('[data-workspace="resources"]');
    assert.equal(await rowCount(), referenceCount);
    assert.equal(await evaluate('document.getElementById("resource-kind").value'), "reference");
    assert.equal(await evaluate('document.querySelector("#resource-table details").open'), true, "Tab returns retain local DOM state");
    assert.deepEqual(await scopes(), ["skills", "resources"], "Local filters and tab returns do not fetch");
    await change("time-preset", "all"); await until(resourcesReady);
    assert.deepEqual(await scopes(), ["skills", "resources", "skills", "resources"], "A global slicer reloads both scopes on Resources");
    assert.equal(await evaluate('document.getElementById("resource-kind").value'), "");
    await change("metric-content", "skills");

    await evaluate(`window.pendingDashboardRequests = []; window.fetch = (input, init) => new Promise((resolve, reject) => {
      window.pendingDashboardRequests.push({ url: String(input), signal: init.signal, resolve, reject });
    });`);
    const queued = () => evaluate('window.pendingDashboardRequests.length');
    const waitQueued = count => until(`window.pendingDashboardRequests.length === ${count}`);
    const respond = (index, body = payload, status = 200) => evaluate(`(async () => {
      window.pendingDashboardRequests[${index}].resolve(new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} }));
      await new Promise(resolve => setTimeout(resolve, 0));
    })()`);
    const refreshResources = async (action = '#refresh-data') => {
      const index = await queued();
      await click(action); await waitQueued(index + 1); await respond(index); await waitQueued(index + 2);
      assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Loading", "Skills completion cannot mark pending Resources ready");
      assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "true");
      return index + 1;
    };

    let pending = await refreshResources();
    await click('[data-workspace="resources"]'); await click('[data-workspace="resources"]');
    assert.equal(await queued(), pending + 1, "Repeated Resource clicks share one pending request");
    await click('[data-workspace="metrics"]'); await until(ready);
    await respond(pending); assert.equal(await rowCount(), resourceCount);
    assert.equal(await evaluate('document.getElementById("resources-workspace").hidden'), true);
    assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "false");
    await click('[data-workspace="resources"]'); await until(resourcesReady);
    assert.equal(await queued(), pending + 1, "A completed inactive response stays available on return");

    for (const failure of ["network", "http", "missing", "scope", "invalid"]) {
      pending = await refreshResources(failure === "network" ? '#refresh-data' : '#message-panel button');
      await click('[data-workspace="metrics"]'); await until(ready);
      if (failure === "network") await evaluate(`(async () => {
        window.pendingDashboardRequests[${pending}].reject(new TypeError('Failed to fetch'));
        await new Promise(resolve => setTimeout(resolve, 0));
      })()`);
      else if (failure === "http") await respond(pending, {}, 401);
      else if (failure === "missing") await respond(pending, { kind: "missing", databasePath: "/synthetic/missing.sqlite", filterOptions: payload.filterOptions });
      else if (failure === "scope") await respond(pending, { ...payload, scope: "skills" });
      else await respond(pending, { kind: "ready", scope: "resources", filterOptions: payload.filterOptions });
      assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Ready", "An inactive resource error cannot replace Metrics");
      assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), false);
      assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "false");
      await click('[data-workspace="resources"]');
      assert.equal(await evaluate('document.getElementById("status-text").textContent'), failure === "missing" ? "No database" : "Error");
      assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true);
      assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "false");
      if (failure === "network") assert.match(await evaluate('document.getElementById("message-panel").textContent'), /Could not reach the dashboard server/);
      assert.equal(await queued(), pending + 1, "A cached error waits for explicit Retry");
    }

    await click('[data-workspace="metrics"]'); await until(ready);
    const oldSkills = await queued(); await click('#refresh-data'); await waitQueued(oldSkills + 1);
    await change("host-filter", "codex"); await waitQueued(oldSkills + 2);
    const currentPayload = { ...payload, report: { ...payload.report, scope: { host: "codex" } } };
    await respond(oldSkills + 1, currentPayload); await until(ready);
    await respond(oldSkills, payload);
    assert.match(await evaluate('document.getElementById("scope-summary").textContent'), /Agent host: Codex/, "An older skill response cannot replace the new selection");
    assert.equal(await evaluate(`window.pendingDashboardRequests[${oldSkills}].signal.aborted`), true);
    const oldResources = await queued();
    await click('[data-workspace="resources"]'); await waitQueued(oldResources + 1);
    await click('#refresh-data'); await waitQueued(oldResources + 2);
    await respond(oldResources + 1, currentPayload); await waitQueued(oldResources + 3);
    const oneResource = { ...currentPayload, resources: { rows: payload.resources.rows.slice(0, 1) } };
    await respond(oldResources + 2, oneResource); await until(resourcesReady);
    assert.equal(await rowCount(), 1);
    await respond(oldResources, payload);
    assert.equal(await rowCount(), 1, "An older resource response cannot replace current rows");
    assert.equal(await evaluate(`window.pendingDashboardRequests[${oldResources}].signal.aborted`), true);

    await click('[data-workspace="metrics"]');
    for (const badSkills of [{ ...payload, scope: "resources" }, { kind: "ready", scope: "skills", filterOptions: payload.filterOptions }]) {
      const index = await queued(); await click('#refresh-data'); await waitQueued(index + 1); await respond(index, badSkills);
      await until('document.getElementById("status-text").textContent === "Error"');
      assert.equal(await queued(), index + 1, "An invalid skill response cannot trigger Resources");
    }
    assert.deepEqual(errors, [], "No runtime or CSP errors during lazy loading");
  });
  process.stdout.write("Lazy dashboard browser smoke passed: scoped requests, frozen dates, local state, retries, inactive errors, and stale responses.\n");
} finally { await preview.close(); }
