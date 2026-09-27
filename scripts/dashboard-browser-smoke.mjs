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
  for (const asset of ['/', '/assets/app.js']) {
    const source = await fetch(new URL(asset, rich.url)).then(result => result.text());
    assert.doesNotMatch(source, /mako/i, 'Dashboard assets must not special-case a skill');
  }
  measurements.responseBytes = Buffer.byteLength(raw);
  measurements.httpMs = Math.round(performance.now() - started);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  const payload = JSON.parse(raw);
  assert.equal(payload.kind, "ready");
  measurements.routes = payload.report.routes.length;
  measurements.observations = Object.values(payload.report.counts).reduce((sum, value) => sum + value, 0);
  let largePayload;
  let mixedPayload;
  let diagnosticPayload;
  let repeatedPayload;
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
    const observationSteps = chains.runs.flatMap(run => run.steps.filter(step => step.kind === 'observations'));
    const singleStep = (matches) => {
      const step = observationSteps.find(step => step.items.some(matches));
      assert.ok(step);
      return { ...step, items: [step.items.find(matches)] };
    };
    const wrapperStep = singleStep(item => item.evidence.kind === 'wrapper-observed');
    const wrapper = wrapperStep.items[0];
    const gapReasons = ['queue-overflow', 'db-busy', 'db-error', 'shutdown-deadline', 'invalid-observation', 'filtered-intermediates'];
    const diagnosticRun = { ...makoRun, steps: [
      singleStep(item => item.evidence.kind === 'command-intent'),
      { ...wrapperStep, items: [{ ...wrapper, evidence: { ...wrapper.evidence, wrapperSource: 'expanded-prompt' } }] },
      singleStep(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success'),
      singleStep(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'error'),
      ...gapReasons.map(reason => ({ kind: 'gap', observedAt: null, reason, omitted: 1 })),
    ] };
    const diagnosticChains = { runs: [diagnosticRun] };
    diagnosticPayload = { ...payload, report: buildDashboardReport({ filter: {}, skills, chains: diagnosticChains }), chains: diagnosticChains };
    const reads = observationSteps.flatMap(step => step.items).filter(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success');
    const makoRead = reads.find(item => item.evidence.skill.name === 'mako');
    const howRead = reads.find(item => item.evidence.skill.name === 'how');
    assert.ok(makoRead && howRead);
    let serial = 0;
    const controlledStep = (items, at) => ({ kind: 'observations', observedAt: at, turnId: 'controlled-turn', leafId: 'controlled-leaf', items: items.map(item => ({
      ...item, observationId: 'controlled-' + ++serial, sequence: serial, observedAt: at,
      evidence: { ...item.evidence, toolCallId: 'controlled-tool-' + serial },
    })) });
    const currentDay = '2025-02-21T10:00:00.000Z';
    const previousDay = '2025-02-20T10:00:00.000Z';
    const repeatedChains = { runs: [
      { ...makoRun, segmentId: 'current-repeated', steps: [controlledStep([makoRead, makoRead, howRead], currentDay)] },
      { ...makoRun, segmentId: 'current-other', steps: [controlledStep([howRead], currentDay)] },
      { ...makoRun, segmentId: 'previous', steps: [controlledStep([makoRead], previousDay)] },
    ] };
    repeatedPayload = { ...payload, report: buildDashboardReport({ filter: {}, skills, chains: repeatedChains }), chains: repeatedChains };
  } finally { await opened.store.close(); }

  await withBrowser(async ({ command, evaluate, until, screenshot, errors }) => {
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
    async function input(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('input', { bubbles: true }));`); }
    async function change(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', { bubbles: true }));`); }
    async function noOverflow() { assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), "No page-level horizontal overflow"); }
    async function enter() {
      await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await command("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    async function helpFromEveryTab() {
      for (const workspace of ['overview', 'models', 'paths']) {
        await click('[data-workspace=' + workspace + ']');
        assert.equal(await evaluate('document.querySelectorAll("#data-help").length'), 1);
        const helpText = await evaluate('document.getElementById("data-help").textContent');
        assert.doesNotMatch(helpText, /mako|prove|causal|dependencies|missed opportunit|queued|crash|followed the instructions/i);
        for (const definition of ['SKILL.md', 'request', 'wrapper', 'grouped by name', 'model attribution', 'recorded run', 'Order within a read group', 'lost records', 'hidden by filters', 'extension']) assert.ok(helpText.includes(definition), 'Retained definition: ' + definition);
        await evaluate('document.querySelector("#data-help summary").focus()');
        await enter();
        assert.equal(await evaluate('document.getElementById("data-help").open'), true, 'Keyboard help access from ' + workspace);
        assert.ok(await evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'));
        assert.ok(await evaluate('document.querySelector("#data-help").getBoundingClientRect().height > 0'));
        await noOverflow();
        await screenshot(join(directory, 'help-' + workspace + '-' + await evaluate('innerWidth') + '.png'));
        await enter();
        assert.equal(await evaluate('document.getElementById("data-help").open'), false);
      }
    }
    async function noZeroPagers() { assert.equal(await evaluate('Array.from(document.querySelectorAll(".pagination")).filter(item => !item.hidden && item.textContent.includes("0–0 of 0")).length'), 0); }
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command("Page.navigate", { url: rich.url });
    await until(ready);
    assert.equal(await evaluate('document.getElementById("time-preset").value'), "all", "Historical data is visible by default");
    assert.equal(await evaluate('document.getElementById("preview-label").hidden'), false);
    assert.equal(await evaluate('document.querySelectorAll("footer").length'), 0, 'Footer and its separator are removed');
    assert.equal(await evaluate('document.body.textContent.includes("Hotplate / read-only")'), false);
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true, 'Default summary is hidden');
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), '');
    assert.ok(await evaluate('document.getElementById("time-preset").getBoundingClientRect().width > 0'), 'Period remains usable');
    assert.equal(await evaluate('document.querySelectorAll(".eyebrow, .activity-summary").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll("#relationships-heading + p, #models-workspace .page-heading p").length'), 0, 'Read patterns and model headings have no disclaimer subtitles');
    await helpFromEveryTab();
    await click('[data-workspace=overview]');
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    assert.ok(await evaluate('document.querySelectorAll(".rank-row").length <= 8'));
    assert.ok(await evaluate('document.querySelectorAll(".route-choice").length <= 8'));
    assert.ok(await evaluate('document.querySelector("#activity-chart svg desc").textContent.includes("Exact counts")'));
    assert.equal(await evaluate('document.querySelectorAll("#activity-chart tbody tr").length'), payload.report.activity.bins.length);
    measurements.renderedNodes = await evaluate('document.querySelectorAll("*").length');
    assert.ok(measurements.renderedNodes < 3000, "Bounded initial rendering for 111 paths");
    await noOverflow();
    await screenshot(join(directory, "overview-desktop.png"));

    const exploreSkill = await evaluate('document.querySelector("#skill-table button.link").textContent');
    const matching = payload.report.routes.filter(route => route.steps.some(step => step.kind === 'observations' && step.items.some(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success' && item.evidence.skill.name === exploreSkill)));
    await click('#skill-table button.link');
    assert.equal(await evaluate('document.activeElement.id'), 'explorer-panel', 'Selection moves keyboard focus to its details');
    assert.equal(await evaluate('document.getElementById("models-workspace").hidden'), true, 'Ranked skill opens the linked explorer');
    assert.equal(await evaluate('document.getElementById("explorer-panel").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#explore-totals strong").textContent'), String(matching.length));
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), /Recent 7 days vs previous period/);
    const bins = payload.report.activity.bins;
    const recentStart = bins.at(-7).startAt;
    const previousStart = new Date(Date.parse(recentStart) - 7 * 86400000).toISOString();
    const readBearingPaths = (from, to) => payload.report.routes.filter(route => route.steps.some(step => step.kind === 'observations' && step.items.some(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success' && Date.parse(item.observedAt) >= Date.parse(from) && Date.parse(item.observedAt) < Date.parse(to)))).length;
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), new RegExp(readBearingPaths(recentStart, bins.at(-1).endAt) + ' paths'));
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), new RegExp(readBearingPaths(previousStart, recentStart) + ' paths'));
    await click('#explore-models');
    assert.equal(await evaluate('document.querySelector("#skill-detail h2").textContent'), exploreSkill, 'Exploration links to existing model detail');
    await click('[data-workspace=overview]');
    await click('#explore-comparison .section-heading button');
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit[data-selected=true]").length'), 7);
    assert.equal(await evaluate('document.getElementById("skills-heading").textContent'), 'Skills in selection');
    const intervalCounts = new Map();
    for (const route of matching) {
      if (!route.steps.some(step => step.kind === 'observations' && step.items.some(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success' && item.evidence.skill.name === exploreSkill && Date.parse(item.observedAt) >= Date.parse(recentStart)))) continue;
      for (const step of route.steps) if (step.kind === 'observations') for (const item of step.items) {
        if (item.evidence.kind !== 'read-result' || item.evidence.outcome !== 'success' || Date.parse(item.observedAt) < Date.parse(recentStart)) continue;
        const name = item.evidence.skill.name; intervalCounts.set(name, (intervalCounts.get(name) || 0) + 1);
      }
    }
    const expectedRanks = [...intervalCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".rank-row"), row => [row.querySelector("button").textContent, Number(row.querySelector("strong").textContent)])'), expectedRanks, 'Ranks reflect the matching paths and interval');
    assert.equal(await evaluate('document.querySelector("#explore-chips").textContent.includes("UTC:")'), true);
    const expectedModels = new Map();
    for (const route of matching) for (const step of route.steps) if (step.kind === 'observations') for (const item of step.items) {
      if (item.evidence.kind !== 'read-result' || item.evidence.outcome !== 'success' || item.evidence.skill.name !== exploreSkill || Date.parse(item.observedAt) < Date.parse(recentStart)) continue;
      const model = item.evidence.model; const name = model ? model.provider + ' / ' + model.id : 'Unknown model';
      const cell = expectedModels.get(name) || { name, reads: 0, paths: new Set() };
      cell.reads += 1; cell.paths.add(route.key); expectedModels.set(name, cell);
    }
    const modelRows = [...expectedModels.values()].sort((a, b) => b.reads - a.reads || a.name.localeCompare(b.name));
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#explore-model-list > button"), item => [item.firstElementChild.textContent, Number(item.querySelector("strong").textContent.split(" ")[0]), Number(item.querySelector("small").textContent.split(" ")[0])])'), modelRows.slice(0, 5).map(row => [row.name, row.reads, row.paths.size]), 'Model counts follow the selected skill and dates');
    await click('#explore-model-list > button');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), modelRows[0].paths.size + ' paths', 'Model row opens paths with the matching read, not any co-read');
    assert.equal(await evaluate('document.querySelector("#route-model option:checked").textContent'), modelRows[0].name);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll(".observation.matching")).some(item => item.textContent.includes(${JSON.stringify(modelRows[0].name)}))`), 'Model-specific matching read is highlighted');
    assert.ok(await evaluate(`Array.from(document.querySelectorAll(".observation.matching")).every(item => item.textContent.includes(${JSON.stringify(modelRows[0].name)}))`), 'Other model reads do not receive the selection highlight');
    await click('#back-to-explorer');
    await click('#explore-paths .explore-path');
    assert.equal(await evaluate('document.getElementById("path-focus-label").textContent'), 'Paths in exploration');
    assert.ok(await evaluate('document.querySelectorAll(".observation.matching").length > 0'), 'Selected reads are marked in the full path');
    const exploredKey = await evaluate('document.getElementById("chain-view").dataset.routeKey');
    const explored = payload.report.routes.find(route => route.key === exploredKey);
    assert.equal(await evaluate('document.querySelectorAll("#chain-view .timeline-step").length'), explored.steps.length);
    await click('#back-to-explorer');
    assert.equal(await evaluate('document.getElementById("explorer-panel").hidden'), false);
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit[data-selected=true]").length'), 7);
    await noOverflow();
    await screenshot(join(directory, 'explorer-desktop.png'));
    await click('#clear-explorer');
    assert.equal(await evaluate('document.getElementById("explorer-panel").hidden'), true);
    assert.equal(await evaluate('document.activeElement.id'), 'activity-heading');
    await click('[data-workspace=paths]');
    assert.equal(await evaluate('document.getElementById("path-focus-label").textContent'), 'All session paths', 'Clearing exploration clears its path focus');
    assert.equal(await evaluate('document.getElementById("back-to-explorer").hidden'), true);
    await click('[data-workspace=overview]');

    await evaluate('document.querySelector("#activity-chart svg").scrollIntoView({block:"center"})');
    const chartPoints = await evaluate('Array.from(document.querySelectorAll(".activity-hit"), hit => { const r=hit.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })');
    for (const [type, point] of [['mousePressed', chartPoints[14]], ['mouseMoved', chartPoints[17]], ['mouseReleased', chartPoints[17]]]) {
      await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit[data-selected=true]").length'), 4, 'Pointer drag selects complete UTC bins');
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /UTC:/);
    await evaluate('document.querySelectorAll(".activity-hit")[18].focus()');
    await enter();
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit[data-selected=true]").length'), 1, 'Keyboard activates the focused bar');
    assert.ok(await evaluate('getComputedStyle(document.activeElement).stroke !== "none"'), 'Focused chart bar has visible stroke');
    await click('#activity-chart summary');
    await click('#activity-chart .activity-choice');
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), /outside the current report/, 'The first date has no loaded baseline');
    await click('#clear-explorer');
    await click('#activity-chart summary');

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
    await click('#skill-detail summary');
    assert.ok((await evaluate('document.getElementById("skill-detail").textContent')).includes("Files with the same skill name can have different content"));
    assert.match(await evaluate('document.querySelector("#skill-detail summary").textContent'), /Files and requests · \d+ entr/);
    assert.match(await evaluate('document.getElementById("models-workspace").textContent'), /Skills are grouped by name/);
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
    const selectedSkill = await evaluate('document.querySelector("#skill-table button.link").textContent');
    await click('#skill-table button.link');
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /Skill:/);
    await click('#explore-all-paths');
    assert.equal(await evaluate('document.getElementById("path-focus-label").textContent'), 'Paths in exploration');
    assert.ok(await evaluate('document.querySelectorAll(".timeline-step").length > 1'));
    const selectedRouteKey = await evaluate('document.getElementById("chain-view").dataset.routeKey');
    const selectedRoute = payload.report.routes.find(route => route.key === selectedRouteKey);
    assert.ok(selectedRoute.steps.some(step => step.kind === 'observations' && step.items.some(item => payload.report.skills.find(skill => skill.key === item.skillKey).identity.name === selectedSkill)));
    assert.equal(await evaluate('document.querySelectorAll("#chain-view .timeline-step").length'), selectedRoute.steps.length, 'Skill selection keeps other recorded steps');
    await click('#chain-view > details summary');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#chain-view dl dt"), item => item.textContent)'), ['Machine', 'Account source', 'Project', 'Session ID', 'Segment ID', 'Run ID']);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#chain-view dl dd"), item => item.textContent)'), Object.values(selectedRoute.scope).map(value => value ?? 'Unknown'));
    await noOverflow();
    await screenshot(join(directory, "paths-desktop.png"));
    await click('#clear-path-focus');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), payload.report.routes.length + " paths");
    const gapRouteIndex = payload.report.routes.findIndex(route => route.steps.some(step => step.kind === 'gap'));
    for (let page = 0; page < Math.floor(gapRouteIndex / 8); page++) await click('[aria-label="Next routes"]');
    await click('.route-choice:nth-child(' + (gapRouteIndex % 8 + 1) + ')');
    assert.ok(await evaluate('document.querySelectorAll(".timeline-step.gap").length > 0'), "Capture gaps remain visible");
    assert.match(await evaluate('document.querySelector(".gap-card").textContent'), /Capture gap: 2 records lost\. Capture queue full\./);
    assert.equal(await evaluate('/complete/i.test(document.getElementById("chain-view").textContent)'), false, 'No false completeness claim');
    await click('.timeline-step.gap summary');
    assert.match(await evaluate('document.querySelector(".timeline-step.gap details").textContent'), /queue-overflow/);
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
    assert.ok((await evaluate('document.getElementById("chain-view").textContent')).includes("Selected occurrence"));
    await screenshot(join(directory, "relationship-desktop.png"));
    await input('route-search', 'no-such-relationship-path');
    assert.equal(await evaluate('document.querySelectorAll("#relationship-detail button").length'), 0);
    assert.equal(await evaluate('document.getElementById("relationship-detail").textContent.includes("Select an occurrence")'), false, 'No instruction to select an unavailable occurrence');
    await input('route-search', '');
    assert.ok(await evaluate('document.querySelectorAll("#relationship-detail button").length > 0'));
    assert.match(await evaluate('document.getElementById("relationship-detail").textContent'), /Select an occurrence/);

    await click('#toggle-filters');
    await change("project-filter", payload.filterOptions.projects[0]);
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true, 'Draft filters do not change the summary');
    await click('#filter-form button[type=submit]');
    await until(ready);
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), false);
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), 'Project: ' + payload.filterOptions.projects[0]);
    await change('project-filter', payload.filterOptions.projects[1]);
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), 'Project: ' + payload.filterOptions.projects[0], 'Summary reflects the applied report, not drafts');
    await change('project-filter', payload.filterOptions.projects[0]);
    await change("time-preset", "7");
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), "0");
    assert.match(await evaluate('document.getElementById("skill-table").textContent'), /No successful reads match these filters/);
    assert.equal(await evaluate('document.getElementById("chain-view").hidden'), true);
    assert.equal(await evaluate('document.getElementById("skill-detail").hidden'), true);
    await noZeroPagers();
    const appliedDates = await evaluate('({ from: document.getElementById("from-filter").value, to: document.getElementById("to-filter").value, summary: document.getElementById("scope-summary").textContent })');
    assert.ok(appliedDates.summary.includes(new Date(appliedDates.from + 'Z').toISOString()));
    assert.ok(appliedDates.summary.includes(new Date(appliedDates.to + 'Z').toISOString()));
    assert.doesNotMatch(appliedDates.summary, /All time|All projects|All machines/);
    await click('#reset-filters');
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true, 'Reset hides the summary');
    await change('machine-filter', payload.filterOptions.machines[0]);
    await until(ready);
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), 'Machine: ' + payload.filterOptions.machines[0]);
    await change('from-filter', '2025-02-01T01:23');
    await change('to-filter', '2025-02-21T04:56');
    await click('#filter-form button[type=submit]');
    await until(ready);
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), '2025-02-01T01:23:00.000Z to 2025-02-21T04:56:00.000Z · UTC · Machine: ' + payload.filterOptions.machines[0]);
    await change('from-filter', '');
    await click('#filter-form button[type=submit]');
    await until(ready);
    assert.match(await evaluate('document.getElementById("scope-summary").textContent'), /^First record to 2025-02-21T04:56:00.000Z/);
    await change('from-filter', '2025-02-01T01:23');
    await change('to-filter', '');
    await click('#filter-form button[type=submit]');
    await until(ready);
    assert.match(await evaluate('document.getElementById("scope-summary").textContent'), /^2025-02-01T01:23:00.000Z to Latest record/);
    await click('#reset-filters');
    await until(ready);
    await click('#toggle-filters');

    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await change('machine-filter', payload.filterOptions.machines[0]);
    await until(ready);
    await change('source-filter', 'rpc');
    await change('model-provider-filter', payload.filterOptions.modelProviders[0]);
    await change('model-id-filter', payload.filterOptions.modelIds[0]);
    await change('from-filter', '2025-02-01T01:23');
    await change('to-filter', '2025-02-21T04:56');
    await click('#filter-form button[type=submit]');
    await until(ready);
    const activeSummary = await evaluate('document.getElementById("scope-summary").textContent');
    assert.ok(activeSummary.includes('Machine: ' + payload.filterOptions.machines[0]));
    assert.ok(activeSummary.includes('RPC requests'));
    assert.ok(activeSummary.includes('Model provider: ' + payload.filterOptions.modelProviders[0]));
    assert.ok(activeSummary.includes('Model: ' + payload.filterOptions.modelIds[0]));
    assert.doesNotMatch(activeSummary, /All time|All projects|All machines/);
    await noOverflow();
    await screenshot(join(directory, 'filters-mobile.png'));
    await click('#reset-filters');
    await until(ready);
    await helpFromEveryTab();
    await click('[data-workspace=overview]');
    await noOverflow();
    await screenshot(join(directory, "overview-mobile.png"));
    await command('Emulation.setTouchEmulationEnabled', { enabled: true });
    await evaluate('document.querySelector("#activity-chart svg").scrollIntoView({block:"center"})');
    const mobilePoints = await evaluate('Array.from(document.querySelectorAll(".activity-hit"), hit => { const r=hit.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...mobilePoints[14], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...mobilePoints[16], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit[data-selected=true]").length'), 3, 'Touch drag selects a range');
    await click('#clear-explorer');
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await click('#skill-table button.link');
    await noOverflow();
    await screenshot(join(directory, 'explorer-mobile.png'));
    await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
    await noOverflow();
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('#explore-comparison .section-heading button');
    await noOverflow();
    await screenshot(join(directory, 'comparison-mobile.png'));
    await click('#clear-explorer');
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
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(repeatedPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await click('[data-workspace=overview]');
    await evaluate('Array.from(document.querySelectorAll("#skill-table button.link")).find(item => item.textContent === "mako").click()');
    await click('#activity-chart summary');
    await evaluate('document.querySelectorAll("#activity-chart .activity-choice")[1].click()');
    assert.equal(await evaluate('document.querySelector("#explore-totals").textContent'), '1matching paths2successful reads', 'Repeat reads do not add paths');
    const controlledComparison = await evaluate('document.getElementById("explore-comparison").textContent');
    assert.match(controlledComparison, /2 paths · 4 reads/);
    assert.match(controlledComparison, /1 path · 1 read/);
    const makoShares = await evaluate('Array.from(document.querySelectorAll("#explore-comparison .compare-row")).find(row => row.querySelector("button")?.textContent === "mako").textContent');
    assert.match(makoShares, /50%1 path/);
    assert.match(makoShares, /100%1 path/, 'Share counts the path once, unlike raw reads');
    assert.equal(await evaluate('document.querySelector("#explore-model-list strong").textContent'), '2 reads', 'Model counts retain repeated reads');
    assert.equal(await evaluate('document.querySelector("#explore-model-list small").textContent'), '1 path', 'Model path counts do not duplicate a run');
    await noOverflow();
    await screenshot(join(directory, 'comparison-repeated-mobile.png'));
    await evaluate('window.fetch = window.smokeFetch; document.getElementById("refresh-data").click()');
    await until(ready);
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(mixedPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await click('[data-workspace=overview]');
    await evaluate('Array.from(document.querySelectorAll("#skill-table button.link")).find(item => item.textContent === "mako").click()');
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /Skill: mako/);
    await click('#explore-all-paths');
    await change('route-model', String(payload.report.models.findIndex(column => JSON.stringify(column.model) === JSON.stringify(comparisonModel))));
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), '0 paths', 'Model and explored skill must be the same read');
    await click('[data-workspace=models]');
    await change('model-measure', 'successfulReads');
    const zeroLabel = `mako, ${comparisonModel.provider} / ${comparisonModel.id}: 0 successful reads`;
    await evaluate(`Array.from(document.querySelectorAll('#model-matrix button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(zeroLabel)}).click();`);
    assert.equal(await evaluate('document.activeElement.id'), 'skill-detail');
    await change('model-measure', 'failedReads');
    assert.ok((await evaluate('document.getElementById("skill-detail").textContent')).includes(comparisonModel.id), 'Model selection survives a detail rerender');
    await click('#skill-detail > .section-heading button');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), '0 paths', 'Model and skill must match the same read, not unrelated reads in the same path');
    assert.equal(await evaluate('document.getElementById("chain-view").hidden'), true);
    assert.match(await evaluate('document.getElementById("route-list").textContent'), /No paths match these filters/);
    await noZeroPagers();
    await click('#clear-path-focus');
    assert.equal(await evaluate('document.getElementById("route-count").textContent'), '1 path');
    assert.equal(await evaluate('document.getElementById("chain-view").hidden'), false);
    await input('route-search', 'no-such-path');
    assert.match(await evaluate('document.getElementById("route-list").textContent'), /No paths match this search/);
    assert.equal(await evaluate('document.getElementById("chain-view").hidden'), true);
    await noZeroPagers();
    await click('#clear-path-focus');
    await click('[data-workspace=overview]');
    await input('skill-search', 'no-such-skill');
    assert.match(await evaluate('document.getElementById("skill-table").textContent'), /No successful reads match this search/);
    await click('#skill-table button.link');
    assert.equal(await evaluate('document.getElementById("catalog-context").open'), true);
    await input('catalog-search', 'no-such-catalog-entry');
    assert.match(await evaluate('document.getElementById("catalog-list").textContent'), /No catalog entries match this search/);
    await noZeroPagers();
    await evaluate(`window.smokeDiagnosticPayload = ${JSON.stringify(diagnosticPayload)}; window.fetch = async () => new Response(JSON.stringify(window.smokeDiagnosticPayload)); document.getElementById('refresh-data').click();`);
    await until(ready);
    await click('[data-workspace=paths]');
    assert.match(await evaluate('document.getElementById("chain-view").textContent'), /1 read · 1 failure · 1 request · 1 wrapper/);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".gap-card"), item => item.textContent)'), [
      'Capture gap: 1 record lost. Capture queue full.',
      'Capture gap: 1 record lost. Database busy.',
      'Capture gap: 1 record lost. Database error.',
      'Capture gap: 1 record lost. Capture stopped before saving.',
      'Capture gap: 1 record lost. Invalid record.',
      '1 record hidden by filters.',
    ]);
    assert.match(await evaluate('document.querySelector(".observation.wrapper").textContent'), /Wrapper · input after expansion/);
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".step-heading span:first-child")).some(item => item.textContent.endsWith(" / Request"))'));
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".step-heading span:first-child")).some(item => item.textContent.endsWith(" / Wrapper"))'));
    await evaluate('document.querySelectorAll("#chain-view details").forEach(item => { item.open = true; });');
    assert.match(await evaluate('document.getElementById("chain-view").textContent'), /expanded-prompt/);
    const diagnosticRead = diagnosticPayload.report.routes[0].steps.flatMap(step => step.kind === 'observations' ? step.items : []).find(item => item.evidence.kind === 'read-result');
    const diagnosticText = await evaluate('document.getElementById("chain-view").textContent');
    for (const exact of [diagnosticRead.observationId, diagnosticRead.evidence.skill.canonicalPath, diagnosticRead.evidence.toolCallId, diagnosticRead.observedAt]) assert.ok(diagnosticText.includes(exact), 'Exact record data stays available');
    await noOverflow();
    await screenshot(join(directory, 'diagnostics-mobile.png'));
    await evaluate('window.smokeDiagnosticPayload.report.routes[0].steps.find(step => step.kind === "observations" && step.items[0].evidence.kind === "wrapper-observed").items[0].evidence.wrapperSource = "unknown-pasted-or-transformed"; document.getElementById("refresh-data").click();');
    await until(ready);
    assert.match(await evaluate('document.querySelector(".observation.wrapper").textContent'), /Wrapper · source unknown/);
    assert.equal(await evaluate('/\\b1 (reads|failures|requests|wrappers|records|paths|entries|occurrences|days)\\b/.test(document.getElementById("chain-view").textContent)'), false);
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
    assert.ok((await evaluate('document.getElementById("explorer-panel").textContent')).includes('<img src=x onerror=alert(1)>'));
    await click('#explore-all-paths');
    await noOverflow();
    await screenshot(join(directory, "long-label-mobile.png"));
    await evaluate('window.fetch = () => new Promise(resolve => { window.smokeResolve = resolve; }); document.getElementById("refresh-data").click();');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true, "Old evidence hidden during loading");
    assert.equal(await evaluate('document.getElementById("workspace").getAttribute("aria-busy")'), "true");
    assert.equal(await evaluate('document.querySelector("#message-panel h2").textContent'), 'Loading activity…');
    assert.equal(await evaluate('document.querySelectorAll("#message-panel p").length'), 0);
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true);
    await evaluate('window.fetch = window.smokeFetch; document.getElementById("refresh-data").click();');
    await until(ready);
    await evaluate(`window.smokeResolve(new Response(${JSON.stringify(JSON.stringify({ ...payload, kind: "error", message: "Stale error must not replace new data" }))}, {headers:{'Content-Type':'application/json'}}));`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Ready", "Stale responses cannot overwrite current results");
    await evaluate('window.fetch = async () => { throw new TypeError("Failed to fetch"); }; document.getElementById("refresh-data").click();');
    await until('document.getElementById("status-text").textContent === "Error"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true, "Failed refresh does not expose stale evidence");
    assert.equal(await evaluate('document.querySelector("#message-panel > p").textContent'), 'Could not reach the dashboard server.');
    assert.equal(await evaluate('document.querySelector("#message-panel details").open'), false);
    await click('#message-panel summary');
    assert.match(await evaluate('document.querySelector("#message-panel details").textContent'), /Failed to fetch/);
    await screenshot(join(directory, "error-mobile.png"));
    await evaluate('window.fetch = window.smokeFetch');
    await click('#message-panel button');
    await until(ready);
    for (const [fetchBody, detail] of [
      ['throw new Error("Unclassified failure")', 'Unclassified failure'],
      ['return new Response("unavailable", { status: 503 })', 'HTTP 503'],
      ['return new Response(JSON.stringify({kind: "error", message: "Failed to fetch"}))', 'Failed to fetch'],
      ['return new Response("not JSON")', 'JSON'],
      ['return { ok: true, json: async () => { throw new TypeError("Failed to fetch"); } }', 'Failed to fetch'],
      ['const broken = structuredClone(window.smokePayload); broken.report.routes[0].scope = null; return new Response(JSON.stringify(broken))', 'null'],
    ]) {
      await evaluate(`window.fetch = async () => { ${fetchBody}; }; document.getElementById("refresh-data").click();`);
      await until('document.getElementById("status-text").textContent === "Error"');
      assert.equal(await evaluate('document.querySelectorAll("#message-panel > p").length'), 0, 'Do not repeat the error heading or diagnose unknown failures as network errors');
      assert.ok((await evaluate('document.querySelector("#message-panel details").textContent')).includes(detail));
      await evaluate('window.fetch = window.smokeFetch');
      await click('#message-panel button');
      await until(ready);
    }
    await click('[data-workspace=models]');
    await input('model-search', 'no-such-skill');
    assert.match(await evaluate('document.getElementById("model-matrix").textContent'), /No reads match this search/);
    assert.equal(await evaluate('document.getElementById("skill-detail").hidden'), true, 'No impossible skill selection placeholder');
    await noZeroPagers();

    await command("Page.navigate", { url: empty.url });
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), "0");
    assert.match(await evaluate('document.getElementById("activity-chart").textContent'), /No activity recorded yet/);
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true);
    assert.equal(await evaluate('document.getElementById("skill-detail").hidden'), true);
    assert.equal(await evaluate('document.getElementById("chain-view").hidden'), true);
    assert.equal(await evaluate('document.querySelectorAll("#skill-table button").length'), 0, 'No link to an empty catalog');
    await noZeroPagers();
    await click('[data-workspace=models]');
    await noOverflow();
    await click('[data-workspace=paths]');
    assert.match(await evaluate('document.getElementById("route-list").textContent'), /No paths recorded yet/);
    await noOverflow();
    await click('[data-workspace=overview]');
    await screenshot(join(directory, "empty-mobile.png"));
    await command("Page.navigate", { url: missing.url });
    await until('document.getElementById("status-text")?.textContent === "No database"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true);
    assert.match(await evaluate('document.getElementById("message-panel").textContent'), /No Hotplate database found/);
    assert.match(await evaluate('document.getElementById("message-panel").textContent'), /capture or collector configuration/);
    await click('#message-panel summary');
    assert.ok((await evaluate('document.getElementById("message-panel").textContent')).includes(missing.databasePath));
    await click('#message-panel button');
    await until('document.getElementById("status-text")?.textContent === "No database"');
    await noOverflow();
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
