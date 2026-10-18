import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startAggregationServer } from "../src/aggregation.js";
import { readAccountConfiguration, type AggregationConfiguration } from "../src/network-config.js";
import { parseCollectorOrigin } from "../src/observation.js";
import { openResourceRecorder } from "../src/resource-capture.js";
import { inventoryResources } from "../src/resource-inventory.js";
import { discoverResourceRoots, qualifyResource } from "../src/resource-paths.js";
import { readRelayStatus, runRelay } from "../src/relay.js";
import { openHotplateReadStore } from "../src/store.js";

test("inventory and resource reads reach the aggregate through the production recorder and relay", async t => {
  const directory = await mkdtemp(join(tmpdir(), "hotplate-resource-relay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = parseCollectorOrigin(`http://127.0.0.1:${port}`);
  const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = "resource-fixture-token-".repeat(3);
  const credentialsFile = join(directory, "credentials.json");
  const tokenFile = join(directory, "token");
  await writeFile(credentialsFile, JSON.stringify({ ingest: [{ token, sourceId, machineId: "fixture-machine" }], dashboard: { kind: "public" } }));
  await writeFile(tokenFile, token);
  const aggregate: AggregationConfiguration = { databasePath: join(directory, "aggregate.sqlite"), host: "127.0.0.1", port, publicOrigin: origin, credentialsFile, transport: "trusted-http" };
  const running = await startAggregationServer({ configuration: aggregate });
  t.after(() => running.close());
  const config = join(directory, "account.json");
  await writeFile(config, JSON.stringify({ databasePath: join(directory, "capture.sqlite"), sourceId, endpoint: origin, tokenFile, trustedHttp: true }));
  const env = { HOME: directory, HOTPLATE_CONFIG: config };
  const root = join(directory, "skills");
  await mkdir(root);
  const path = join(root, "principle.md");
  await writeFile(path, "RESOURCE_BODY_CANARY");
  const roots = discoverResourceRoots({ cwd: directory, env, roots: [root] });
  const resource = qualifyResource({ path, cwd: directory, roots });
  assert.ok(resource);
  const recorder = openResourceRecorder({ cwd: directory, env });
  try {
    await inventoryResources({ roots, record: evidence => recorder.record({ evidence }) });
    await recorder.record({ host: "claude-code", sessionId: "fixture-session", evidence: {
      kind: "resource-access", resource, operationId: "fixture-read", mechanism: "host-tool", access: "read",
      outcome: "success", model: null, process: null, attribution: "session",
    } });
  } finally { await recorder.close(); }
  const configuration = readAccountConfiguration({ path: config });
  const abort = new AbortController();
  const relay = runRelay({ configuration, signal: abort.signal });
  void relay.catch(() => {});
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      const status = await readRelayStatus({ configuration });
      if (status.kind === "ready" && status.delivery.pendingCount === 0) break;
      assert.ok(Date.now() < deadline, "Resource relay did not acknowledge its backlog");
      await delay(25);
    }
  } finally { abort.abort(); await relay; }
  const open = openHotplateReadStore({ databasePath: aggregate.databasePath });
  assert.equal(open.kind, "ready");
  if (open.kind === "ready") {
    try {
      const rows = (await open.store.queryResources({})).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.successfulReadCount, 1);
      assert.equal(rows[0]?.sourceId, sourceId);
      assert.equal(rows[0]?.presence, "present");
      assert.equal((await open.store.queryOverview({})).successfulReadCount, 0);
    } finally { await open.store.close(); }
  }
  const response = await fetch(`${running.url}/api/dashboard`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /"resources":/u);
  assert.ok(body.includes("principle.md"));
  assert.ok(!body.includes("RESOURCE_BODY_CANARY"));
});
