import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function withBrowser(run) {
  const profile = await mkdtemp(join(tmpdir(), "hotplate-browser-"));
  const browser = spawn(process.env.CHROMIUM ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const closed = once(browser, "close");
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let diagnostics = "";
      const timeout = setTimeout(() => reject(new Error("Chromium startup timed out")), 15_000);
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.stderr.on("data", chunk => {
        diagnostics += String(chunk);
        const match = diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const targets = await fetch(`http://${new URL(endpoint).host}/json/list`).then(response => response.json());
    const page = targets.find(target => target.type === "page");
    assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map(item => item.value ?? item.description).join(" "));
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error" && message.params.entry.source !== "network") errors.push(message.params.entry.text);
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(`Browser command failed: ${message.error.message}`));
      else handler.resolve(message.result);
    };
    function command(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10_000);
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, `Browser script failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    }
    async function until(expression) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      assert.fail(`Browser render timed out: ${expression}`);
    }
    async function screenshot(path) {
      const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(path, Buffer.from(result.data, "base64"));
    }
    await command("Runtime.enable");
    await command("Log.enable");
    await command("Network.enable");
    await command("Page.enable");
    return await run({ command, evaluate, until, screenshot, errors });
  } finally {
    socket?.close();
    browser.kill("SIGTERM");
    await closed;
    await rm(profile, { recursive: true, force: true });
  }
}

export async function aggregateBrowserSmoke({ url, username, password, machines, sourceIds }) {
  await withBrowser(async ({ command, evaluate, until, errors }) => {
    await command("Network.setExtraHTTPHeaders", { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } });
    await command("Page.navigate", { url });
    const ready = 'document.getElementById("status-text")?.textContent === "Ready"';
    await until(ready);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#machine-filter option"), option => option.value).filter(Boolean)'), machines);
    assert.ok((await evaluate('document.getElementById("skill-table").textContent')).includes("<script>synthetic</script>"));
    await evaluate('document.querySelector("#skill-table button.link").click()');
    const identities = await evaluate('Array.from(document.querySelectorAll("#skill-detail [data-machine]"), item => item.dataset.machine)');
    assert.deepEqual([...new Set(identities)].sort(), [...machines].sort());
    await evaluate('document.querySelector("[data-workspace=paths]").click()');
    const sources = [];
    const routeCount = await evaluate('document.querySelectorAll(".route-choice").length');
    for (let index = 0; index < routeCount; index++) {
      await evaluate(`document.querySelectorAll('.route-choice')[${index}].click()`);
      sources.push(await evaluate('document.getElementById("chain-view").textContent'));
    }
    for (const source of sourceIds) assert.ok(sources.some(text => text.includes(source)), "Source identity remains in path audit details");
    for (const machine of machines) {
      await evaluate(`document.getElementById("machine-filter").value = ${JSON.stringify(machine)}; document.getElementById("machine-filter").dispatchEvent(new Event("change"));`);
      await until(ready);
      await evaluate('document.querySelector("#skill-table button.link").click()');
      const rows = await evaluate('Array.from(document.querySelectorAll("#skill-detail [data-machine]"), item => item.dataset.machine)');
      assert.ok(rows.length > 0);
      assert.ok(rows.every(value => value === machine), "Skill identity details stay machine-scoped");
      assert.ok(await evaluate('document.querySelectorAll("#model-matrix tbody tr").length > 0'));
      const modelCounts = await evaluate('Array.from(document.querySelectorAll("#model-matrix tbody td"), cell => Number(cell.textContent.replaceAll(",", "")))');
      assert.deepEqual(modelCounts, [1], "The aggregate smoke fixture has one read for the selected machine, not a combined count");
      const count = await evaluate('document.querySelectorAll(".route-choice").length');
      for (let index = 0; index < count; index++) {
        await evaluate(`document.querySelectorAll('.route-choice')[${index}].click()`);
        assert.equal(await evaluate('document.getElementById("chain-view").dataset.machine'), machine);
      }
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#machine-filter option"), option => option.value).filter(Boolean)'), machines);
      assert.equal(await evaluate('document.querySelectorAll("#dashboard-content script").length'), 0);
      assert.ok((await evaluate('document.getElementById("skill-table").textContent')).includes("<script>synthetic</script>"));
    }
    await evaluate('document.getElementById("reset-filters").click()');
    await until(ready);
    assert.equal(await evaluate('document.getElementById("machine-filter").value'), "");
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
    assert.deepEqual(errors, [], "No runtime or CSP errors");
  });
  process.stdout.write("Browser smoke passed: name rollups, machine-scoped identities and paths, account-source audit details, literal hostile text, machine switching, reset, and empty browser storage.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  await aggregateBrowserSmoke(JSON.parse(input));
}
