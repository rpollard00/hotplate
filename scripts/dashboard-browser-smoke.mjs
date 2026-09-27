import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startDashboardPreview } from "./dashboard-preview.mjs";
import { withBrowser } from "./browser-smoke.mjs";
import { openHotplateReadStore } from "../dist/src/store.js";
import { buildDashboardReport } from "../dist/src/dashboard/analytics.js";

const directory = process.env.HOTPLATE_SCREENSHOT_DIR ? resolve(process.env.HOTPLATE_SCREENSHOT_DIR) : await mkdtemp(join(tmpdir(), "hotplate-dashboard-smoke-"));
await mkdir(directory, { recursive: true });
const previews = [];
const measurements = {};
try {
  for (const scenario of ["rich", "empty", "missing"]) previews.push(await startDashboardPreview({ scenario, now: new Date("2025-02-21T12:00:00Z") }));
  const [rich, empty, missing] = previews;
  const started = performance.now();
  const response = await fetch(new URL("/api/dashboard", rich.url));
  const raw = await response.text();
  measurements.responseBytes = Buffer.byteLength(raw);
  measurements.httpMs = Math.round(performance.now() - started);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  const payload = JSON.parse(raw);
  assert.equal(payload.kind, "ready");
  measurements.routes = payload.report.routes.length;
  measurements.observations = Object.values(payload.report.counts).reduce((sum, value) => sum + value, 0);
  let largePayload;
  let mixedPayload;
  const comparisonModel = payload.report.models[1].model;
  const opened = openHotplateReadStore({ databasePath: rich.databasePath });
  assert.equal(opened.kind, "ready");
  try {
    const skills = await opened.store.querySkillTable({});
    const chains = await opened.store.querySkillChain({});
    const derivationStart = performance.now();
    buildDashboardReport({ filter: {}, skills, chains });
    measurements.derivationMs = Number((performance.now() - derivationStart).toFixed(2));
    const largeChains = { runs: Array.from({ length: 10 }, (_, copy) => chains.runs.map(run => ({ ...run, segmentId: run.segmentId + '-scale-' + copy }))).flat() };
    const largeStart = performance.now();
    const largeReport = buildDashboardReport({ filter: {}, skills, chains: largeChains });
    measurements.largeDerivationMs = Number((performance.now() - largeStart).toFixed(2));
    largePayload = { ...payload, report: largeReport, chains: largeChains };
    measurements.largeResponseBytes = Buffer.byteLength(JSON.stringify(largePayload));
    measurements.largeRoutes = largeReport.routes.length;
    const makoRun = chains.runs.find(run => run.steps.some(step => step.kind === "observations" && step.items.some(item => item.evidence.kind === "read-result" && item.evidence.skill.name === "mako")));
    assert.ok(makoRun);
    const mixedRun = { ...makoRun, steps: makoRun.steps.map(step => step.kind === "gap" ? step : {
      ...step, items: step.items.map(item => item.evidence.kind !== "read-result" ? item : {
        ...item, evidence: { ...item.evidence, model: item.evidence.skill.name === "mako" ? payload.report.models[0].model : comparisonModel },
      }),
    }) };
    const mixedChains = { runs: [mixedRun] };
    mixedPayload = { ...payload, report: buildDashboardReport({ filter: {}, skills, chains: mixedChains }), chains: mixedChains };
  } finally { await opened.store.close(); }

  await withBrowser(async ({ command, evaluate, until, screenshot, errors }) => {
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
    async function input(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('input', { bubbles: true }));`); }
    async function change(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', { bubbles: true }));`); }
    async function noOverflow() { assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), "No page-level horizontal overflow"); }
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url: rich.url });
    await until(ready);
    assert.equal(await evaluate('document.getElementById("time-preset").value'), "all", "Historical data is visible by default");
    assert.equal(await evaluate('document.getElementById("preview-label").hidden'), false);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    assert.ok(await evaluate('document.querySelectorAll(".rank-row").length <= 8'));
    assert.ok(await evaluate('document.querySelectorAll(".route-choice").length <= 8'));
    assert.ok(await evaluate('document.querySelector("#activity-chart svg desc").textContent.includes("Exact counts")'));
    assert.equal(await evaluate('document.querySelectorAll("#activity-chart tbody tr").length'), payload.report.activity.bins.length);
    measurements.renderedNodes = await evaluate('document.querySelectorAll("*").length');
    assert.ok(measurements.renderedNodes < 3000, "Bounded initial rendering for 111 paths");
    await noOverflow();
    await screenshot(join(directory, "overview-desktop.png"));

    await evaluate('document.querySelector("[data-workspace=models]").focus()');
    assert.equal(await evaluate('document.activeElement.dataset.workspace'), "models");
    await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await command("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate('document.getElementById("models-workspace").hidden'), false, "Keyboard workspace navigation");
    assert.ok(await evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'), "Visible keyboard focus");
    assert.ok(await evaluate('document.querySelectorAll("#model-matrix .heat-0").length > 0'), "Zeros remain visible in the model matrix");
    const matrixCounts = await evaluate('Array.from(document.querySelectorAll("#model-matrix tbody tr"), row => ({ name: row.querySelector("th").textContent, counts: Array.from(row.querySelectorAll("td"), cell => Number(cell.textContent.replaceAll(",", ""))) }))');
    for (const row of matrixCounts) {
      const group = payload.report.skillGroups.find(group => group.name === row.name);
      assert.deepEqual(row.counts, payload.report.models.map(column => group.models.find(entry => JSON.stringify(entry.model) === JSON.stringify(column.model))?.successfulReads ?? 0));
    }
    await click('#model-matrix tbody tr button');
    assert.ok((await evaluate('document.getElementById("skill-detail").textContent')).includes("Same-name variants combined"));
    await screenshot(join(directory, "models-desktop.png"));
    await change("model-measure", "failedReads");
    assert.match(await evaluate('document.querySelector("#model-matrix caption").textContent'), /failures/);

    await click('[data-workspace=overview]');
    await click('#catalog-context summary');
    await input("catalog-search", "<script>");
    assert.ok((await evaluate('document.getElementById("catalog-list").textContent')).includes("<script>synthetic</script>"));
    assert.equal(await evaluate('document.querySelectorAll("#dashboard-content script").length'), 0);
    await click('#catalog-list button.link');
    assert.ok((await evaluate('document.getElementById("skill-detail").textContent')).includes("0 reads · 0 failures · 0 requests · 0 wrappers"));
    await click('[data-workspace=overview]');
    await click('#overview-mako');
    assert.match(await evaluate('document.getElementById("path-focus-label").textContent'), /mako/);
    assert.ok(await evaluate('document.querySelectorAll(".timeline-step").length > 1'));
    assert.ok((await evaluate('document.getElementById("chain-view").textContent')).includes("does not prove mako routing"));
    await screenshot(join(directory, "paths-desktop.png"));
    await click('#clear-path-focus');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), payload.report.routes.length + " scoped runs");
    const gapRouteIndex = payload.report.routes.findIndex(route => route.steps.some(step => step.kind === 'gap'));
    for (let page = 0; page < Math.floor(gapRouteIndex / 8); page++) await click('[aria-label="Next routes"]');
    await click('.route-choice:nth-child(' + (gapRouteIndex % 8 + 1) + ')');
    assert.ok(await evaluate('document.querySelectorAll(".timeline-step.gap").length > 0'), "Capture gaps remain visible");
    await click('#clear-path-focus');
    await click('[aria-label="Next routes"]');
    assert.match(await evaluate('document.getElementById("route-pagination").textContent'), /9–16/);
    await click('.route-choice');
    assert.equal(await evaluate('document.activeElement.id'), "chain-view");

    await click('[data-workspace=overview]');
    await click('#relationship-view button.link');
    assert.equal(await evaluate('document.getElementById("paths-workspace").hidden'), false);
    assert.ok(await evaluate('document.querySelectorAll(".timeline-step.supporting").length > 0'));
    await click('#relationship-detail button.link');
    assert.ok((await evaluate('document.getElementById("chain-view").textContent')).includes("Supporting relationship evidence"));
    await screenshot(join(directory, "relationship-desktop.png"));

    await click('#toggle-filters');
    await change("project-filter", payload.filterOptions.projects[0]);
    await click('#filter-form button[type=submit]');
    await until(ready);
    assert.ok((await evaluate('document.getElementById("scope-summary").textContent')).includes(payload.filterOptions.projects[0].split('/').at(-1)));
    await change("time-preset", "7");
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), "0");
    assert.match(await evaluate('document.getElementById("skill-table").textContent'), /No successful reads/);
    await click('#reset-filters');
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    await click('#toggle-filters');

    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('[data-workspace=overview]');
    await noOverflow();
    await screenshot(join(directory, "overview-mobile.png"));
    await click('[data-workspace=models]');
    await noOverflow();
    await screenshot(join(directory, "models-mobile.png"));
    const scrolledMatrix = await evaluate('(() => { const matrix = document.getElementById("model-matrix"); matrix.scrollLeft = 200; return { scroll: matrix.scrollLeft, labelLeft: document.querySelector(".matrix th").getBoundingClientRect().left, matrixLeft: matrix.getBoundingClientRect().left }; })()');
    assert.ok(scrolledMatrix.scroll > 0);
    assert.equal(scrolledMatrix.labelLeft, scrolledMatrix.matrixLeft, 'Skill labels remain visible when model columns scroll');
    await screenshot(join(directory, "models-mobile-scroll.png"));
    await click('[data-workspace=paths]');
    assert.ok(await evaluate('document.getElementById("route-list").clientHeight <= 320'), 'Mobile route list stays bounded above detail');
    await noOverflow();
    await screenshot(join(directory, "paths-mobile.png"));

    await evaluate('(async () => { window.smokeFetch = window.fetch; window.smokePayload = await window.fetch("/api/dashboard").then(response => response.json()); })()');
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(mixedPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await click('[data-workspace=models]');
    await change('model-measure', 'successfulReads');
    const zeroLabel = `mako, ${comparisonModel.provider} / ${comparisonModel.id}: 0 successful reads`;
    await evaluate(`Array.from(document.querySelectorAll('#model-matrix button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(zeroLabel)}).click();`);
    assert.equal(await evaluate('document.activeElement.id'), 'skill-detail');
    await change('model-measure', 'failedReads');
    assert.ok((await evaluate('document.getElementById("skill-detail").textContent')).includes(comparisonModel.id), 'Model selection survives a detail rerender');
    await click('#skill-detail > .section-heading button');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), '0 scoped runs', 'Model and skill must match the same read, not unrelated reads in the same path');
    await evaluate(`window.smokeLargePayload = ${JSON.stringify(largePayload)}; window.fetch = async () => new Response(JSON.stringify(window.smokeLargePayload)); document.getElementById('refresh-data').click();`);
    await until(ready);
    measurements.largeRenderedNodes = await evaluate('document.querySelectorAll("*").length');
    assert.ok(measurements.largeRenderedNodes < 3000, "Rendering stays bounded for 1,110 paths");
    assert.equal(await evaluate('document.querySelectorAll(".route-choice").length'), 8);
    await evaluate('window.smokeLongPayload = structuredClone(window.smokePayload); const group = window.smokeLongPayload.report.skillGroups[0]; group.name = "long-skill-".repeat(30) + "<img src=x onerror=alert(1)>"; for (const skill of window.smokeLongPayload.report.skills) { if (group.skillKeys.includes(skill.key)) skill.identity.name = group.name; } window.fetch = async () => new Response(JSON.stringify(window.smokeLongPayload)); document.getElementById("refresh-data").click();');
    await until(ready);
    await click('[data-workspace=overview]');
    await noOverflow();
    await click('#skill-table button.link');
    await noOverflow();
    assert.equal(await evaluate('document.querySelectorAll("#dashboard-content img").length'), 0);
    await click('#skill-detail > .section-heading button');
    await noOverflow();
    await screenshot(join(directory, "long-label-mobile.png"));
    await evaluate('window.fetch = () => new Promise(resolve => { window.smokeResolve = resolve; }); document.getElementById("refresh-data").click();');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true, "Old evidence hidden during loading");
    assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "true");
    await evaluate('window.fetch = window.smokeFetch; document.getElementById("refresh-data").click();');
    await until(ready);
    await evaluate(`window.smokeResolve(new Response(${JSON.stringify(JSON.stringify({ ...payload, kind: "error", message: "Stale error must not replace new data" }))}, {headers:{'Content-Type':'application/json'}}));`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Ready", "Stale responses cannot overwrite current results");
    await evaluate('window.fetch = async () => { throw new Error("Synthetic network failure"); }; document.getElementById("refresh-data").click();');
    await until('document.getElementById("status-text").textContent === "Error"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true, "Failed refresh does not expose stale evidence");
    assert.match(await evaluate('document.getElementById("message-panel").textContent'), /Synthetic network failure/);
    await screenshot(join(directory, "error-mobile.png"));
    await evaluate('window.fetch = window.smokeFetch');
    await click('#message-panel button');
    await until(ready);

    await command("Page.navigate", { url: empty.url });
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), "0");
    assert.match(await evaluate('document.getElementById("activity-chart").textContent'), /No dated evidence/);
    await screenshot(join(directory, "empty-mobile.png"));
    await command("Page.navigate", { url: missing.url });
    await until('document.getElementById("status-text")?.textContent === "No database"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true);
    assert.match(await evaluate('document.getElementById("message-panel").textContent'), /No Hotplate database found/);
    await screenshot(join(directory, "missing-mobile.png"));
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
    assert.deepEqual(errors, [], "No runtime or CSP errors");
    measurements.browserErrors = errors;
  });
  await writeFile(join(directory, "measurements.json"), JSON.stringify(measurements, null, 2) + "\n");
  process.stdout.write(`Dashboard browser smoke passed. Screenshots: ${directory}\n${JSON.stringify(measurements)}\n`);
} finally {
  await Promise.all(previews.map(preview => preview.close()));
}
