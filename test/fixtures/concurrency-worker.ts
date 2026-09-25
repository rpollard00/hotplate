import { openHotplateStore, type Observation } from "../../src/index.js";

const databasePath = process.argv[2];
const producer = process.argv[3];
const startText = process.argv[4];
const countText = process.argv[5];

if (!databasePath || !producer || !startText || !countText) {
  throw new Error("Usage: concurrency-worker <db> <producer> <start> <count>");
}

const start = Number.parseInt(startText, 10);
const count = Number.parseInt(countText, 10);
const store = openHotplateStore({ databasePath, busyTimeoutMs: 10, busyRetries: 8 });
const observations: Observation[] = [];

for (let index = 0; index < count; index += 1) {
  const sequence = start + index;
  observations.push({
    id: `${producer}-${sequence}`,
    producerId: producer,
    sequence,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    scope: {
      projectCwd: "/tmp/hotplate-project",
      sessionId: "session-concurrent",
      sessionFile: "/tmp/session.jsonl",
      segmentId: "segment-concurrent",
      segmentReason: "startup",
      runId: `run-${producer}`,
      turnId: `turn-${sequence}`,
      leafId: null,
    },
    evidence: {
      kind: "read-result",
      skill: { name: "alpha", canonicalPath: "/skills/alpha/SKILL.md", version: "v1" },
      toolCallId: `tool-${producer}-${sequence}`,
      outcome: "success",
      model: { provider: "local", id: "worker" },
    },
  });
}

const summary = await store.record(observations);
await store.close({ deadlineMs: 100 });
process.stdout.write(`${JSON.stringify(summary)}\n`);
