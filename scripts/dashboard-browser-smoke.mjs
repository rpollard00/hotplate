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
  let sparsePayload;
  let oneBinPayload;
  let adaptivePayload;
  let catalogOnlyPayload;
  let manySkillsPayload;
  const comparisonModel = payload.report.models[1].model;
  const opened = openHotplateReadStore({ databasePath: rich.databasePath });
  assert.equal(opened.kind, "ready");
  try {
    const skills = await opened.store.querySkillTable({});
    const chains = await opened.store.querySkillChain({});
    const catalogRow = skills.rows.find(row => row.cataloged && row.canonicalPath !== null);
    assert.ok(catalogRow);
    const manySkills = { rows: [...skills.rows, ...Array.from({ length: 45 }, (_, index) => ({
      ...catalogRow, skillName: 'chooser-' + String(index).padStart(2, '0'), canonicalPath: '/synthetic/chooser-' + index + '/SKILL.md',
    }))] };
    catalogOnlyPayload = { ...payload, report: buildDashboardReport({ filter: {}, skills, chains: { runs: [] } }), chains: { runs: [] } };
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
    const manyChains = { runs: [...chains.runs, { ...makoRun, segmentId: 'many-skills', steps: Array.from({ length: 21 }, (_, day) => controlledStep(
      Array.from({ length: 45 }, (_, index) => ({ ...makoRead, evidence: { ...makoRead.evidence, skill: { ...makoRead.evidence.skill, name: 'chooser-' + String(index).padStart(2, '0'), canonicalPath: '/synthetic/chooser-' + index + '/SKILL.md' } } })),
      '2025-02-' + String(day + 1).padStart(2, '0') + 'T10:00:00.000Z',
    )) }] };
    manySkillsPayload = { ...payload, report: buildDashboardReport({ filter: {}, skills: manySkills, chains: manyChains }), chains: manyChains };
    const currentDay = '2025-02-21T10:00:00.000Z';
    const previousDay = '2025-02-20T10:00:00.000Z';
    const repeatedChains = { runs: [
      { ...makoRun, segmentId: 'current-repeated', steps: [controlledStep([makoRead, makoRead, howRead], currentDay)] },
      { ...makoRun, segmentId: 'current-other', steps: [controlledStep([howRead], currentDay)] },
      { ...makoRun, segmentId: 'previous', steps: [controlledStep([makoRead], previousDay)] },
    ] };
    repeatedPayload = { ...payload, report: buildDashboardReport({ filter: { fromObservedAt: "2025-02-20T00:00:00.000Z", toObservedAt: "2025-02-21T23:59:59.999Z" }, skills, chains: repeatedChains }), chains: repeatedChains };
    const oneBinChains = { runs: [repeatedChains.runs[0]] };
    oneBinPayload = { ...payload, report: buildDashboardReport({ filter: { fromObservedAt: '2025-02-21T10:00:00.000Z', toObservedAt: '2025-02-21T10:30:00.000Z' }, skills, chains: oneBinChains }), chains: oneBinChains };
    adaptivePayload = { ...payload, report: buildDashboardReport({ filter: { fromObservedAt: '2024-10-02T00:00:00.000Z', toObservedAt: '2025-02-21T12:00:00.000Z' }, skills, chains: repeatedChains }), chains: repeatedChains };
    const sparseChains = { runs: [...repeatedChains.runs.slice(0, 2), { ...makoRun, segmentId: 'before-gap', steps: [controlledStep([makoRead], '2025-02-19T10:00:00.000Z')] }] };
    sparsePayload = { ...payload, report: buildDashboardReport({ filter: {}, skills, chains: sparseChains }), chains: sparseChains };
  } finally { await opened.store.close(); }

  await withBrowser(async ({ command, evaluate, until, screenshot, errors }) => {
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
    async function input(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('input', { bubbles: true }));`); }
    async function change(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', { bubbles: true }));`); }
    async function noOverflow() { assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), "No page-level horizontal overflow"); }
    async function chartScreenshot(name) {
      const clip = await evaluate('(() => { const r=document.querySelector(".activity-panel").getBoundingClientRect(); return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}; })()');
      const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
      await writeFile(join(directory, name), Buffer.from(result.data, 'base64'));
    }
    async function enter() {
      await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await command("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    async function searchSkills(value) {
      await evaluate(`{ const search = document.querySelector('.trend-chooser input[type=search]'); search.value = ${JSON.stringify(value)}; search.dispatchEvent(new Event('input', { bubbles: true })); }`);
    }
    async function toggleSkill(name) {
      await evaluate(`{ const checkbox = Array.from(document.querySelectorAll('.trend-options input[type=checkbox]')).find(item => item.dataset.skill === ${JSON.stringify(name)}); if (!checkbox) throw new Error('Missing checkbox: ' + ${JSON.stringify(name)}); checkbox.focus(); }`);
      const chooserScroll = await evaluate('document.querySelector(".trend-options").scrollTop');
      await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      assert.equal(await evaluate('document.querySelector(".trend-chooser").open'), true, 'Skill toggles keep the same chooser open');
      assert.equal(await evaluate('document.querySelector(".trend-options").scrollTop'), chooserScroll, 'Toggling preserves chooser scroll');
    }
    async function colors() {
      return evaluate('Object.fromEntries(Array.from(document.querySelectorAll(".trend-area"), area => [area.dataset.skill, area.getAttribute("fill")]))');
    }
    async function assertStack(activity) {
      assert.equal(activity.kind, 'bucketed');
      assert.ok(activity.bins.length > 0);
      assert.equal(await evaluate('document.querySelectorAll(".trend-plot").length'), 1, 'All selected skills share one plot');
      const layers = await evaluate('Array.from(document.querySelectorAll(".trend-area"), area => ({name: area.dataset.skill, path: area.getAttribute("d"), fill: area.getAttribute("fill")}))');
      const names = await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)');
      assert.ok(names.length > 0, 'Geometry check needs selected layers');
      assert.deepEqual(layers.map(layer => layer.name), names);
      const values = names.map(name => activity.bins.map(bin => bin.skills.find(skill => skill.name === name)?.successfulReads ?? 0));
      const totals = activity.bins.map((_, index) => values.reduce((sum, series) => sum + series[index], 0));
      const maximum = Math.max(1, ...totals);
      const start = Date.parse(activity.startAt), duration = Date.parse(activity.endAt) - start;
      const lower = activity.bins.map(() => 0);
      const x = time => Math.max(0, Math.min(600, (Date.parse(time) - start) / duration * 600));
      const y = value => 240 - value / maximum * 240;
      for (const [layerIndex, layer] of layers.entries()) {
        assert.ok(layer.fill && layer.fill !== 'none');
        assert.match(layer.path, /^M.*Z$/i, 'Each area closes its cumulative boundary');
        assert.doesNotMatch(layer.path, /NaN|Infinity|undefined/);
        const points = [...layer.path.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)].map(match => [Number(match[1]), Number(match[2])]);
        const upper = lower.map((value, index) => value + values[layerIndex][index]);
        const expected = activity.bins.flatMap((bin, index) => [[x(bin.startAt), y(upper[index])], [x(bin.endAt), y(upper[index])]])
          .concat(activity.bins.flatMap((bin, index) => [[x(bin.startAt), y(lower[index])], [x(bin.endAt), y(lower[index])]]).reverse());
        assert.equal(points.length, expected.length, 'Every interval has an upper and lower step');
        for (let index = 0; index < points.length; index++) {
          assert.ok(points[index].every(Number.isFinite));
          assert.ok(points[index][0] >= 0 && points[index][0] <= 600 && points[index][1] >= 0 && points[index][1] <= 240);
          assert.ok(Math.abs(points[index][0] - expected[index][0]) < 0.02 && Math.abs(points[index][1] - expected[index][1]) < 0.02, layer.name + ' cumulative count geometry at point ' + index);
        }
        lower.splice(0, lower.length, ...upper);
      }
      assert.deepEqual(lower, totals, 'The top area equals the selected successful-read sum');
      await evaluate('document.querySelector(".trend-plot").focus()');
      await key('Home');
      const firstReadouts = await evaluate('Array.from(document.querySelectorAll(".trend-label small"), item => item.textContent)');
      assert.deepEqual(firstReadouts, values.map(series => series[0].toLocaleString('en-US') + (series[0] === 1 ? ' read' : ' reads')));
      await key('End');
      const lastReadouts = await evaluate('Array.from(document.querySelectorAll(".trend-label small"), item => item.textContent)');
      assert.deepEqual(lastReadouts, values.map(series => series.at(-1).toLocaleString('en-US') + (series.at(-1) === 1 ? ' read' : ' reads')));


    }
    async function helpFromEveryTab() {
      for (const workspace of ['overview', 'models', 'paths', 'resources']) {
        await click('[data-workspace=' + workspace + ']');
        assert.equal(await evaluate('document.querySelectorAll("#data-help").length'), 1);
        const helpText = await evaluate('document.getElementById("data-help").textContent');
        assert.doesNotMatch(helpText, /mako|prove|causal|dependencies|missed opportunit|queued|crash|followed the instructions/i);
        for (const definition of ['SKILL.md', 'request', 'wrapper', 'grouped by name', 'capture source', 'recorded run', 'Order within a read group', 'lost records', 'hidden by filters', 'agent integrations', 'Resource inventory', 'covered dates']) assert.ok(helpText.includes(definition), 'Retained definition: ' + definition);
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
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.smokeNow = Date.parse('2025-02-21T12:00:00.000Z');
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.smokeNow])); }
        static now() { return window.smokeNow; }
      };
    ` });
    await command("Page.navigate", { url: rich.url });
    await until(ready);
    assert.equal(await evaluate('document.getElementById("time-preset").value'), '7');
    const weekly = await fetch(new URL('/api/dashboard?fromObservedAt=2025-02-14T12:00:00.000Z&toObservedAt=2025-02-21T12:00:00.000Z', rich.url)).then(response => response.json());
    assert.equal(weekly.report.activity.binWidthMs, 3600000);
    assert.equal(weekly.report.activity.bins.length, 169);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), weekly.report.counts.successfulReads.toLocaleString('en-US'));
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), '2025-02-14T12:00:00.000Z to 2025-02-21T12:00:00.000Z · UTC');
    assert.equal(await evaluate('document.querySelectorAll("#activity-chart tbody tr").length'), 0, 'The activity table is lazy');
    assert.match(await evaluate('document.getElementById("activity-chart").textContent'), /Reads per interval/);
    await chartScreenshot('weekly-desktop.png');
    const weeklyNames = await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)');
    await assertStack(weekly.report.activity);
    async function key(name, modifiers = 0) {
      await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, modifiers, windowsVirtualKeyCode: { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Enter: 13, Tab: 9 }[name] });
    }
    await evaluate('document.querySelector(".trend-plot").focus()'); await key('Home'); await enter();
    const edgeValues = () => evaluate('Array.from(document.querySelectorAll(".brush-handle"), item => Number(item.getAttribute("aria-valuenow")))');
    assert.deepEqual(await edgeValues(), [0, 1]);
    assert.match(await evaluate('document.querySelector(".brush-handle[data-mode=end]").getAttribute("aria-valuetext")'), /2025-02-14 13:00:00 UTC \(exclusive\)/);
    await evaluate('document.querySelector(".brush-band").focus()'); await key('ArrowRight');
    assert.deepEqual(await edgeValues(), [1, 2]);
    await evaluate('document.querySelector(".brush-handle[data-mode=end]").focus()'); await key('ArrowRight');
    assert.deepEqual(await edgeValues(), [1, 3]);
    await click('.trend-label');
    const selectedChips = await evaluate('document.getElementById("explore-chips").textContent');
    await click('.trend-chooser summary');
    await until('document.activeElement.type === "search"');
    const extraSkill = await evaluate('document.querySelector(".trend-options input[type=checkbox]:not(:checked)").dataset.skill');
    await toggleSkill(extraSkill);
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 6);
    assert.deepEqual((await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)')).slice(0, 5), weeklyNames);
    assert.equal(await evaluate('document.getElementById("explore-chips").textContent'), selectedChips);
    await key('Escape');
    await click('#activity-chart > details > summary'); await until('document.querySelectorAll(".activity-choice").length > 0');
    assert.equal(await evaluate('document.querySelectorAll("#activity-chart tbody tr").length'), 24, 'Hourly data table is paginated');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#activity-chart th"), item => item.textContent).slice(2, -4)'), await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)'), 'Table columns follow displayed names');
    await click('[aria-label="Next activity"]');
    assert.equal(await evaluate('document.querySelector(".activity-choice").dataset.bin'), '24');
    assert.match(await evaluate('document.querySelector(".activity-choice").getAttribute("aria-label")'), /12:00:00.*13:00:00.*exclusive/);
    await click('#activity-chart > details > summary');
    await chartScreenshot('weekly-expanded-desktop.png');
    const removedName = weeklyNames[0];
    const originalColors = await colors();
    await click('.trend-chooser summary');
    await until('document.activeElement.type === "search"');
    await toggleSkill(removedName);
    assert.equal(await evaluate('document.getElementById("explore-chips").textContent'), selectedChips);
    for (const [name, color] of Object.entries(await colors())) assert.equal(color, originalColors[name]);
    await searchSkills(removedName);
    await toggleSkill(removedName);
    assert.equal((await colors())[removedName], originalColors[removedName]);
    assert.equal(await evaluate('document.activeElement.dataset.skill'), removedName);
    assert.equal(await evaluate('document.querySelector(".trend-chooser input[type=search]").value'), removedName);
    assert.equal(await evaluate('document.getElementById("explore-chips").textContent'), selectedChips);
    await key('Escape');
    assert.equal(await evaluate('document.querySelector(".trend-chooser").open'), false);
    assert.equal(await evaluate('document.activeElement.tagName'), 'SUMMARY');
    const customNames = await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)');
    await evaluate('window.smokeNow += 3600123'); await click('#refresh-data'); await until(ready);
    assert.match(await evaluate('document.getElementById("scope-summary").textContent'), /2025-02-21T13:00:00.123Z/);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)'), customNames);
    assert.equal(await evaluate('document.getElementById("filter-form").checkValidity()'), true, 'Exact relative timestamps remain valid form values');
    await click('#filter-form button[type=submit]'); await until(ready);
    await change('from-filter', '2025-02-21T09:30'); await change('to-filter', '2025-02-21T11:30');
    await click('#filter-form button[type=submit]'); await until(ready);
    await evaluate('window.smokeNow += 3600000'); await click('#refresh-data'); await until(ready);
    assert.equal(await evaluate('document.getElementById("scope-summary").textContent'), '2025-02-21T09:30:00.000Z to 2025-02-21T11:30:00.000Z · UTC');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)'), customNames, 'Custom trend names survive scope changes without substitution');
    assert.deepEqual(await colors(), originalColors, 'Colors survive filtered refresh');
    await evaluate('document.querySelector(".trend-label").click()');
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), /Recent period/);
    assert.doesNotMatch(await evaluate('document.getElementById("explore-comparison").textContent'), /0 days|outside the current report/);
    await click('#explore-comparison .section-heading button');
    assert.match(await evaluate('document.querySelector(".brush-handle[data-mode=end]").getAttribute("aria-valuetext")'), /11:30:00.001 UTC/);
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /11:30:00.001/);
    const partialRange = await edgeValues();
    await evaluate('document.querySelector(".brush-band").focus()'); await key('ArrowLeft');
    const movedPartialRange = await edgeValues();
    assert.ok(Math.abs((movedPartialRange[1] - movedPartialRange[0]) - (partialRange[1] - partialRange[0])) < 1e-9, 'Keyboard movement preserves a partial-hour comparison duration');
    const partialActivity = await fetch(new URL('/api/dashboard?fromObservedAt=2025-02-21T09:30:00.000Z&toObservedAt=2025-02-21T11:30:00.000Z', rich.url)).then(response => response.json());
    await assertStack(partialActivity.report.activity);
    await evaluate('document.querySelector(".trend-plot").scrollIntoView({block:"center"})');
    const partialBand = await evaluate('(() => { const r=document.querySelector(".brush-band").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+20}; })()');
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...partialBand, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...partialBand, button: 'left', clickCount: 1 });
    assert.deepEqual(await edgeValues(), movedPartialRange, 'Clicking a comparison band without dragging does not shift its partial-hour edges');
    await change('from-filter', '2025-02-21T10:10'); await change('to-filter', '2025-02-21T10:40');
    await click('#filter-form button[type=submit]'); await until(ready);
    await click('.trend-label'); await click('#explore-comparison .section-heading button');
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /10:40:00.001/);
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".brush-handle")).every(item => Number(item.getAttribute("aria-valuenow")) >= Number(item.getAttribute("aria-valuemin")) && Number(item.getAttribute("aria-valuenow")) <= Number(item.getAttribute("aria-valuemax")))'), 'Sub-hour comparisons have valid accessible slider bounds');
    const shortRange = await edgeValues();
    await evaluate('document.querySelector(".brush-band").focus()'); await key('End');
    const shortAtEnd = await edgeValues();
    assert.ok(Math.abs((shortAtEnd[1] - shortAtEnd[0]) - (shortRange[1] - shortRange[0])) < 1e-9, 'Moving to the chart edge preserves sub-hour duration');
    assert.equal(shortAtEnd[1], 1);
    await evaluate('document.querySelector(".brush-handle[data-mode=start]").focus()'); await key('End');
    assert.ok((await edgeValues())[0] >= 0, 'Sub-hour handle controls stay within the chart extent');
    await change('from-filter', '2024-01-01T09:30'); await change('to-filter', '2024-01-01T11:30');
    await click('#filter-form button[type=submit]'); await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), '0');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)'), customNames, 'Absent custom names are retained without substitution');
    assert.equal(await evaluate('document.querySelector(".trend-controls").hidden'), false);
    await click('.trend-chooser summary');
    await until('document.activeElement.type === "search"');
    await searchSkills('');
    for (const name of customNames) {
      await toggleSkill(name);
      assert.equal(await evaluate('document.activeElement.dataset.skill'), name, 'Removing absent skills keeps keyboard focus');
    }
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 0);
    assert.match(await evaluate('document.getElementById("activity-chart").textContent'), /Select skills/);
    await toggleSkill(customNames[0]);
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 1, 'The same chooser recovers an empty selection');
    await toggleSkill(customNames[0]);
    await key('Escape');
    await click('#refresh-data'); await until(ready);
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 0, 'Empty custom selection survives refresh');
    await evaluate('window.smokeNow = Date.parse("2025-02-21T12:00:00.000Z")');
    await click('#reset-filters'); await until(ready);
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 5, 'Reset restores the default selection');
    assert.equal(await evaluate('document.getElementById("time-preset").value'), '7');
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), weekly.report.counts.successfulReads.toLocaleString('en-US'));
    await evaluate('document.querySelector(".trend-plot").scrollIntoView({block:"center"})');
    const hourlyBox = await evaluate('(() => {const r=document.querySelector(".trend-plot").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const hourlyMouse = async (type, hour) => command('Input.dispatchMouseEvent', { type, x: hourlyBox.x + hour / 169 * hourlyBox.width, y: hourlyBox.y + hourlyBox.height / 2, button: 'left', clickCount: 1 });
    await hourlyMouse('mousePressed', 80.2); await hourlyMouse('mouseMoved', 90.8); await hourlyMouse('mouseReleased', 90.8);
    assert.deepEqual(await edgeValues(), [80, 91]);
    await hourlyMouse('mousePressed', 85); await hourlyMouse('mouseMoved', 95); await hourlyMouse('mouseReleased', 95);
    assert.deepEqual(await edgeValues(), [90, 101]);
    await hourlyMouse('mousePressed', 101); await hourlyMouse('mouseMoved', 104.8); await hourlyMouse('mouseReleased', 104.8);
    assert.deepEqual(await edgeValues(), [90, 105]);
    await hourlyMouse('mousePressed', 95); await hourlyMouse('mouseMoved', 110); await key('Escape'); await hourlyMouse('mouseReleased', 110);
    assert.deepEqual(await edgeValues(), [90, 105]);
    await chartScreenshot('weekly-brush-desktop.png');
    for (const width of [390, 320]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await noOverflow(); await chartScreenshot('weekly-' + width + '.png');
    }
    await command('Emulation.setTouchEmulationEnabled', { enabled: true });
    await click('#clear-explorer');
    await evaluate('document.querySelector(".trend-plot").scrollIntoView({block:"center"})');
    const hourlyTouchBox = await evaluate('(() => { const r=document.querySelector(".trend-plot").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width}; })()');
    const hourlyTouchPoint = hour => ({ x: hourlyTouchBox.x + hour / 169 * hourlyTouchBox.width, y: hourlyTouchBox.y + 60, id: 0 });
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hourlyTouchPoint(40.2)] });
    await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [hourlyTouchPoint(75.8)] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual(await edgeValues(), [40, 76], 'Touch brushing selects UTC hours in the weekly chart');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [hourlyTouchPoint(55)] });
    await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [hourlyTouchPoint(75)] });
    await command('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.deepEqual(await edgeValues(), [40, 76], 'Cancelling an hourly touch move restores the committed range');
    assert.equal(await evaluate('document.querySelector(".trend-plot").dataset.dragging'), 'false');
    await chartScreenshot('weekly-touch-320.png');
    await evaluate('document.querySelector(".trend-chooser summary").scrollIntoView({block:"center"})');
    const chooserPoint = await evaluate('(() => {const r=document.querySelector(".trend-chooser summary").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...chooserPoint, id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until('document.querySelector(".trend-chooser").open');
    await evaluate(`document.querySelector('.trend-chooser input').value = ${JSON.stringify(weeklyNames[0])}; document.querySelector('.trend-chooser input').dispatchEvent(new Event('input'));`);
    await toggleSkill(weeklyNames[0]);
    await toggleSkill(weeklyNames[0]);
    await noOverflow(); await chartScreenshot('weekly-chooser-320.png');
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await click('#reset-filters'); await until(ready);
    await change('time-preset', 'all'); await until(ready);

    assert.equal(await evaluate('document.getElementById("time-preset").value'), "all", "All time recovers historical data");
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
    await click('#activity-chart > details > summary');
    await until('document.querySelectorAll("#activity-chart tbody tr").length > 0');
    assert.equal(await evaluate('document.querySelectorAll("#activity-chart tbody tr").length'), payload.report.activity.bins.length);
    await click('#activity-chart > details > summary');
    measurements.renderedNodes = await evaluate('document.querySelectorAll("*").length');
    assert.ok(measurements.renderedNodes < 3000, "Bounded initial rendering for 111 paths");
    await noOverflow();
    await screenshot(join(directory, "overview-desktop.png"));
    await chartScreenshot('trends-desktop-detail.png');
    assert.equal(await evaluate('document.getElementById("activity-heading").textContent'), 'Skill trends');
    const shownSkills = await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)');
    assert.equal(shownSkills.length, 5, 'Five layers share one count axis');
    await assertStack(payload.report.activity);
    const offChart = payload.report.skillGroups.filter(group => group.counts.successfulReads > 0).find(group => !shownSkills.includes(group.name)).name;
    await evaluate(`Array.from(document.querySelectorAll("#skill-table button.link")).find(item => item.textContent === ${JSON.stringify(offChart)}).click()`);
    assert.ok((await evaluate('Array.from(document.querySelectorAll(".trend-label"), item => item.dataset.skill)')).includes(offChart), 'Selecting a less frequent skill brings its trend into view');
    assert.equal(await evaluate('document.querySelectorAll(".trend-label").length'), 6, 'Exploring an off-chart skill never evicts a row');
    assert.equal(await evaluate('document.querySelectorAll(".trend-label[aria-pressed=true]").length'), 1);
    await click('#clear-explorer');
    await click('#activity-chart > details > summary'); await until('document.querySelectorAll(".activity-choice").length > 0'); await click('#activity-chart > details > summary');

    const exploreSkill = await evaluate('document.querySelector("#skill-table button.link").textContent');
    const matching = payload.report.routes.filter(route => route.steps.some(step => step.kind === 'observations' && step.items.some(item => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success' && item.evidence.skill.name === exploreSkill)));
    await click('#skill-table button.link');
    assert.equal(await evaluate('document.activeElement.id'), 'explorer-panel', 'Selection moves keyboard focus to its details');
    assert.equal(await evaluate('document.getElementById("models-workspace").hidden'), true, 'Ranked skill opens the linked explorer');
    assert.equal(await evaluate('document.getElementById("explorer-panel").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#explore-totals strong").textContent'), String(matching.length));
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), /Recent period vs previous period/);
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
    assert.equal(await evaluate('document.querySelectorAll(".activity-choice[aria-pressed=true]").length'), 7);
    await click('.trend-label[aria-pressed=true]');
    assert.equal(await evaluate('document.querySelectorAll(".trend-label[aria-pressed=true]").length'), 0, 'A named trend toggles the linked skill selection');
    assert.equal(await evaluate('document.querySelectorAll(".activity-choice[aria-pressed=true]").length'), 7, 'Changing skills retains the selected interval');
    await evaluate(`Array.from(document.querySelectorAll(".trend-label")).find(item => item.dataset.skill === ${JSON.stringify(exploreSkill)}).click()`);
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
    assert.equal(await evaluate('document.querySelectorAll(".activity-choice[aria-pressed=true]").length'), 7);
    await noOverflow();
    await screenshot(join(directory, 'explorer-desktop.png'));
    await click('#clear-explorer');
    assert.equal(await evaluate('document.getElementById("explorer-panel").hidden'), true);
    assert.equal(await evaluate('document.activeElement.id'), 'activity-heading');
    await click('[data-workspace=paths]');
    assert.equal(await evaluate('document.getElementById("path-focus-label").textContent'), 'All session paths', 'Clearing exploration clears its path focus');
    assert.equal(await evaluate('document.getElementById("back-to-explorer").hidden'), true);
    await click('[data-workspace=overview]');

    await evaluate('document.querySelector(".trend-plot").scrollIntoView({block:"center"})');
    const plotBox = await evaluate('(() => { const r=document.querySelector(".trend-plot").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()');
    const chartPoint = day => ({ x: plotBox.x + day / 21 * plotBox.width, y: plotBox.y + plotBox.height / 2 });
    async function mouse(type, day, button = 'left') { await command('Input.dispatchMouseEvent', { type, ...chartPoint(day), button, clickCount: 1 }); }
    const selection = () => evaluate('Array.from(document.querySelectorAll(".activity-choice[aria-pressed=true]"), item => item.textContent)');
    await mouse('mousePressed', 14.2);
    await mouse('mouseMoved', 15.1);
    const earlyWidth = await evaluate('document.querySelector(".brush-band").getBoundingClientRect().width');
    await mouse('mouseMoved', 15.4);
    const laterWidth = await evaluate('document.querySelector(".brush-band").getBoundingClientRect().width');
    assert.ok(laterWidth > earlyWidth + 1, 'Brush follows movement within a time bucket, not just at bucket edges');
    assert.equal(await evaluate('document.querySelectorAll(".brush-band").length'), 1, 'One continuous band spans the plot');
    assert.equal(await evaluate('document.querySelectorAll(".activity-hit").length'), 0, 'No outlined per-bar selection');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".trend-plot")).outlineStyle'), 'none', 'Pointer brushing does not outline the entire chart');
    assert.equal((await selection()).length, 0, 'Dragging does not rebuild the explorer before release');
    await screenshot(join(directory, 'brush-drag-desktop.png'));
    await chartScreenshot('brush-drag-detail.png');
    await mouse('mouseMoved', 17.8); await mouse('mouseReleased', 17.8);
    assert.equal((await selection()).length, 4, 'Pointer drag commits complete UTC days');
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /UTC:/);
    await mouse('mousePressed', 16); await mouse('mouseMoved', 13); await mouse('mouseReleased', 13);
    assert.equal((await selection()).length, 4, 'Dragging the band preserves its duration');
    assert.match((await selection())[0], /Feb 12/);
    await mouse('mousePressed', 15.2); await mouse('mouseReleased', 15.2);
    assert.equal((await selection()).length, 4, 'An off-center click on a handle does not jump its date');
    await mouse('mousePressed', 15.2); await mouse('mouseMoved', 17.4); await mouse('mouseReleased', 17.4);
    assert.equal((await selection()).length, 7, 'Dragging the end handle resizes the range from its original edge');
    const beforeCancel = await selection();
    await mouse('mousePressed', 11); await mouse('mouseMoved', 9.1);
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await mouse('mouseReleased', 9.1);
    assert.deepEqual(await selection(), beforeCancel, 'Escape cancels a drag without changing the selection');
    assert.equal(await evaluate('document.querySelector(".trend-plot").dataset.dragging'), 'false');
    await mouse('mousePressed', 20.8); await mouse('mouseMoved', 18.2); await mouse('mouseReleased', 18.2);
    assert.equal((await selection()).length, 3, 'Reverse drag selects the same continuous interval');
    await evaluate('document.querySelector(".brush-handle[data-mode=end]").focus()');
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    assert.equal((await selection()).length, 2, 'Keyboard resizes the focused range edge by one day');
    assert.ok(await evaluate('getComputedStyle(document.activeElement).outlineStyle !== "none"'), 'Range handle has visible keyboard focus');
    await evaluate('document.querySelector(".trend-plot").focus()');
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await enter();
    assert.equal((await selection()).length, 1, 'Keyboard selects the inspected interval');
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    assert.equal((await selection()).length, 2, 'Shift+Enter extends the range');
    await evaluate('document.querySelector(".brush-band").focus()');
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    assert.match((await selection())[0], /Feb 2/);
    assert.equal((await selection()).length, 2, 'Keyboard moves the whole band without changing duration');
    await click('#activity-chart > details > summary');
    await click('#activity-chart .activity-choice');
    assert.match(await evaluate('document.getElementById("explore-comparison").textContent'), /outside the current report/, 'The first date has no loaded baseline');
    await click('#clear-explorer');
    await click('#activity-chart > details > summary');

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
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#chain-view dl dt"), item => item.textContent)'), ['Agent host', 'Machine', 'Account source', 'Project', 'Session ID', 'Segment ID', 'Run ID']);
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
    await evaluate('window.smokeNow = Date.parse("2026-01-01T12:00:00.000Z")');
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
    await change('time-preset', 'all'); await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    assert.equal(await evaluate('document.getElementById("scope-summary").hidden'), true, 'All time hides the date summary after Reset');
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
    await change('time-preset', 'all'); await until(ready);
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
    await change('time-preset', 'all'); await until(ready);
    await helpFromEveryTab();
    await click('[data-workspace=overview]');
    await click('#activity-chart > details > summary'); await until('document.querySelectorAll(".activity-choice").length > 0'); await click('#activity-chart > details > summary');
    await noOverflow();
    await screenshot(join(directory, "overview-mobile.png"));
    await command('Emulation.setTouchEmulationEnabled', { enabled: true });
    await evaluate('document.querySelector(".trend-plot").scrollIntoView({block:"center"})');
    const mobilePoints = await evaluate('(() => { const r=document.querySelector(".trend-plot").getBoundingClientRect(); return [14.2,16.8].map(day => ({x:r.x+day/21*r.width,y:r.y+r.height/2})); })()');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...mobilePoints[0], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...mobilePoints[1], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal((await selection()).length, 3, 'Touch drag selects a range');
    await screenshot(join(directory, 'brush-mobile.png'));
    await chartScreenshot('trends-mobile-detail.png');
    const touchSelection = await selection();
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...mobilePoints[0], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...mobilePoints[1], id: 0 }] });
    await command('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.deepEqual(await selection(), touchSelection, 'Touch cancellation preserves the committed range');
    assert.equal(await evaluate('document.querySelector(".trend-plot").dataset.dragging'), 'false');
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
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(manySkillsPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready); await click('[data-workspace=overview]');
    await evaluate('document.querySelector(".trend-chooser summary").focus()'); await enter();
    await until('document.activeElement.type === "search"');
    await evaluate('document.activeElement.value = "chooser-"; document.activeElement.dispatchEvent(new Event("input", { bubbles: true }))');
    assert.equal(await evaluate('document.querySelectorAll(".trend-options input[type=checkbox]").length'), 20);
    for (const firstNewName of ['chooser-20', 'chooser-40']) {
      await evaluate('Array.from(document.querySelectorAll(".trend-options button")).find(item => item.textContent === "More results").focus()');
      await enter();
      await toggleSkill(firstNewName);
      assert.equal(await evaluate('document.activeElement.dataset.skill'), firstNewName);
      assert.equal(await evaluate('document.querySelector(".trend-chooser input[type=search]").value'), 'chooser-');
    }
    assert.equal(await evaluate('document.querySelectorAll(".trend-options input[type=checkbox]").length'), 45);
    for (let index = 0; index < 10; index++) await toggleSkill('chooser-' + String(index).padStart(2, '0'));
    await assertStack(manySkillsPayload.report.activity);
    const manyColors = Object.values(await colors());
    assert.ok(manyColors.length >= 12);
    assert.equal(new Set(manyColors).size, manyColors.length, 'Selected skills do not reuse colors');
    await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
    await noOverflow(); await chartScreenshot('many-skills-chooser-320.png');
    await key('Escape'); await noOverflow();
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(catalogOnlyPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    assert.equal(await evaluate('document.querySelector(".trend-controls").hidden'), false, 'Absent selections stay removable without dated activity');
    assert.equal(await evaluate('document.querySelector(".trend-chooser summary").getClientRects().length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".trend-plot").length'), 0);
    assert.match(await evaluate('document.getElementById("activity-chart").textContent'), /No activity recorded yet/);
    await click('#catalog-context summary');
    assert.ok(await evaluate('document.querySelectorAll("#catalog-list button.link").length > 0'), 'Catalog-only reports retain their catalog');
    await noOverflow(); await chartScreenshot('catalog-only-mobile.png');
    await evaluate('window.fetch = window.smokeFetch; document.getElementById("reset-filters").click()'); await until(ready);
    await change('time-preset', 'all'); await until(ready);
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(repeatedPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await click('[data-workspace=overview]');
    await evaluate('Array.from(document.querySelectorAll("#skill-table button.link")).find(item => item.textContent === "mako").click()');
    await click('#activity-chart > details > summary');
    await evaluate('document.querySelector(".trend-plot").focus()'); await key('End'); await enter();
    await evaluate('document.querySelector(".brush-handle[data-mode=start]").focus()');
    for (let hour = 0; hour < 23; hour++) await key('ArrowLeft');
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
    await assertStack(repeatedPayload.report.activity);
    assert.equal(repeatedPayload.report.activity.bins[34].skills.find(skill => skill.name === 'mako').successfulReads, 2);
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(sparsePayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await assertStack(sparsePayload.report.activity);
    assert.equal(sparsePayload.report.activity.bins[1].counts.successfulReads, 0, 'Sparse fixture includes a zero interval');
    await evaluate('document.querySelector(".trend-plot").focus()');
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    assert.match(await evaluate('document.querySelector(".trend-label small").textContent'), /0 reads/);
    await screenshot(join(directory, 'trends-gap-mobile.png'));
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(oneBinPayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    assert.equal(oneBinPayload.report.activity.bins.length, 1);
    await assertStack(oneBinPayload.report.activity);
    await chartScreenshot('one-bin-mobile.png');
    const adaptive = adaptivePayload.report.activity;
    assert.ok(adaptive.binWidthMs > 86400000, 'Fixture uses adaptive multi-day bins');
    assert.ok(Date.parse(adaptive.bins.at(-1).endAt) - Date.parse(adaptive.bins.at(-1).startAt) < adaptive.binWidthMs, 'Final adaptive interval is shorter');
    await evaluate(`window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(adaptivePayload)})); document.getElementById('refresh-data').click();`);
    await until(ready);
    await assertStack(adaptive);

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

    await command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.smokeNow = Date.parse("2026-01-01T12:00:00.000Z");' });
    await command('Page.navigate', { url: rich.url }); await until(ready);
    assert.equal(await evaluate('document.getElementById("time-preset").value'), '7');
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), '0', 'Historical database starts with an honest empty week');
    await noOverflow(); await screenshot(join(directory, 'historical-empty-week.png'));
    await change('time-preset', 'all'); await until(ready);
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString('en-US'), 'All time recovers historical data');
    await command("Page.navigate", { url: empty.url });
    await until(ready);
    await change('time-preset', 'all'); await until(ready);
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
