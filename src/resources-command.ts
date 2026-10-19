import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFilesystemObserver } from "./filesystem-observer.js";
import { readNativeAccountConfiguration } from "./integrations/native-settings.js";
import { openResourceRecorder } from "./resource-capture.js";
import { inventoryResources } from "./resource-inventory.js";
import { createResourceReconciler } from "./resource-reconciliation.js";
import { admitResourcePath, discoverResourceRoots, readResourceConfiguration, saveResourceRoots, type DiscoverResourceRootsOptions, type ResourceDiagnostic, type ResourceHost, type ResourceRoot } from "./resource-paths.js";
import { openHotplateReadStore, resolveHotplateDatabasePath } from "./store.js";

type ResourceArgs = {
  command: "preview" | "scan" | "watch" | "list" | "status";
  cwd: string;
  roots: string[];
  databasePath?: string;
  helperPath: string;
  intervalMs: number;
  maxEntries: number;
  project?: DiscoverResourceRootsOptions["project"];
};

export function validateResourceRoot(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const diagnostics: ResourceDiagnostic[] = [];
  const roots = discoverResourceRoots({ cwd: process.cwd(), env, roots: [path], onDiagnostic: diagnostic => { diagnostics.push(diagnostic); } });
  const root = roots.find(root => root.path === path);
  const admission = root === undefined ? undefined : admitResourcePath({ path, cwd: path, roots: [root], entry: root.admission.extent === "tree" ? "directory" : "file" });
  if (admission?.kind === "accepted" || (admission?.kind === "rejected" && admission.reason === "missing")) return;
  const rejection = diagnostics.find(diagnostic => diagnostic.path === path && diagnostic.reason !== "legacy-declaration");
  const aliases = rejection?.relatedPaths ?? [];
  const reason = admission?.kind === "rejected" ? admission.reason : rejection?.reason ?? "outside-scope";
  throw new Error(`Resource root rejected: ${path} (${reason}).${aliases.length > 0 ? ` Installed aliases: ${aliases.join(", ")}.` : ""}`);
}

export async function runResourcesCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv[0] === "add-root" || argv[0] === "remove-root") {
    if (argv.length !== 2 || !argv[1]) throw new Error("Use resources add-root|remove-root <directory>");
    const path = resolve(argv[1]);
    if (argv[0] === "add-root") validateResourceRoot(path, env);
    const configuration = readResourceConfiguration(env);
    const roots = argv[0] === "add-root" ? [...new Set([...configuration.roots, path])] : configuration.roots.filter(root => root !== path);
    saveResourceRoots(roots, env);
    process.stdout.write(`${JSON.stringify({ configPath: configuration.path, roots })}\n`);
    return;
  }
  const args = parseResourceArgs(argv, env);
  if (args.command === "preview") {
    const diagnostics: ResourceDiagnostic[] = [];
    let diagnosticsTruncated = false;
    const onDiagnostic = (diagnostic: ResourceDiagnostic): void => {
      if (diagnostics.length < 1000) diagnostics.push(diagnostic);
      else diagnosticsTruncated = true;
    };
    const roots = discoverResourceRoots({ cwd: args.cwd, env, roots: args.roots, ...args.project === undefined ? {} : { project: args.project }, onDiagnostic });
    let fileCount = 0;
    const inventory = await inventoryResources({ roots, maxEntries: args.maxEntries, onDiagnostic, record: evidence => {
      if (evidence.phase === "batch") fileCount += evidence.resources.length;
    } });
    const scans = inventory.scans.map(scan => ({ path: scan.root.path, canonicalPath: scan.root.canonicalPath,
      resourceCount: scan.resourceCount, status: scan.status, ...scan.status === "incomplete" ? { error: scan.error } : {} }));
    process.stdout.write(`${JSON.stringify({ kind: "preview", roots, scans, fileCount,
      incompleteCount: scans.filter(scan => scan.status === "incomplete").length,
      truncated: inventory.scans.some(scan => scan.status === "incomplete" && scan.error === "limit") || diagnostics.some(diagnostic => diagnostic.reason === "limit"),
      diagnostics, diagnosticsTruncated,
      notes: ["Plugin skills require an exact configured or host-advertised content root. Plugin cache versions are not inferred."],
    })}\n`);
    return;
  }
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
  const roots = (): readonly ResourceRoot[] => discoverResourceRoots({ cwd: args.cwd, env, roots: args.roots, ...args.project === undefined ? {} : { project: args.project } });
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
  const requestedStop = new Error("Resource watcher stopped");
  const stop = (): void => abort.abort(requestedStop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let observer: ReturnType<typeof startFilesystemObserver> | undefined;
  let rootIdentity = "";
  let observerFailure: unknown;
  const reconcile = createResourceReconciler(evidence => recorder.record({ evidence }));
  try {
    process.stdout.write("Hotplate resource inventory and filesystem observer running. Press Ctrl-C to stop.\n");
    while (!abort.signal.aborted) {
      const inventory = await reconcile.scan(roots(), abort.signal).catch((error: unknown) => {
        if (error === requestedStop) return null;
        throw error;
      });
      if (inventory === null) break;
      const discovered = inventory.observationRoots;
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
          .catch(error => { observerFailure = error; abort.abort(error); });
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
  if (command !== "preview" && command !== "scan" && command !== "watch" && command !== "list" && command !== "status") {
    throw new Error("Use resources preview|scan|watch|list|status|add-root|remove-root. Run hotplate help.");
  }
  const args: ResourceArgs = {
    command, cwd: process.cwd(), roots: [], intervalMs: 30_000, maxEntries: 100000,
    helperPath: env.HOTPLATE_FANOTIFY_HELPER ?? fileURLToPath(new URL("../../native/hotplate-fanotify", import.meta.url)),
  };
  let host: ResourceHost | undefined;
  let projectPath: string | undefined;
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Resource option ${flag} requires a value`);
    if (flag === "--root") args.roots.push(resolve(value));
    else if (flag === "--project") projectPath = resolve(value);
    else if (flag === "--host" && (value === "codex" || value === "claude-code" || value === "opencode-v1" || value === "opencode-v2" || value === "pi")) host = value;
    else if (flag === "--db") args.databasePath = resolve(value);
    else if (flag === "--helper") args.helperPath = resolve(value);
    else if (flag === "--interval-ms" && /^\d+$/u.test(value) && Number(value) >= 1000 && Number(value) <= 3_600_000) args.intervalMs = Number(value);
    else if (flag === "--max-entries" && command === "preview" && /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 1_000_000) args.maxEntries = Number(value);
    else throw new Error(`Invalid resource option ${flag}`);
  }
  if (projectPath !== undefined && host === undefined) throw new Error("--project requires --host to select the project skill conventions");
  if (host !== undefined && projectPath === undefined) throw new Error("--host requires --project");
  if (projectPath !== undefined && host !== undefined) {
    args.cwd = projectPath;
    args.project = { host, boundary: { kind: "infer" } };
  }
  return args;
}
