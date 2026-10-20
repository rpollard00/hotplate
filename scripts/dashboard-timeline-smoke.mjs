import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectMetrics } from "../dist/src/dashboard/metrics.js";
import { openHotplateStore } from "../dist/src/store.js";
import { withBrowser } from "./browser-smoke.mjs";
import { startDashboardPreview } from "./dashboard-preview.mjs";

const legacyBackend = process.argv.includes("--legacy-backend");
const directory = process.env.HOTPLATE_SCREENSHOT_DIR ? resolve(process.env.HOTPLATE_SCREENSHOT_DIR) : await mkdtemp(join(tmpdir(), "hotplate-timeline-smoke-"));
await mkdir(directory, { recursive: true });
const preview = await startDashboardPreview({ now: new Date("2025-02-21T12:00:00Z"), port: Number(process.env.HOTPLATE_PREVIEW_PORT || 0) });
const empty = await startDashboardPreview({ scenario: "empty" });
const missing = await startDashboardPreview({ scenario: "missing" });
const evidence = { legacyBackend, screenshots: [], skills: [], content: [], runtimeErrors: [] };
const resourceObservation = (index, observedAt = "2025-02-21T10:30:00.000Z") => ({
  id: randomUUID(), producerId: "timeline-browser-fixture", sequence: index, host: "codex", observedAt,
  scope: { projectCwd: "/preview/project", sessionId: "timeline-browser-session", sessionFile: null, segmentId: "timeline-browser-segment", segmentReason: "startup", runId: null, turnId: null, leafId: null },
  evidence: { kind: "resource-access", mechanism: "host-tool", access: "read", outcome: "success", operationId: "timeline-read-" + index, model: { provider: "timeline-test", id: "model-" + index % 8 }, process: null, attribution: "session",
    resource: { filesystemId: "preview-filesystem", canonicalPath: "/preview/skills/many-files/references/file-" + index + ".md", observedPath: "/preview/skills/many-files/references/file-" + index + ".md", rootPath: "/preview/skills", ownerSkillPath: "/preview/skills/many-files/SKILL.md", kind: "reference" } },
});
try {
  const store = openHotplateStore({ databasePath: preview.databasePath });
  try {
    const result = await store.record(Array.from({ length: 50 }, (_, index) => resourceObservation(index)));
    assert.equal(result.dropped, 0);
  } finally { await store.close(); }
  await withBrowser(async ({ command, evaluate, until, screenshot, errors }) => {
    await command("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.timelineRequests = [];
      window.contentRequests = [];
      window.runtimeErrors = [];
      window.addEventListener('error', event => window.runtimeErrors.push(event.error?.stack || event.message));
      window.timelineFault = '';
      const originalFetch = window.fetch;
      window.fetch = async (input, options) => {
        const url = new URL(input, location.href);
        if (url.pathname === '/api/content-analytics') window.contentRequests.push(url.href);
        if (url.pathname !== '/api/content-timelines') return originalFetch(input, options);
        window.timelineRequests.push(url.href);
        if (window.timelineFault === 'error') return new Response(JSON.stringify({kind:'error',message:'Synthetic timeline failure'}));
        const response = await originalFetch(input, options);
        if (window.timelineFault === 'delay') {
          window.timelineFault = '';
          return new Promise(resolve => { window.releaseTimeline = () => resolve(response); });
        }
        return response;
      };
    ` });
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    const change = (id, value) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('change',{bubbles:true}));}`);
    const input = (value) => evaluate(`{const input=document.getElementById('skill-search');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));}`);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const noOverflow = async () => assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth + 1'), false, "No document overflow");
    const capture = async name => {
      await evaluate('document.fonts.ready');
      await screenshot(join(directory, name + ".png")); evidence.screenshots.push(name + ".png");
    };
    const timelineReady = 'document.querySelectorAll("#skill-table .mini-timeline").length > 0 && !document.getElementById("skill-table").textContent.includes("Loading") && !document.getElementById("skill-table").textContent.includes("Unavailable")';
    const visibleTimelines = () => evaluate('Array.from(document.querySelectorAll("#skill-table [data-skill-name]"), row => ({name:row.dataset.skillName,values:Array.from(row.querySelectorAll(".mini-timeline"),button=>[Number(button.dataset.timelineCount),Number(button.dataset.timelineDated),Number(button.dataset.timelineUndated)])}))');
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url: preview.url }); await until(ready);
    await change("time-preset", "all"); await until(ready);
    assert.equal(await evaluate('document.getElementById("metric-display").disabled'), false);
    assert.equal(await evaluate('document.querySelectorAll("#skill-table .content-location, #skill-table .content-toggle").length'), 0);
    assert.doesNotMatch(await evaluate('document.getElementById("skill-table").textContent'), /\/preview\/skills|managed-|[a-f0-9]{8}-[a-f0-9]{4}-/);
    assert.equal(await evaluate('window.timelineRequests.length'), 0, "Count requests no row timelines");
    await capture("counts-desktop");
    await click("#skill-table .content-files");
    assert.equal(await evaluate('document.activeElement.classList.contains("content-files")'), true, "File disclosure retains keyboard focus");
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'), "true");
    assert.ok(await evaluate('document.querySelectorAll("#skill-table .content-child").length > 0'));
    await click("#skill-table .content-title");
    assert.equal(await evaluate('document.querySelector("#content-detail .content-diagnostics").open'), false);
    await click("#content-detail .content-diagnostics summary");
    assert.match(await evaluate('document.querySelector("#content-detail .content-diagnostics").textContent'), /File:|Machine:|Account source:/);
    await click("#content-detail .section-heading button");
    await input("references/execution.md");
    assert.ok(await evaluate('document.querySelectorAll("#skill-table .content-child").length > 0'));
    await input("");
    await change("metric-content", "skills");
    const payload = await fetch(new URL("/api/dashboard?scope=skills", preview.url)).then(response => response.json());
    assert.equal(payload.kind, "ready");
    for (const split of ["skill", "agent", "model", "agent-model"]) {
      await change("metric-split", split);
      await change("metric-display", "timeline"); await until(timelineReady);
      const actual = await visibleTimelines();
      const counts = projectMetrics(payload.report, { measure: "successfulReads", split, display: "timeline" });
      const cohorts = split === "skill" ? [] : counts.series.slice(0, 6);
      const projected = projectMetrics(payload.report, counts.presentation, { skillNames: actual.map(row => row.name), cohortKeys: cohorts.map(series => series.key) });
      assert.deepEqual(actual, actual.map(row => ({ name: row.name, values: (cohorts.length ? cohorts : [null]).map(cohort => {
        const value = projected.rowTimelines.find(value => value.name === row.name && value.cohortKey === (cohort?.key || null));
        return [value?.count || 0, value?.datedCount || 0, value?.undatedCount || 0];
      }) })), split + " Skills mini charts conserve the selected measure");
      evidence.skills.push({ split, rows: actual.length });
      assert.match(await evaluate('Array.from(document.querySelectorAll("#skill-table .mini-timeline")).find(button=>Number(button.dataset.timelineDated)>0).getAttribute("aria-label")'), /active interval.*peak.*UTC/);
      await noOverflow();
    }
    await change("metric-split", "skill"); await capture("skills-timeline-desktop");
    await evaluate('document.querySelector("#skill-table .mini-timeline").focus()');
    await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await command("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate('document.getElementById("skill-detail").hidden'), false, "Timeline opens matching evidence");
    await change("metric-measure", "requests"); await until(timelineReady);
    assert.equal(await evaluate('document.getElementById("metric-display").value'), "timeline", "Timeline survives measure changes");
    await change("metric-measure", "uses"); await change("metric-display", "session-share");
    assert.ok(await evaluate('document.querySelectorAll("#skill-table .rank-row").length > 0'), "Session shares remain available");
    await change("metric-display", "timeline");
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await noOverflow(); await capture("skills-timeline-mobile");
    await input("no-matching-skill");
    assert.equal(await evaluate('document.querySelectorAll("#skill-table .mini-timeline").length'), 0);
    assert.match(await evaluate('document.getElementById("skill-table").textContent'), /No skills match/);
    await input("");
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await change("metric-content", "both"); await until(ready);
    const countRequests = await evaluate("window.contentRequests.length");
    await evaluate("window.timelineFault='error'");
    await change("metric-display", "timeline");
    await until('document.getElementById("skill-table").textContent.includes("Timelines are unavailable.")');
    assert.equal(await evaluate("window.contentRequests.length"), countRequests, "Display changes do not reload content counts");
    assert.ok(await evaluate('Array.from(document.querySelectorAll("#skill-table .mini-value strong")).some(item=>Number(item.textContent)>0)'), "Timeline errors retain counts");
    await capture("timelines-error");
    await evaluate("window.timelineFault=''");
    if (legacyBackend) {
      await change("metric-display", "count");
      await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await noOverflow(); await capture("counts-mobile");
    } else {
      await click("#skill-table .content-status button"); await until(timelineReady);
      const initialAxis = await evaluate('document.querySelector("#skill-table .mini-axis").textContent');
      const countRequestsBeforeAxisChange = await evaluate("window.contentRequests.length");
      const lateWriter = openHotplateStore({ databasePath: preview.databasePath });
      try {
        assert.equal((await lateWriter.record([resourceObservation(50, "2025-02-22T10:30:00.000Z")])).dropped, 0);
      } finally { await lateWriter.close(); }
      await input("many-files");
      await until('document.getElementById("skill-table").textContent.includes("Timelines are unavailable.")');
      assert.equal(await evaluate("window.contentRequests.length"), countRequestsBeforeAxisChange, "A new event extends projection dates beyond the loaded count report");
      await evaluate('document.querySelector("#skill-table .content-status button").focus()');
      await click("#skill-table .content-status button"); await until(ready); await until(timelineReady);
      assert.equal(await evaluate("window.contentRequests.length"), countRequestsBeforeAxisChange + 1, "Retry refreshes the parent count report and its UTC axis");
      assert.equal(await evaluate('document.getElementById("skill-search").value'), "many-files", "Axis recovery preserves search");
      assert.notEqual(await evaluate('document.querySelector("#skill-table .mini-axis").textContent'), initialAxis);
      assert.equal(await evaluate('document.activeElement.id'), "skill-table", "Axis recovery retains focus in the comparison");
      const recovered = await fetch(await evaluate("window.timelineRequests.at(-1)")).then(response => response.json());
      assert.equal(recovered.kind, "ready");
      assert.equal(recovered.timelines.endAt, "2025-02-23T00:00:00.000Z");
      await input(""); await until(timelineReady);
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await click('#comparison-pagination button[aria-label="Next item rows"]');
      await until('typeof window.releaseTimeline === "function"');
      await evaluate("window.releaseTimeline()"); await until(timelineReady);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), "Next item rows", "Successful async projection preserves parent row-pagination focus");
      await click('#comparison-pagination button[aria-label="Previous item rows"]'); await until(timelineReady);
      await change("metric-split", "model"); await until(ready); await until(timelineReady);
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await click('#comparison-pagination button[aria-label="Next comparison columns"]');
      await until('typeof window.releaseTimeline === "function"');
      await evaluate("window.releaseTimeline()"); await until(timelineReady);
      assert.match(await evaluate('document.activeElement.getAttribute("aria-label")'), /comparison columns$/, "Successful async projection preserves cohort-pagination focus");
      assert.equal(await evaluate('document.activeElement.disabled'), false);
      await change("metric-split", "skill"); await until(ready); await until(timelineReady);
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await click("#skill-table .content-files");
      await until('typeof window.releaseTimeline === "function"');
      assert.equal(await evaluate('document.activeElement.classList.contains("content-files")'), true);
      await evaluate("window.releaseTimeline()"); await until(timelineReady);
      assert.equal(await evaluate('document.activeElement.classList.contains("content-files")'), true, "Successful async projection preserves file-disclosure focus");
      await click("#skill-table .content-files"); await until(timelineReady);
      await input("many-files"); await until(timelineReady);
      assert.equal(new URL(await evaluate("window.timelineRequests.at(-1)")).searchParams.getAll("rowKey").length, 24, "Expanded groups bound their projection to 24 visible rows");
      const firstFiles = await evaluate('Array.from(document.querySelectorAll("#skill-table .content-child"), row=>row.dataset.contentKey)');
      assert.equal(firstFiles.length, 23);
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await click('#skill-table .content-files-pagination button:last-child');
      await until('typeof window.releaseTimeline === "function"');
      await evaluate("window.releaseTimeline()"); await until(timelineReady);
      assert.ok(await evaluate('document.activeElement.textContent.includes("files")'), "File pagination retains keyboard focus");
      const nextFiles = await evaluate('Array.from(document.querySelectorAll("#skill-table .content-child"), row=>row.dataset.contentKey)');
      assert.equal(nextFiles.some(key => firstFiles.includes(key)), false, "File pagination exposes new physical rows");
      assert.ok(new URL(await evaluate("window.timelineRequests.at(-1)")).searchParams.getAll("rowKey").length <= 24);
      await input(""); await until(timelineReady);
      for (const content of ["both", "resources"]) {
        await change("metric-content", content); await until(ready);
        await change("metric-display", "timeline"); await until(timelineReady);
        for (const split of ["skill", "agent", "model", "agent-model"]) {
          await change("metric-split", split); await until(ready); await until(timelineReady);
          const url = await evaluate("window.timelineRequests.at(-1)"); const params = new URL(url).searchParams;
          assert.ok(params.getAll("rowKey").length <= 24);
          assert.ok(params.getAll("cohortKey").length <= 6);
          const result = await fetch(url).then(response => response.json()); assert.equal(result.kind, "ready");
          const actual = await evaluate('Array.from(document.querySelectorAll("#skill-table [data-content-key]"),row=>({key:row.dataset.contentKey,values:Array.from(row.querySelectorAll(".mini-timeline"),button=>[Number(button.dataset.timelineCount),Number(button.dataset.timelineDated),Number(button.dataset.timelineUndated)])}))');
          assert.deepEqual(actual, actual.map(row => ({ key: row.key, values: (params.getAll("cohortKey").length ? params.getAll("cohortKey") : [null]).map(cohort => {
            const value = result.timelines.rows.find(value => value.rowKey === row.key && value.cohortKey === cohort);
            return [value?.count || 0, value?.datedCount || 0, value?.undatedCount || 0];
          }) })), content + " / " + split + " renders exact projected row/cell counts");
          evidence.content.push({ content, split, rows: actual.length }); await noOverflow();
        }
        await change("metric-split", "skill"); await until(ready); await until(timelineReady);
        await capture(content + "-timeline-desktop");
        await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await noOverflow(); await capture(content + "-timeline-mobile");
        await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      }
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await input("file-1.md");
      await until('typeof window.releaseTimeline === "function"');
      await until('document.getElementById("skill-table").textContent.includes("Loading timelines")');
      await capture("timelines-loading");
      await input("file-2.md"); await until(timelineReady);
      const current = await evaluate('document.getElementById("skill-table").textContent');
      await evaluate("window.releaseTimeline()");
      assert.equal(await evaluate('document.getElementById("skill-table").textContent'), current, "A stale row projection cannot replace the current search");
      await input(""); await until(timelineReady);
      await evaluate("window.releaseTimeline=null;window.timelineFault='delay'");
      await input("file-1.md"); await until('typeof window.releaseTimeline === "function"');
      await evaluate('document.getElementById("skill-search").focus();window.releaseTimeline()'); await until(timelineReady);
      assert.equal(await evaluate('document.activeElement.id'), "skill-search", "Async projection never steals external focus");
      await input(""); await until(timelineReady);
      const activityToggle = await evaluate('Array.from(document.querySelectorAll("#activity-chart > details > summary")).find(summary=>summary.textContent.includes("activity data"))?.textContent');
      assert.ok(activityToggle);
      await click("#activity-chart > details:last-of-type > summary");
      await until('document.querySelectorAll("#activity-chart .activity-choice").length > 0');
      await evaluate('Array.from(document.querySelectorAll("#activity-chart .activity-choice")).find(button=>Number(button.closest("tr").lastChild.textContent)>0).click()'); await until(ready); await until(timelineReady);
      const brushed = new URL(await evaluate("window.timelineRequests.at(-1)"));
      assert.ok(brushed.searchParams.has("selectionFrom") && brushed.searchParams.has("selectionTo"), "Mini timelines retain the local UTC brush");
      const brushCount = await evaluate('Array.from(document.querySelectorAll("#skill-table .mini-timeline"),button=>Number(button.dataset.timelineCount)).reduce((sum,value)=>sum+value,0)');
      assert.ok(brushCount > 0, "Brushed timelines retain matching evidence");
      await evaluate('document.querySelector("#activity-chart .trend-plot").focus()');
      await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await until(ready); await until(timelineReady);
      const model = await evaluate('Array.from(document.getElementById("model-filter").options).find(option=>option.value&&option.value!=="unknown"&&!option.disabled)?.value');
      if (model) { await change("model-filter", model); await until(ready); await until(timelineReady); }
      const scoped = new URL(await evaluate("window.timelineRequests.at(-1)"));
      if (model) assert.equal(scoped.searchParams.get("model"), model);
      await change("metric-display", "count");
      await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await noOverflow(); await capture("counts-mobile");
    }
    for (const [url, expected] of [[empty.url, "No"], [missing.url, "No Hotplate database found"]]) {
      evidence.runtimeErrors.push(...await evaluate('window.runtimeErrors || []'));
      await command("Page.navigate", { url });
      await until(expected === "No" ? ready : 'document.getElementById("status-text")?.textContent === "No database"');
      assert.match(await evaluate('document.body.textContent'), new RegExp(expected));
      assert.equal(await evaluate('document.querySelectorAll("#skill-table .mini-timeline").length'), 0);
      await noOverflow();
    }
    evidence.runtimeErrors.push(...await evaluate('window.runtimeErrors || []'));
    assert.deepEqual(errors, [], "No runtime or CSP errors: " + JSON.stringify(evidence.runtimeErrors));
  });
  await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(`Timeline browser checks passed. Evidence: ${directory}\n`);
} finally {
  await Promise.all([preview.close(), empty.close(), missing.close()]);
}
