import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withBrowser } from "./browser-smoke.mjs";
import { toolActivityFixture } from "./dashboard-fixture.mjs";

const buildRoot = resolve(process.env.HOTPLATE_BUILD_ROOT ?? "dist");
const moduleUrl = name => {
  const compiled = join(buildRoot, "src", name + ".js");
  return pathToFileURL(existsSync(compiled) ? compiled : join(buildRoot, "src", name + ".ts")).href;
};
const { openHotplateStore } = await import(moduleUrl("store"));
const { startDashboardServer } = await import(moduleUrl("server"));
const directory = await mkdtemp(join(tmpdir(), "hotplate-coverage-smoke-"));
const databasePath = join(directory, "capture.sqlite");
const store = openHotplateStore({ databasePath });
try {
  const events = toolActivityFixture();
  assert.equal((await store.record(events)).accepted, events.length);
} finally {
  await store.close();
}
const server = await startDashboardServer({ databasePath, port: 0 });
try {
  const codex = await fetch(`${server.url}/api/content-analytics?host=codex`).then(response => response.json());
  assert.equal(codex.report.coverage.selection.observedOperations, 1);
  await withBrowser(async ({ command, evaluate, until, errors }) => {
    const ready = 'document.getElementById("status-text").textContent === "Ready"';
    const hiddenCoverage = () => evaluate('document.getElementById("tool-coverage").hidden');
    const coverageText = () => evaluate('document.getElementById("tool-coverage-summary").textContent');
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await command("Page.navigate", { url: server.url });
    await until(ready);
    assert.equal(await hiddenCoverage(), false);
    assert.match(await coverageText(), /6 observed operations/);
    await evaluate(`window.coverageFetch = window.fetch;
      window.fetch = (input, options) => String(input).startsWith('/api/content-analytics?')
        ? new Promise((resolve, reject) => { window.rejectCoverage = reject; })
        : window.coverageFetch(input, options);
      document.getElementById('host-filter').value = 'codex';
      document.getElementById('host-filter').dispatchEvent(new Event('change'));`);
    await until('typeof window.rejectCoverage === "function"');
    assert.equal(await evaluate('document.getElementById("status-text").textContent'), "Loading");
    assert.equal(await hiddenCoverage(), true, "Coverage from the previous scope is hidden while the new request is pending");
    await evaluate('window.rejectCoverage(new TypeError("Failed to fetch"))');
    await until('document.getElementById("status-text").textContent === "Error"');
    assert.equal(await hiddenCoverage(), true, "Failed scoped requests cannot reveal previous coverage");
    assert.match(await evaluate('document.getElementById("content-status").textContent'), /Could not reach the dashboard server/);
    await evaluate(`window.fetch = (input, options) => String(input).startsWith('/api/content-analytics?')
        ? new Promise(resolve => { window.releaseCoverage = () => resolve(window.coverageFetch(input, options)); })
        : window.coverageFetch(input, options);
      document.querySelector('#content-status button').click();`);
    await until('typeof window.releaseCoverage === "function"');
    assert.equal(await hiddenCoverage(), true, "Retry keeps coverage hidden until a current response succeeds");
    await evaluate('window.releaseCoverage(); window.fetch = window.coverageFetch;');
    await until(ready);
    assert.equal(await evaluate('document.getElementById("host-filter").value'), "codex");
    assert.equal(await hiddenCoverage(), false);
    assert.match(await coverageText(), /1 observed operation · 0 with unresolved file access/);
    assert.doesNotMatch(await coverageText(), /6 observed operations/);
    assert.deepEqual(errors, [], "The coverage transition has no runtime or CSP errors");
  });
  process.stdout.write("Dashboard coverage smoke passed: scoped loading, failure, retry, and current-scope recovery.\n");
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
