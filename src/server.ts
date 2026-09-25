import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { dashboardCss, dashboardHtml, dashboardJs } from "./dashboard/assets.js";
import {
  openHotplateReadStore,
  resolveHotplateDatabasePath,
  type HotplateReadonlyStore,
} from "./store.js";
import type {
  ChainFilter,
  DashboardFilter,
  InputSource,
  SkillChainView,
  SkillTableView,
} from "./domain.js";

const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 7345;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

type DashboardServerOptions = {
  databasePath?: string;
  host?: string;
  port?: number;
};

type RunningDashboardServer = {
  server: Server;
  url: string;
  databasePath: string;
  close(): Promise<void>;
};

type FilterOptions = {
  projects: readonly string[];
  modelProviders: readonly string[];
  modelIds: readonly string[];
  timeRange: { firstObservedAt: string | null; lastObservedAt: string | null };
};

type SourceSplitRow = {
  label: string;
  count: number;
};

type DashboardPayload =
  | {
      kind: "ready";
      databasePath: string;
      overview: Awaited<ReturnType<HotplateReadonlyStore["queryOverview"]>>;
      skills: SkillTableView;
      matrix: Awaited<ReturnType<HotplateReadonlyStore["queryModelMatrix"]>>;
      chains: SkillChainView;
      health: Awaited<ReturnType<HotplateReadonlyStore["queryCaptureHealth"]>>;
      sourceSplit: readonly SourceSplitRow[];
      filterOptions: FilterOptions;
      chainSkillName: string | null;
    }
  | { kind: "missing"; databasePath: string; filterOptions: FilterOptions }
  | { kind: "error"; databasePath: string; message: string; filterOptions: FilterOptions };

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<RunningDashboardServer> {
  const host = options.host ?? DEFAULT_DASHBOARD_HOST;
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const databasePath = options.databasePath ?? resolveHotplateDatabasePath();
  if (!isLoopbackHost(host)) {
    throw new Error("Hotplate dashboard host must be loopback-only");
  }

  const server = createHotplateHttpServer({ databasePath, host });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Hotplate dashboard did not return a TCP address");
  }
  const url = `http://${formatHostForUrl(address.address)}:${address.port}`;
  return {
    server,
    url,
    databasePath,
    close: () => closeServer(server),
  };
}

export function createHotplateHttpServer(options: { databasePath?: string; host?: string } = {}): Server {
  const databasePath = options.databasePath ?? resolveHotplateDatabasePath();
  const host = options.host ?? DEFAULT_DASHBOARD_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error("Hotplate dashboard host must be loopback-only");
  }

  return createServer((request, response) => {
    void handleRequest({ request, response, databasePath, host }).catch(() => {
      if (response.headersSent) response.destroy();
      else sendText(response, 500, "Dashboard request failed");
    });
  });
}

async function handleRequest(options: { request: IncomingMessage; response: ServerResponse; databasePath: string; host: string }): Promise<void> {
  const { request, response, databasePath, host } = options;
  setSecurityHeaders(response);

  if (!isSafeRequestHost(request, host)) {
    sendText(response, 403, "Forbidden host");
    return;
  }
  if (!isSafeOrigin(request, host)) {
    sendText(response, 403, "Forbidden origin");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendText(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(response, 200, "text/html; charset=utf-8", dashboardHtml, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/assets/style.css") {
    send(response, 200, "text/css; charset=utf-8", dashboardCss, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/assets/app.js") {
    send(response, 200, "text/javascript; charset=utf-8", dashboardJs, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/api/dashboard") {
    const payload = await readDashboardPayload(databasePath, url.searchParams);
    sendJson(response, 200, payload, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true }, request.method === "HEAD");
    return;
  }

  sendText(response, 404, "Not found");
}

async function readDashboardPayload(databasePath: string, params: URLSearchParams): Promise<DashboardPayload> {
  const filterOptions = readFilterOptions(databasePath);
  let reader: HotplateReadonlyStore | undefined;
  try {
    const open = openHotplateReadStore({ databasePath });
    if (open.kind === "missing") {
      return { kind: "missing", databasePath: open.databasePath, filterOptions };
    }
    reader = open.store;
    const parsed = parseDashboardParams(params);
    const overview = await open.store.queryOverview(parsed.filter);
    const skills = await open.store.querySkillTable(parsed.filter);
    const matrix = await open.store.queryModelMatrix(parsed.filter);
    const health = await open.store.queryCaptureHealth(parsed.filter);
    const allChains = await open.store.querySkillChain(parsed.filter);
    const chainFilter = chainFilterFor(parsed.filter, parsed.chainSkillName);
    const chains = parsed.chainSkillName === null ? allChains : await open.store.querySkillChain(chainFilter);
    return {
      kind: "ready",
      databasePath: open.databasePath,
      overview,
      skills,
      matrix,
      chains,
      health,
      sourceSplit: deriveSourceSplit(skills, allChains),
      filterOptions,
      chainSkillName: parsed.chainSkillName,
    };
  } catch (error) {
    return {
      kind: "error",
      databasePath,
      message: error instanceof Error ? error.message : "Unknown dashboard read error",
      filterOptions,
    };
  } finally {
    await reader?.close();
  }
}

function parseDashboardParams(params: URLSearchParams): { filter: DashboardFilter; chainSkillName: string | null } {
  const filter: DashboardFilter = {};
  const projectCwd = nonEmptyParam(params, "projectCwd");
  const source = nonEmptyParam(params, "source");
  const modelProvider = nonEmptyParam(params, "modelProvider");
  const modelId = nonEmptyParam(params, "modelId");
  const fromObservedAt = nonEmptyParam(params, "fromObservedAt");
  const toObservedAt = nonEmptyParam(params, "toObservedAt");
  if (projectCwd !== null) filter.projectCwd = projectCwd;
  if (source !== null) filter.source = parseInputSource(source);
  if (modelProvider !== null) filter.modelProvider = modelProvider;
  if (modelId !== null) filter.modelId = modelId;
  if (fromObservedAt !== null) filter.fromObservedAt = fromObservedAt;
  if (toObservedAt !== null) filter.toObservedAt = toObservedAt;
  return { filter, chainSkillName: nonEmptyParam(params, "chainSkill") };
}

function nonEmptyParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim();
  return value ? value : null;
}

function parseInputSource(value: string): InputSource {
  if (value === "interactive" || value === "rpc" || value === "extension") {
    return value;
  }
  throw new Error(`Unsupported input source ${value}`);
}

function chainFilterFor(filter: DashboardFilter, skillName: string | null): ChainFilter {
  if (skillName === null) {
    return filter;
  }
  return { ...filter, skillName };
}

function deriveSourceSplit(skills: SkillTableView, chains: SkillChainView): readonly SourceSplitRow[] {
  const interactive = sum(skills.rows.map((row) => row.interactiveCommandIntentCount));
  const rpc = sum(skills.rows.map((row) => row.rpcCommandIntentCount));
  const extension = sum(skills.rows.map((row) => row.extensionCommandIntentCount));
  const successfulReads = sum(skills.rows.map((row) => row.successfulReadCount));
  const unknownWrappers = countUnknownWrappers(chains);
  return [
    { label: "Interactive command intents", count: interactive },
    { label: "RPC command intents", count: rpc },
    { label: "Extension command intents", count: extension },
    { label: "Successful model reads", count: successfulReads },
    { label: "Unknown wrapper source", count: unknownWrappers },
  ].filter((row) => row.count > 0);
}

function countUnknownWrappers(chains: SkillChainView): number {
  let count = 0;
  for (const run of chains.runs) {
    for (const step of run.steps) {
      if (step.kind !== "observations") continue;
      for (const item of step.items) {
        if (item.evidence.kind === "wrapper-observed" && item.evidence.wrapperSource === "unknown-pasted-or-transformed") {
          count += 1;
        }
      }
    }
  }
  return count;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function readFilterOptions(databasePath: string): FilterOptions {
  if (databasePath !== ":memory:" && !existsSync(databasePath)) {
    return emptyFilterOptions();
  }

  try {
    const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 25, allowExtension: false });
    try {
      if (schemaVersion(db) !== 1) {
        return emptyFilterOptions();
      }
      const projects = stringColumn(db, `
        SELECT project_cwd AS value FROM observations
        UNION
        SELECT project_cwd AS value FROM catalog_skills
        ORDER BY value
      `);
      const modelProviders = stringColumn(db, `
        SELECT DISTINCT model_provider AS value FROM observations
        WHERE model_provider IS NOT NULL
        ORDER BY value
      `);
      const modelIds = stringColumn(db, `
        SELECT DISTINCT model_id AS value FROM observations
        WHERE model_id IS NOT NULL
        ORDER BY value
      `);
      const time = db.prepare("SELECT MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at FROM observations").get();
      return {
        projects,
        modelProviders,
        modelIds,
        timeRange: {
          firstObservedAt: nullableString(time?.first_observed_at),
          lastObservedAt: nullableString(time?.last_observed_at),
        },
      };
    } finally {
      db.close();
    }
  } catch {
    return emptyFilterOptions();
  }
}

function emptyFilterOptions(): FilterOptions {
  return { projects: [], modelProviders: [], modelIds: [], timeRange: { firstObservedAt: null, lastObservedAt: null } };
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function stringColumn(db: DatabaseSync, sql: string): readonly string[] {
  return db.prepare(sql).all().map((row) => requireString(row.value));
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected string value");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headOnly = false): void {
  send(response, statusCode, JSON_HEADERS["content-type"], `${JSON.stringify(body)}\n`, headOnly);
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
  send(response, statusCode, "text/plain; charset=utf-8", `${body}\n`, false);
}

function send(response: ServerResponse, statusCode: number, contentType: string, body: string, headOnly: boolean): void {
  response.writeHead(statusCode, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  if (headOnly) {
    response.end();
    return;
  }
  response.end(body);
}

function isSafeRequestHost(request: IncomingMessage, configuredHost: string): boolean {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string") {
    return false;
  }
  try {
    const authority = new URL(`http://${hostHeader}`);
    return authority.username === "" && authority.password === "" && authority.pathname === "/"
      && isAllowedLoopbackName(authority.hostname, configuredHost)
      && Number(authority.port || "80") === request.socket.localPort;
  } catch {
    return false;
  }
}

function isSafeOrigin(request: IncomingMessage, configuredHost: string): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (typeof origin !== "string") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const target = new URL(`http://${request.headers.host}`);
    return parsed.protocol === "http:" && isAllowedLoopbackName(parsed.hostname, configuredHost)
      && parsed.origin === target.origin && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function isAllowedLoopbackName(hostname: string, configuredHost: string): boolean {
  const normalized = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
  const configured = configuredHost.replace(/^\[(.*)]$/, "$1").toLowerCase();
  return normalized === configured || isLoopbackHost(normalized);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function formatHostForUrl(host: AddressInfo["address"]): string {
  return host.includes(":") ? `[${host}]` : host;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
