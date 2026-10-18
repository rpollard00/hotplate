import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withBrowser } from "./browser-smoke.mjs";

const buildRoot = resolve(process.env.HOTPLATE_BUILD_ROOT ?? "dist");
const { openHotplateStore } = await import(pathToFileURL(join(buildRoot, "src/store.js")).href);
const { startDashboardServer } = await import(pathToFileURL(join(buildRoot, "src/server.js")).href);
const directory = process.env.HOTPLATE_SCREENSHOT_DIR ? resolve(process.env.HOTPLATE_SCREENSHOT_DIR) : await mkdtemp(join(tmpdir(), "hotplate-resource-ui-"));
await mkdir(directory, { recursive: true });
const dataDirectory = await mkdtemp(join(tmpdir(), "hotplate-resource-ui-data-"));
const previews = [];
const now = Date.now();
const timestamp = seconds => new Date(now + seconds * 1000).toISOString();
const root = "/synthetic/skills";
const filesystemId = "synthetic-host";
let sequence = 0;
function observation(evidence, seconds) {
  return { id: `resource-${sequence}`, producerId: "resource-preview", sequence: sequence++, observedAt: timestamp(seconds), host: "codex",
    scope: { projectCwd: "/synthetic/project", sessionId: "synthetic-session", sessionFile: null, segmentId: "preview", segmentReason: "startup", runId: null, turnId: null, leafId: null }, evidence };
}
function inventory(scanId, rootPath, resources) {
  const identity = { kind: "inventory-snapshot", scanId, filesystemId, rootPath, origin: "configured", scope: "project" };
  return [observation({ ...identity, phase: "started", resources: [], error: null }, -125),
    observation({ ...identity, phase: "batch", resources, batchIndex: 0, error: null }, -120),
    observation({ ...identity, phase: "complete", resources: [], batchCount: 1, error: null }, -115)];
}
function access(resource, overrides = {}) {
  return observation({ kind: "resource-access", resource, operationId: `operation-${sequence}`, mechanism: "host-tool", access: "read", outcome: "success", model: null, process: null, attribution: "session", ...overrides }, -90);
}
try {
  const resources = Array.from({ length: 32 }, (_, index) => {
    const kind = ["skill", "principle", "reference", "script", "file"][index % 5];
    const path = index === 0 ? `${root}/<script>literal</script>.md` : `${root}/review/references/${kind}-${String(index).padStart(2, "0")}-resource.md`;
    return { filesystemId, canonicalPath: path, observedPath: path, rootPath: root, kind, ownerSkillPath: index % 5 === 4 ? null : `${root}/review/SKILL.md` };
  });
  const unavailable = { ...resources[4], rootPath: "/synthetic/shared", canonicalPath: "/synthetic/shared/team-guidance.md", observedPath: "/synthetic/shared/team-guidance.md" };
  const events = [...inventory("main", root, resources), ...inventory("shared", unavailable.rootPath, [unavailable])];
  for (const seconds of [-180, -60]) events.push(observation({ kind: "observer-coverage", observerId: "filesystem-observer", mechanism: "fanotify", filesystemId, rootPaths: [root], heartbeatMs: 60_000, status: "active", reason: null }, seconds));
  events.push(observation({ kind: "observer-coverage", observerId: "unavailable-observer", mechanism: "fanotify", filesystemId, rootPaths: [unavailable.rootPath], heartbeatMs: 60_000, status: "unavailable", reason: "permission-denied" }, -60));
  events.push(access(resources[0]), access(resources[0], { access: "attempt", outcome: "unknown" }), access(resources[0], { outcome: "error" }));
  events.push(access(resources[1], { mechanism: "fanotify", access: "open", outcome: "unknown" }), access(resources[1], { mechanism: "fanotify", access: "access", outcome: "unknown" }));
  events.push(access(resources[2], { mechanism: "fanotify", access: "open", outcome: "unknown", attribution: "unknown" }));
  events.push(access(resources[3], { mechanism: "fanotify", access: "access", outcome: "unknown", attribution: "non-agent" }));
  for (const scenario of ["rich", "empty", "missing"]) {
    const databasePath = join(dataDirectory, `${scenario}.sqlite`);
    if (scenario !== "missing") {
      const store = openHotplateStore({ databasePath });
      if (scenario === "rich") assert.equal((await store.record(events)).accepted, events.length);
      await store.close();
    }
    previews.push(await startDashboardServer({ databasePath, port: 0 }));
  }
  const [rich, empty, missing] = previews;
  const payload = await fetch(`${rich.url}/api/dashboard`).then(response => response.json());
  assert.equal(payload.resources.rows.length, 33);
  assert.equal(payload.resources.rows.filter(row => row.observation === "observed").length, 2);
  assert.equal(payload.resources.rows.filter(row => row.observation === "not-observed").length, 29);
  assert.equal(payload.resources.rows.filter(row => row.observation === "unknown").length, 2);
  await withBrowser(async ({ command, evaluate, until, screenshot, errors }) => {
    const ready = 'document.getElementById("status-text").textContent === "Ready"';
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const change = (id, value, event = "change") => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)}));`);
    const noOverflow = async () => assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "No page overflow");
    const viewportScreenshot = async name => {
      const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(directory, name), Buffer.from(result.data, "base64"));
    };
    await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await command("Page.navigate", { url: rich.url + "/?preview=1" });
    await until(ready); await change("time-preset", "all"); await until(ready); await click('[data-workspace="resources"]');
    assert.equal(await evaluate('document.querySelectorAll("#resource-table tbody tr").length'), 25);
    assert.match(await evaluate('document.getElementById("resource-summary").textContent'), /33 files.*29 with no observed agent access.*2 unknown/);
    assert.ok((await evaluate('document.getElementById("resource-table").textContent')).includes("<script>literal</script>"));
    assert.equal(await evaluate('document.querySelectorAll("#resource-table script").length'), 0);
    const controlBottoms = await evaluate('["resource-search", "resource-kind", "resource-observation"].map(id => document.getElementById(id).getBoundingClientRect().bottom)');
    assert.ok(Math.max(...controlBottoms) - Math.min(...controlBottoms) <= 1, "Resource controls align");
    await noOverflow(); await screenshot(join(directory, "resources-desktop.png"));
    await viewportScreenshot("resources-desktop-viewport.png");
    await click("#resource-table summary");
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /Machine: local.*Source: local/s);
    await click('[aria-label="Next resources"]');
    assert.equal(await evaluate('document.querySelectorAll("#resource-table tbody tr").length'), 8);
    await change("resource-search", "principle-01", "input");
    assert.equal(await evaluate('document.querySelectorAll("#resource-table tbody tr").length'), 1);
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /Agent: 2/);
    await change("resource-search", "", "input"); await change("resource-kind", "principle");
    assert.equal(await evaluate('document.querySelectorAll("#resource-table tbody tr").length'), 7);
    await change("resource-kind", ""); await change("resource-observation", "not-observed");
    assert.ok(await evaluate('Array.from(document.querySelectorAll("#resource-table tbody tr")).every(row => row.dataset.observation === "not-observed")'));
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /Covered .* UTC/);
    await screenshot(join(directory, "resources-no-access-desktop.png"));
    await change("resource-observation", "unknown");
    assert.equal(await evaluate('document.querySelectorAll("#resource-table tbody tr").length'), 2);
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /Unknown: 1/);
    await click("#resource-coverage summary");
    assert.match(await evaluate('document.getElementById("resource-coverage-content").textContent'), /Permission denied/);
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("window.scrollTo(0, 0)"); await noOverflow(); await screenshot(join(directory, "resources-unknown-mobile.png"));
    await evaluate('document.getElementById("resource-table").scrollLeft = 800');
    assert.ok(await evaluate('document.getElementById("resource-table").scrollLeft > 0'));
    await screenshot(join(directory, "resources-evidence-mobile.png"));
    await evaluate('document.getElementById("resource-table").scrollIntoView({ block: "start" })');
    await viewportScreenshot("resources-evidence-mobile-viewport.png");
    await evaluate("window.scrollTo(0, 0)");
    await evaluate('document.getElementById("resource-table").scrollLeft = 0');
    await change("resource-search", "no-matching-resource", "input");
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /No files match these resource filters/);
    await click("#resource-table button");
    assert.equal(await evaluate('document.getElementById("resource-search").value'), "");
    await noOverflow(); await screenshot(join(directory, "resources-mobile.png"));
    await command("Page.navigate", { url: empty.url }); await until(ready); await click('[data-workspace="resources"]');
    assert.match(await evaluate('document.getElementById("resource-table").textContent'), /No resource inventory or access has been recorded/);
    assert.equal(await evaluate('document.getElementById("resource-controls").hidden'), true);
    await noOverflow(); await screenshot(join(directory, "resources-empty-mobile.png"));
    await command("Page.navigate", { url: missing.url });
    await until('document.getElementById("status-text").textContent === "No database"');
    assert.equal(await evaluate('document.getElementById("dashboard-content").hidden'), true);
    await noOverflow(); await screenshot(join(directory, "resources-missing-mobile.png"));
    assert.deepEqual(errors, [], "No runtime or CSP errors");
  });
  await writeFile(join(directory, "resource-ui-verification.json"), JSON.stringify({ fixture: "synthetic-resources", observedAt: new Date(now).toISOString(), viewports: [[1280, 960], [390, 844]], rows: 33, observed: 2, noObservedAccess: 29, unknown: 2, checks: ["literal markup", "pagination", "search", "kind filter", "observation filter", "coverage reasons", "empty", "missing", "no page overflow", "no browser errors"] }, null, 2) + "\n");
  process.stdout.write(`Resource dashboard browser smoke passed. Screenshots: ${directory}\n`);
} finally {
  await Promise.all(previews.map(preview => preview.close()));
  await rm(dataDirectory, { recursive: true, force: true });
}
