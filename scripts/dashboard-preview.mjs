import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openHotplateStore } from "../dist/src/store.js";
import { startDashboardServer } from "../dist/src/server.js";
import { dashboardFixture } from "./dashboard-fixture.mjs";

export async function startDashboardPreview({ port = 0, scenario = "rich", now = new Date() } = {}) {
  if (!["rich", "empty", "missing"].includes(scenario)) throw new Error("Preview scenario must be rich, empty, or missing");
  const directory = await mkdtemp(join(tmpdir(), "hotplate-preview-"));
  const databasePath = join(directory, "synthetic.sqlite");
  try {
    if (scenario !== "missing") {
      const store = openHotplateStore({ databasePath });
      try {
        if (scenario === "rich") {
          const result = await store.record(dashboardFixture({ now }));
          if (result.dropped !== 0) throw new Error(`Preview lost ${result.dropped} synthetic records`);
        }
      } finally {
        await store.close();
      }
    }
    const server = await startDashboardServer({ databasePath, port });
    let closing;
    return {
      url: `${server.url}/?preview=1`, databasePath, directory,
      close() {
        closing ??= server.close().finally(() => rm(directory, { recursive: true, force: true }));
        return closing;
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(args) {
  const options = { port: 7346, scenario: "rich" };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--port" && value && /^\d+$/.test(value) && Number(value) <= 65535) options.port = Number(value);
    else if (flag === "--scenario" && ["rich", "empty", "missing"].includes(value)) options.scenario = value;
    else throw new Error("Usage: npm run dashboard:preview -- [--port 7346] [--scenario rich|empty|missing]");
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startDashboardPreview(parseArgs(process.argv.slice(2)));
  process.stdout.write(`Synthetic Hotplate preview: ${preview.url}\nDisposable database: ${preview.databasePath}\nPress Ctrl+C to stop and remove the preview data.\n`);
  const stop = () => { void preview.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
