import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, username, password, machines, sourceIds } = JSON.parse(input);
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
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error("Browser command failed"));
    else handler.resolve(message.result);
  };
  function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser command timed out")); }, 10_000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, "Browser script failed");
    return result.result.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    assert.fail("Browser render timed out");
  }
  await command("Network.enable");
  await command("Network.setExtraHTTPHeaders", { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } });
  await command("Page.navigate", { url });
  await until('document.getElementById("status-text")?.textContent === "Ready"');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#machine-filter option"), option => option.value).filter(Boolean)'), machines);
  const all = await evaluate('document.getElementById("skill-table").textContent');
  for (const machine of machines) assert.ok(all.includes(machine));
  assert.ok(all.includes("<script>synthetic</script>"));
  const chains = await evaluate('document.getElementById("chain-view").textContent');
  for (const source of sourceIds) assert.ok(chains.includes(source));
  for (const machine of machines) {
    await evaluate(`document.getElementById("machine-filter").value = ${JSON.stringify(machine)}; document.getElementById("machine-filter").dispatchEvent(new Event("change"));`);
    await until('document.getElementById("status-text")?.textContent === "Ready"');
    const rows = await evaluate('Array.from(document.querySelectorAll("#skill-table tbody tr"), row => row.cells[0].textContent)');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(value => value === machine));
    const modelRows = await evaluate('Array.from(document.querySelectorAll("#model-matrix tbody tr"), row => row.cells[0].textContent)');
    assert.ok(modelRows.length > 0);
    assert.ok(modelRows.every(value => value === machine));
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#machine-filter option"), option => option.value).filter(Boolean)'), machines);
    assert.equal(await evaluate('document.querySelectorAll("#skill-table script").length'), 0);
  }
  await evaluate('document.getElementById("reset-filters").click()');
  await until('document.getElementById("status-text")?.textContent === "Ready"');
  assert.equal(await evaluate('document.getElementById("machine-filter").value'), "");
  assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
  process.stdout.write("Browser smoke passed: rendered machine rows, account source labels, machine switching, reset, and empty browser storage.\n");
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await closed;
  await rm(profile, { recursive: true, force: true });
}
