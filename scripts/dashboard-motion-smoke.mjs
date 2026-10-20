import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectMetrics } from "../dist/src/dashboard/metrics.js";
import { withBrowser } from "./browser-smoke.mjs";
import { startDashboardPreview } from "./dashboard-preview.mjs";

function readEffects(selector) {
  const root = selector ? document.querySelector(selector) : document;
  return document.getAnimations().flatMap(animation => {
    const effect = animation.effect;
    const target = effect?.target;
    if (!(target instanceof Element) || !root?.contains(target)) return [];
    const computed = effect.getComputedTiming();
    const style = getComputedStyle(target, effect.pseudoElement || null);
    const rect = target.getBoundingClientRect();
    const keyframes = effect.getKeyframes();
    const properties = [...new Set(keyframes.flatMap(frame => Object.keys(frame)))].filter(name => !["offset", "computedOffset", "easing", "composite"].includes(name));
    return [{
      target: [target.tagName.toLowerCase(), target.getAttribute("class"), target.closest(".timeline-step")?.dataset.stepIndex, effect.pseudoElement].filter(Boolean).join(" "),
      properties,
      endpoints: [keyframes[0], keyframes.at(-1)],
      playState: animation.playState,
      progress: computed.progress,
      endTime: computed.endTime,
      finite: Number.isFinite(computed.endTime) && Number.isFinite(effect.getTiming().iterations),
      opacity: style.opacity,
      transform: style.transform,
      clipPath: style.clipPath,
      width: style.width,
      height: style.height,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }];
  });
}

function readMarker() {
  const marker = document.querySelector(".workspace-indicator");
  const selected = document.querySelector("[data-workspace][aria-current=page]");
  const box = element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  return { marker: marker ? box(marker) : null, selected: selected?.dataset.workspace, destination: selected ? box(selected) : null };
}

function readRows() {
  return Array.from(document.querySelectorAll("#skill-table .rank-row"), row => ({
    name: row.querySelector("button.link").textContent,
    count: Number(row.querySelector("strong button").textContent.replaceAll(",", "")),
    y: row.getBoundingClientRect().y,
  }));
}

function readTimeline() {
  return Array.from(document.querySelectorAll("#chain-view .timeline-step"), item => ({
    index: Number(item.dataset.stepIndex),
    gap: item.classList.contains("gap"),
    names: Array.from(item.querySelectorAll(".observation > strong"), name => name.textContent),
    text: item.querySelector(".gap-card")?.textContent || null,
  }));
}

const probeSource = `const effects = ${readEffects.toString()}; const marker = ${readMarker.toString()}; const rows = ${readRows.toString()}; const timeline = ${readTimeline.toString()}; const frame = () => new Promise(resolve => requestAnimationFrame(resolve));`;
const directory = process.env.HOTPLATE_SCREENSHOT_DIR ? resolve(process.env.HOTPLATE_SCREENSHOT_DIR) : await mkdtemp(join(tmpdir(), "hotplate-motion-smoke-"));
await mkdir(directory, { recursive: true });
const summary = { fixtureNow: "2025-02-21T12:00:00.000Z", screenshots: [], observations: {}, longestSettleMs: 0 };
const preview = await startDashboardPreview({ now: new Date(summary.fixtureNow) });
try {
  const payload = await fetch(new URL("/api/dashboard", preview.url)).then(response => response.json());
  assert.equal(payload.kind, "ready");
  const projection = projectMetrics(payload.report, { measure: "successfulReads", split: "skill", display: "count" });
  const expectedRows = query => projection.skills.filter(row => row.count > 0 && row.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(({ name, count }) => ({ name, count }));
  const skillNames = new Map(payload.report.skills.map(skill => [skill.key, skill.identity.name]));

  await withBrowser(async ({ command, evaluate, until, errors }) => {
    const probe = body => evaluate(`(async () => { ${probeSource} ${body} })()`);
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const change = (id, value, event = "change") => evaluate(`{ const control = document.getElementById(${JSON.stringify(id)}); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); }`);
    const media = value => command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
    const currentEffects = selector => probe(`return effects(${JSON.stringify(selector)});`);
    async function settle() {
      const started = Date.now();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate("document.getAnimations().length === 0")) {
          summary.longestSettleMs = Math.max(summary.longestSettleMs, Date.now() - started);
          return;
        }
        await delay(50);
      }
      assert.fail(`Motion did not settle within five seconds: ${JSON.stringify(await currentEffects())}`);
    }
    async function capture(name) {
      const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(directory, name), Buffer.from(result.data, "base64"));
      summary.screenshots.push(name);
    }
    async function markerAligned() {
      const value = await probe("return marker();");
      assert.ok(value.marker && value.destination, "The active workspace has a decorative navigation marker");
      assert.ok(Math.abs(value.marker.x - value.destination.x) <= 2, "Navigation marker aligns with the selected tab");
      assert.ok(Math.abs(value.marker.width - value.destination.width) <= 2, "Navigation marker spans the selected tab");
      return value;
    }
    function finite(effects, message) {
      assert.ok(effects.length > 0, message);
      assert.ok(effects.every(effect => effect.finite && effect.endTime <= 5000), "Every observed effect is finite and bounded");
    }
    async function sample(body, count = 12) {
      return probe(`const samples = []; for (let index = 0; index < ${count}; index += 1) { await frame(); samples.push(${body}); } return samples;`);
    }
    async function key(name) {
      const windowsVirtualKeyCode = { Home: 36, ArrowRight: 39, Enter: 13 }[name];
      await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode });
    }
    async function assertRows(query) {
      assert.deepEqual((await probe("return rows();")).map(({ name, count }) => ({ name, count })), expectedRows(query), "Rendered skill names and counts match the real report");
    }
    async function assertTimeline(route) {
      const actual = await probe("return timeline();");
      assert.deepEqual(actual.map(({ index, gap, names }) => ({ index, gap, names })), route.steps.slice(0, 30).map((step, index) => ({
        index, gap: step.kind === "gap", names: step.kind === "gap" ? [] : step.items.map(item => skillNames.get(item.skillKey) || "Unknown skill"),
      })), "Motion preserves recorded step order, simultaneous groups, and gaps");
      for (const item of actual.filter(item => item.gap)) assert.ok(item.text, "Capture gaps remain explicit content");
      return actual;
    }

    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await media("reduce");
    await command("Page.navigate", { url: preview.url });
    await until(ready);
    assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
    assert.equal(await evaluate("document.getAnimations().length"), 0, "Reduced motion suppresses effects at initial load");
    await change("time-preset", "all");
    await until(ready);
    await click("[data-workspace=resources]");
    await click("[data-workspace=metrics]");
    await click("#toggle-filters");
    await click("#toggle-filters");
    await probe("await frame(); return true;");
    assert.equal(await evaluate("document.getAnimations().length"), 0, "Reduced-motion actions remain immediate");
    await assertRows("");
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"));
    summary.observations.initialReducedMotion = { effects: 0, successfulReads: payload.report.counts.successfulReads };

    await media("no-preference");
    await probe("await frame(); return true;");
    const navStart = await markerAligned();
    await click("[data-workspace=paths]");
    const firstPathEffects = await currentEffects("#chain-view");
    finite(firstPathEffects, "The first Paths visit animates its initially hidden timeline");
    const navSamples = await sample("marker()");
    await capture("motion-navigation-intermediate-desktop.png");
    await settle();
    const navEnd = await markerAligned();
    assert.equal(navEnd.selected, "paths");
    const left = Math.min(navStart.marker.x, navEnd.marker.x);
    const right = Math.max(navStart.marker.x, navEnd.marker.x);
    assert.ok(navSamples.some(value => value.marker.x > left + 1 && value.marker.x < right - 1), "Navigation marker visits an intermediate position");
    const initialRouteKey = await evaluate('document.getElementById("chain-view").dataset.routeKey');
    await assertTimeline(payload.report.routes.find(route => route.key === initialRouteKey));
    await click("[data-workspace=paths]");
    await probe("await frame(); return true;");
    assert.equal(await evaluate("document.getAnimations().length"), 0, "Clicking the selected workspace does not replay motion");
    await click(".route-choice[aria-pressed=true]");
    await probe("await frame(); return true;");
    assert.equal((await currentEffects("#chain-view")).length, 0, "Clicking the selected route does not replay its trace");
    assert.equal(await evaluate("document.activeElement.id"), "chain-view", "Route focus is available synchronously");
    summary.observations.navigation = { from: navStart, intermediate: navSamples.filter((_, index) => index % 3 === 0), to: navEnd, firstPathEffectCount: firstPathEffects.length };

    const rapidStates = await probe(`const states = []; for (const workspace of ['resources', 'metrics', 'paths', 'resources']) {
      document.querySelector('[data-workspace=' + workspace + ']').click();
      states.push({ expected: workspace, current: document.querySelector('[data-workspace][aria-current=page]')?.dataset.workspace,
        visible: ['metrics', 'paths', 'resources'].filter(name => !document.getElementById(name + '-workspace').hidden) });
    } return states;`);
    for (const state of rapidStates) {
      assert.equal(state.current, state.expected, "Rapid navigation updates ARIA state immediately");
      assert.deepEqual(state.visible, [state.expected], "Rapid navigation exposes only the latest workspace");
    }
    await settle();
    await markerAligned();
    summary.observations.rapidNavigation = rapidStates;

    await click("[data-workspace=metrics]");
    await settle();
    await evaluate('document.getElementById("skill-table").scrollIntoView({ block: "center" })');
    const beforeRows = await probe("return rows();");
    assert.ok(beforeRows.length >= 3, "Fixture has enough ranked skills to observe movement");
    const retained = beforeRows[2];
    await change("skill-search", retained.name, "input");
    await assertRows(retained.name);
    const rowSamples = await sample(`rows().find(row => row.name === ${JSON.stringify(retained.name)})`);
    await capture("motion-rows-intermediate-desktop.png");
    await settle();
    const afterRow = (await probe("return rows();")).find(row => row.name === retained.name);
    const low = Math.min(retained.y, afterRow.y);
    const high = Math.max(retained.y, afterRow.y);
    assert.ok(high - low > 8, "Filtering changes a retained skill's position");
    assert.ok(rowSamples.some(row => row && row.y > low + 1 && row.y < high - 1), "The same skill moves through intermediate positions");
    await change("skill-search", "", "input");
    await change("skill-search", retained.name.slice(0, 2), "input");
    await change("skill-search", "", "input");
    await assertRows("");
    await settle();
    await assertRows("");
    summary.observations.rowMovement = { name: retained.name, fromY: retained.y, intermediateY: rowSamples.map(row => row?.y), toY: afterRow.y };

    await evaluate('document.querySelector(".trend-plot").scrollIntoView({ block: "center" })');
    const initialPaths = await evaluate('Array.from(document.querySelectorAll(".trend-area"), path => ({ name: path.dataset.skill, d: path.getAttribute("d") }))');
    await change("metric-measure", "failedReads");
    const chartEffects = await currentEffects("#activity-chart");
    finite(chartEffects, "A changed metric starts chart reveal effects");
    assert.ok(chartEffects.every(effect => effect.endTime <= 1000), "Chart reveals settle within one second including series staggering");
    assert.ok(chartEffects.some(effect => effect.properties.includes("clipPath") || effect.properties.includes("width") || (effect.properties.includes("transform") && effect.endpoints.some(frame => /scale|matrix/.test(frame?.transform || "")))), "The chart reveal changes clipping or horizontal geometry");
    const chartSamples = await sample("effects('#activity-chart')", 8);
    assert.ok(chartSamples.flat().some(effect => effect.progress > 0 && effect.progress < 1), "Chart reveal visibly advances before completion");
    assert.ok(new Set(chartSamples.map(effects => JSON.stringify(effects.map(effect => [effect.clipPath, effect.transform, effect.width])))).size > 1, "Rendered chart reveal geometry changes across frames");
    await capture("motion-chart-intermediate-desktop.png");
    await settle();
    await change("metric-measure", "successfulReads");
    const brushBox = await evaluate('(() => { const box = document.querySelector(".trend-plot").getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()');
    const pointer = (type, fraction) => command("Input.dispatchMouseEvent", { type, x: brushBox.x + brushBox.width * fraction, y: brushBox.y + brushBox.height / 2, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await pointer("mousePressed", 0.15);
    await pointer("mouseMoved", 0.35);
    const earlyBand = await evaluate('document.querySelector(".brush-band").getBoundingClientRect().width');
    assert.ok(Math.abs(earlyBand - brushBox.width * 0.2) < 3, "Brush geometry follows the pointer immediately during chart reveal");
    await pointer("mouseMoved", 0.55);
    const laterBand = await evaluate('document.querySelector(".brush-band").getBoundingClientRect().width');
    assert.ok(Math.abs(laterBand - brushBox.width * 0.4) < 3 && laterBand > earlyBand, "The active brush follows subsequent pointer movement");
    assert.equal((await currentEffects()).some(effect => /brush-band|brush-handle|brush-shade|trend-cursor|^div trend-plot(?: |$)/.test(effect.target)), false, "Brush, cursor, and plot never receive interpolated motion");
    await pointer("mouseReleased", 0.55);
    assert.match(await evaluate('document.getElementById("explore-chips").textContent'), /UTC:/);
    const edgeValues = () => evaluate('Array.from(document.querySelectorAll(".brush-handle"), handle => Number(handle.getAttribute("aria-valuenow")))');
    const beforeKeyboard = await edgeValues();
    await evaluate('document.querySelector(".brush-band").focus()');
    await key("ArrowRight");
    const afterKeyboard = await edgeValues();
    assert.deepEqual(afterKeyboard, beforeKeyboard.map(value => value + 1), "Keyboard moves the selected interval immediately by one step");
    assert.equal(await evaluate('document.activeElement.classList.contains("brush-band")'), true, "Keyboard selection keeps focus on the brush");
    await click("#clear-explorer");
    await settle();
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".trend-area"), path => ({ name: path.dataset.skill, d: path.getAttribute("d") }))'), initialPaths, "Settled chart retains the exact successful-read series and geometry");
    summary.observations.chartAndBrush = { revealProperties: chartEffects.map(effect => effect.properties), intermediateProgress: chartSamples.map(effects => effects.map(effect => effect.progress)), pointerWidths: [earlyBand, laterBand], beforeKeyboard, afterKeyboard };

    await click("[data-workspace=paths]");
    await settle();
    const targetRouteIndex = payload.report.routes.findIndex(route => route.steps.some(step => step.kind === "gap") && route.steps.some(step => step.kind === "observations" && step.items.length > 1));
    assert.ok(targetRouteIndex >= 0, "Fixture has a route containing both simultaneous reads and a capture gap");
    for (let page = 0; page < Math.floor(targetRouteIndex / 8); page += 1) await click('#route-pagination [aria-label="Next routes"]');
    const targetRoute = payload.report.routes[targetRouteIndex];
    await evaluate(`Array.from(document.querySelectorAll('.route-choice')).find(choice => choice.dataset.routeKey === ${JSON.stringify(targetRoute.key)}).click()`);
    assert.equal(await evaluate('document.getElementById("chain-view").dataset.routeKey'), targetRoute.key);
    assert.equal(await evaluate("document.activeElement.id"), "chain-view", "Route selection focuses detail before motion finishes");
    const routeEffects = await currentEffects("#chain-view");
    finite(routeEffects, "Selecting another route starts finite connector, tip, and arrival effects");
    assert.ok(routeEffects.some(effect => effect.properties.includes("opacity")), "Route choreography acknowledges arrivals");
    assert.ok(routeEffects.some(effect => effect.properties.some(property => ["transform", "height", "clipPath", "offsetDistance"].includes(property))), "Route choreography includes traveling geometry");
    const routeFrames = await sample("effects('#chain-view')", 20);
    assert.ok(routeFrames.flat().some(effect => effect.progress > 0 && effect.progress < 1), "Route motion visibly advances through intermediate frames");
    assert.ok(new Set(routeFrames.map(effects => JSON.stringify(effects.map(effect => [effect.target, effect.rect.y, effect.transform, effect.opacity, effect.height])))).size > 1, "Connector/tip/arrival presentation changes while recorded content remains available");
    await capture("motion-route-intermediate-desktop.png");
    const timelineDuring = await assertTimeline(targetRoute);
    await settle();
    assert.deepEqual(await assertTimeline(targetRoute), timelineDuring);
    await click(".route-choice[aria-pressed=true]");
    await probe("await frame(); return true;");
    assert.equal((await currentEffects("#chain-view")).length, 0, "A repeated route selection leaves its completed trace still");
    summary.observations.routeTrace = { routeKey: targetRoute.key, groups: timelineDuring, effects: routeEffects.map(effect => ({ target: effect.target, properties: effect.properties })), frameEffectCounts: routeFrames.map(effects => effects.length) };

    const disclosureDuringTrace = await probe(`
      const selectedKey = document.getElementById('chain-view').dataset.routeKey;
      const anotherRoute = Array.from(document.querySelectorAll('.route-choice')).find(choice => choice.dataset.routeKey !== selectedKey);
      if (!anotherRoute) throw new Error('Fixture needs another visible route for disclosure interruption');
      anotherRoute.click();
      Array.from(document.querySelectorAll('.route-choice')).find(choice => choice.dataset.routeKey === selectedKey).click();
      const chain = document.getElementById('chain-view');
      const before = effects('#chain-view');
      const details = Array.from(chain.querySelectorAll('details')).find(item => item.querySelector('summary')?.textContent === 'Record details')
        || Array.from(chain.querySelectorAll('details')).find(item => item.querySelector('summary')?.textContent === 'Session details');
      if (!details) throw new Error('Selected route has no record or session disclosure');
      const control = details.querySelector('summary');
      const closedHeight = details.getBoundingClientRect().height;
      control.focus(); control.click();
      const immediateOpen = details.open;
      await frame(); await frame();
      const remaining = document.getAnimations().filter(animation => animation.effect?.target instanceof Element && chain.contains(animation.effect.target));
      return { before, title: control.textContent, immediateOpen, open: details.open,
        content: Array.from(details.children).filter(child => child !== control).map(child => child.textContent).join(' '),
        contentHasBounds: Array.from(details.children).filter(child => child !== control).some(child => child.getBoundingClientRect().height > 0),
        closedHeight, focused: document.activeElement === control,
        overlays: chain.querySelectorAll('.timeline-trace').length,
        traceEffects: remaining.filter(animation => animation.effect.target.closest('.timeline-trace') || animation.effect.target.matches('.step-group')).length,
        remainingAreLocal: remaining.every(animation => details.contains(animation.effect.target)),
        remaining: effects('#chain-view') };
    `);
    finite(disclosureDuringTrace.before, "A fresh route trace is active when its disclosure opens");
    assert.equal(disclosureDuringTrace.immediateOpen, true, "Record disclosure opens immediately during a route trace");
    assert.equal(disclosureDuringTrace.open, true);
    assert.equal(disclosureDuringTrace.focused, true, "Opening recorded details preserves summary focus");
    assert.ok(disclosureDuringTrace.content.trim() && disclosureDuringTrace.contentHasBounds, "Recorded disclosure content stays available during expansion");
    assert.equal(disclosureDuringTrace.overlays, 0, "Expanding route content removes the trace overlay before its geometry can drift");
    assert.equal(disclosureDuringTrace.traceEffects, 0, "Expanding route content cancels connector, tip, and arrival effects");
    assert.equal(disclosureDuringTrace.remainingAreLocal, true, "Only the disclosure's own effects may continue inside route detail");
    assert.ok(disclosureDuringTrace.remaining.every(effect => effect.finite && effect.endTime <= 5000), "Disclosure expansion remains finite");
    await settle();
    const expandedDisclosure = await evaluate(`(() => {
      const details = Array.from(document.querySelectorAll('#chain-view details')).find(item => item.querySelector('summary')?.textContent === ${JSON.stringify(disclosureDuringTrace.title)});
      return { open: details.open, height: details.getBoundingClientRect().height,
        content: Array.from(details.children).filter(child => child.tagName !== 'SUMMARY').map(child => child.textContent).join(' ') };
    })()`);
    assert.equal(expandedDisclosure.open, true);
    assert.ok(expandedDisclosure.height > disclosureDuringTrace.closedHeight, "Recorded details settle into their expanded layout");
    assert.equal(expandedDisclosure.content, disclosureDuringTrace.content, "Trace cancellation preserves the disclosed record content");
    assert.deepEqual(await assertTimeline(targetRoute), timelineDuring);
    summary.observations.disclosureDuringTrace = { title: disclosureDuringTrace.title, initialEffects: disclosureDuringTrace.before.length,
      remainingLocalEffects: disclosureDuringTrace.remaining.length, traceEffects: disclosureDuringTrace.traceEffects,
      overlays: disclosureDuringTrace.overlays, closedHeight: disclosureDuringTrace.closedHeight, expandedHeight: expandedDisclosure.height };

    await click("[data-workspace=metrics]");
    await settle();
    const filterStates = await probe(`const states = []; const toggle = document.getElementById('toggle-filters'); toggle.focus();
      for (let index = 0; index < 5; index += 1) { toggle.click(); states.push({ expanded: toggle.getAttribute('aria-expanded'), focused: document.activeElement === toggle }); }
      return states;`);
    assert.deepEqual(filterStates.map(state => state.expanded), ["true", "false", "true", "false", "true"]);
    assert.ok(filterStates.every(state => state.focused), "Rapid expansion preserves control focus");
    await settle();
    assert.equal(await evaluate('document.getElementById("scope-panel").hidden'), false);
    await click("#toggle-filters");
    await settle();
    assert.equal(await evaluate('document.getElementById("scope-panel").hidden'), true);
    await probe(`const control = document.getElementById('host-filter'); const hosts = Array.from(control.options, option => option.value).filter(Boolean);
      for (const value of [...hosts.slice(0, 2), '']) { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); } return true;`);
    await until(ready);
    await settle();
    assert.equal(await evaluate('document.getElementById("host-filter").value'), "");
    await assertRows("");
    assert.equal(await evaluate('document.querySelector(".metric-value").textContent'), payload.report.counts.successfulReads.toLocaleString("en-US"), "The newest filter response retains the exact final count");
    summary.observations.filters = filterStates;

    await change("metric-measure", "failedReads");
    await click("[data-workspace=resources]");
    const beforeReduce = await currentEffects();
    finite(beforeReduce, "Motion is active before the live preference change");
    await media("reduce");
    await probe("await frame(); await frame(); return true;");
    assert.equal(await evaluate("document.getAnimations().length"), 0, "Live reduced motion stops all existing effects");
    await markerAligned();
    assert.equal(await evaluate('document.getElementById("resources-workspace").hidden'), false);
    await click("[data-workspace=metrics]");
    await change("metric-measure", "successfulReads");
    await probe("await frame(); return true;");
    assert.equal(await evaluate("document.getAnimations().length"), 0, "Further actions remain still under reduced motion");
    await assertRows("");
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".trend-area"), path => ({ name: path.dataset.skill, d: path.getAttribute("d") }))'), initialPaths, "Reduced motion displays the final chart data");
    await media("no-preference");
    await click("[data-workspace=paths]");
    finite(await currentEffects(), "Restoring normal motion animates a future action");
    await settle();
    await markerAligned();
    summary.observations.liveReducedMotion = { before: beforeReduce.length, after: 0, futureNormalMotion: true };

    await evaluate("scrollTo(0, 0)");
    await capture("motion-paths-settled-desktop.png");
    for (const width of [390, 320]) {
      await click("[data-workspace=resources]");
      await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await probe("await frame(); await frame(); return true;");
      await settle();
      await markerAligned();
      assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), `No page overflow after a ${width}px resize`);
      await click("[data-workspace=metrics]");
      await settle();
      await markerAligned();
      assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), `Metrics remain usable at ${width}px`);
      await evaluate("scrollTo(0, 0)");
      await capture(`motion-settled-${width}.png`);
    }

    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await media("no-preference");
    await command("Page.navigate", { url: preview.url });
    await until(ready);
    await change("time-preset", "all");
    await until(ready);
    await settle();
    await evaluate(`window.resourceRequestCount = 0;
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/dashboard' || url.searchParams.get('scope') !== 'resources') return originalFetch(input, init);
        window.resourceRequestCount += 1;
        return originalFetch(input, init).then(response => new Promise(resolve => {
          window.releaseResourceResponse = () => resolve(response);
        }));
      };`);
    await click("[data-workspace=resources]");
    await until('typeof window.releaseResourceResponse === "function"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true, "Pending Resources hides the shared content container");
    assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Loading");
    const lazyReturn = await probe(`
      document.querySelector('[data-workspace=paths]').click();
      const chain = document.getElementById('chain-view');
      const overlay = chain.querySelector('.timeline-trace');
      const animations = document.getAnimations().filter(animation => chain.contains(animation.effect?.target));
      const initialEffects = effects('#chain-view');
      const routeMarker = document.querySelector('.route-indicator');
      const before = { contentVisible: !document.getElementById('dashboard-content').hidden,
        pathsVisible: !document.getElementById('paths-workspace').hidden,
        status: document.getElementById('status-text').textContent,
        busy: document.getElementById('workspace').getAttribute('aria-busy'),
        markerVisible: !routeMarker.hidden && routeMarker.getBoundingClientRect().height > 0 };
      window.releaseResourceResponse();
      for (let index = 0; index < 20 && !document.getElementById('resource-summary').textContent; index += 1) await frame();
      const remaining = document.getAnimations().filter(animation => chain.contains(animation.effect?.target));
      return { before, initialEffects,
        resourcesRendered: Boolean(document.getElementById('resource-summary').textContent),
        sameOverlay: overlay !== null && chain.querySelector('.timeline-trace') === overlay,
        preservedAnimations: remaining.length > 0 && remaining.every(animation => animations.includes(animation)) && animations.every(animation => animation.playState !== 'idle'),
        workspace: document.querySelector('[data-workspace][aria-current=page]').dataset.workspace,
        contentVisible: !document.getElementById('dashboard-content').hidden,
        status: document.getElementById('status-text').textContent,
        requestCount: window.resourceRequestCount };
    `);
    assert.deepEqual(lazyReturn.before, { contentVisible: true, pathsVisible: true, status: "Ready", busy: "false", markerVisible: true }, "Paths restores visible content and its marker before presentation");
    finite(lazyReturn.initialEffects, "The first Paths trace starts after returning from pending Resources");
    assert.equal(lazyReturn.resourcesRendered, true, "The inactive Resources response still completes");
    assert.equal(lazyReturn.sameOverlay, true, "Inactive Resources completion preserves the active trace overlay");
    assert.equal(lazyReturn.preservedAnimations, true, "Inactive Resources completion neither cancels nor replays active trace effects");
    assert.equal(lazyReturn.workspace, "paths");
    assert.equal(lazyReturn.contentVisible, true);
    assert.equal(lazyReturn.status, "Ready");
    assert.equal(lazyReturn.requestCount, 1);
    await capture("motion-lazy-return-intermediate-desktop.png");
    await settle();
    await markerAligned();
    await click("[data-workspace=resources]");
    await until(ready);
    await click("[data-workspace=paths]");
    assert.equal(await evaluate("window.resourceRequestCount"), 1, "Returning to cached Resources does not fetch again");
    assert.equal((await currentEffects("#chain-view")).length, 0, "Returning from cached Resources does not replay the completed trace");
    await settle();
    summary.observations.lazyResourceReturn = lazyReturn;
    assert.deepEqual(errors, [], "No browser runtime or CSP errors");
    summary.observations.browserErrors = errors;
    summary.observations.finalEffects = await evaluate("document.getAnimations().length");
  });
  await writeFile(join(directory, "motion-measurements.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`Dashboard motion smoke passed. Evidence: ${directory}\n`);
} finally {
  await preview.close();
}
