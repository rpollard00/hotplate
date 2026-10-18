import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFilesystemObserver } from "./filesystem-observer.js";
import { readNativeAccountConfiguration } from "./integrations/native-settings.js";
import { openResourceRecorder } from "./resource-capture.js";
import { inventoryResources } from "./resource-inventory.js";
import { createResourceReconciler } from "./resource-reconciliation.js";
import { discoverResourceRoots, readResourceConfiguration, saveResourceRoots, type ResourceRoot } from "./resource-paths.js";
import { openHotplateReadStore, resolveHotplateDatabasePath } from "./store.js";

type ResourceArgs = {
  command: "scan" | "watch" | "list" | "status";
  cwd: string;
  roots: string[];
  databasePath?: string;
  helperPath: string;
  intervalMs: number;
};

export async function runResourcesCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv[0] === "add-root" || argv[0] === "remove-root") {
    if (argv.length !== 2 || !argv[1]) throw new Error("Use resources add-root|remove-root <directory>");
    const path = resolve(argv[1]);
    const configuration = readResourceConfiguration(env);
    const roots = argv[0] === "add-root" ? [...new Set([...configuration.roots, path])] : configuration.roots.filter(root => root !== path);
    saveResourceRoots(roots, env);
    process.stdout.write(`${JSON.stringify({ configPath: configuration.path, roots })}\n`);
    return;
  }
  const args = parseResourceArgs(argv, env);
  if (args.command === "list" || args.command === "status") {
    const configuration = args.databasePath ? null : readNativeAccountConfiguration(env);
    const databasePath = args.databasePath ?? configuration?.databasePath ?? resolveHotplateDatabasePath({ env });
    const open = openHotplateReadStore({ databasePath });
    if (open.kind === "missing") {
      process.stdout.write(`${JSON.stringify({ kind: "missing", databasePath })}\n`);
      return;
    }
    try {
      const result = args.command === "list" ? await open.store.queryResources({}) : await open.store.queryResourceCoverage({});
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { await open.store.close(); }
    return;
  }
  if (env.HOTPLATE_DISABLED === "1" || env.HOTPLATE_DISABLED === "true") {
    process.stdout.write('{"kind":"disabled"}\n');
    return;
  }
  const recorder = openResourceRecorder({ cwd: args.cwd, env, ...(args.databasePath ? { databasePath: args.databasePath } : {}) });
  const roots = (): readonly ResourceRoot[] => discoverResourceRoots({ cwd: args.cwd, env, roots: args.roots });
  try {
    if (args.command === "scan") {
      let fileCount = 0;
      let incompleteCount = 0;
      const discovered = roots();
      await inventoryResources({ roots: discovered, record: async evidence => {
        if (evidence.phase === "batch") fileCount += evidence.resources.length;
        if (evidence.phase === "incomplete") incompleteCount += 1;
        await recorder.record({ evidence });
      } });
      process.stdout.write(`${JSON.stringify({ roots: discovered.map(root => root.path), fileCount, incompleteCount })}\n`);
      return;
    }
    await watchResources({ args, env, roots, recorder });
  } finally { await recorder.close(); }
}

async function watchResources(options: {
  args: ResourceArgs;
  env: NodeJS.ProcessEnv;
  roots: () => readonly ResourceRoot[];
  recorder: ReturnType<typeof openResourceRecorder>;
}): Promise<void> {
  const { args, env, roots, recorder } = options;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let observer: ReturnType<typeof startFilesystemObserver> | undefined;
  let rootIdentity = "";
  let observerFailure: unknown;
  const reconcile = createResourceReconciler(evidence => recorder.record({ evidence }));
  try {
    process.stdout.write("Hotplate resource inventory and filesystem observer running. Press Ctrl-C to stop.\n");
    while (!abort.signal.aborted) {
      const inventory = await reconcile.scan(roots(), abort.signal);
      const discovered = inventory.roots;
      const identity = JSON.stringify(discovered);
      if (discovered.length === 0) {
        await observer?.stop();
        observer = undefined;
        rootIdentity = "";
      } else if (!observer || identity !== rootIdentity) {
        await observer?.stop();
        rootIdentity = identity;
        observer = startFilesystemObserver({ roots: discovered, helperPath: args.helperPath, env, onObservation: async event => {
          await recorder.record(event);
          if (event.evidence.kind === "observer-coverage" && event.evidence.status === "unavailable") {
            process.stderr.write(`Filesystem observer unavailable: ${event.evidence.reason}. Inventory continues.\n`);
          }
        } });
        const running = observer;
        void running.done.then(() => { if (observer === running) observer = undefined; })
          .catch(error => { observerFailure = error; abort.abort(); });
      }
      if (!abort.signal.aborted) await waitForReconciliation(args.intervalMs, abort.signal);
    }
    if (observerFailure !== undefined) throw observerFailure;
  } finally {
    await observer?.stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function waitForReconciliation(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, intervalMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

function parseResourceArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ResourceArgs {
  const command = argv[0];
  if (command !== "scan" && command !== "watch" && command !== "list" && command !== "status") {
    throw new Error("Use resources scan|watch|list|status|add-root|remove-root. Run hotplate help.");
  }
  const args: ResourceArgs = {
    command, cwd: process.cwd(), roots: [], intervalMs: 30_000,
    helperPath: env.HOTPLATE_FANOTIFY_HELPER ?? fileURLToPath(new URL("../../native/hotplate-fanotify", import.meta.url)),
  };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Resource option ${flag} requires a value`);
    if (flag === "--root") args.roots.push(resolve(value));
    else if (flag === "--project") args.cwd = resolve(value);
    else if (flag === "--db") args.databasePath = resolve(value);
    else if (flag === "--helper") args.helperPath = resolve(value);
    else if (flag === "--interval-ms" && /^\d+$/u.test(value) && Number(value) >= 1000 && Number(value) <= 3_600_000) args.intervalMs = Number(value);
    else throw new Error(`Invalid resource option ${flag}`);
  }
  return args;
}
