import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseHostId, parseMachineId } from "./observation.js";
import { dashboardCss, dashboardHtml, dashboardJs } from "./dashboard/assets.js";
import { archivoFont, fontLicenses, jetbrainsMonoFont } from "./dashboard/fonts.js";
import { buildDashboardReport, type DashboardReport } from "./dashboard/analytics.js";
import { isContentMeasure, isResourceMeasure, type ContentInterval, type ContentQuery, type ContentReport } from "./content-analytics.js";
import {
  openHotplateReadStore,
  resolveHotplateDatabasePath,
  type HotplateReadonlyStore,
} from "./store.js";
import type {
  ChainFilter,
  DashboardFilter,
  DashboardFilterOptions,
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

type FilterOptions = DashboardFilterOptions;

type SourceSplitRow = {
  label: string;
  count: number;
};

type FullDashboardPayload =
  | {
      kind: "ready";
      databasePath: string;
      report: DashboardReport;
      overview: Awaited<ReturnType<HotplateReadonlyStore["queryOverview"]>>;
      skills: SkillTableView;
      matrix: Awaited<ReturnType<HotplateReadonlyStore["queryModelMatrix"]>>;
      chains: SkillChainView;
      health: Awaited<ReturnType<HotplateReadonlyStore["queryCaptureHealth"]>>;
      resources: Awaited<ReturnType<HotplateReadonlyStore["queryResources"]>>;
      resourceCoverage: Awaited<ReturnType<HotplateReadonlyStore["queryResourceCoverage"]>>;
      sourceSplit: readonly SourceSplitRow[];
      filterOptions: FilterOptions;
      chainSkillName: string | null;
    }
  | { kind: "missing"; databasePath: string; filterOptions: FilterOptions }
  | { kind: "error"; databasePath: string; message: string; filterOptions: FilterOptions };

type FullDashboardReady = Extract<FullDashboardPayload, { kind: "ready" }>;
type DashboardPayload =
  | FullDashboardPayload
  | (Pick<FullDashboardReady, "kind" | "databasePath" | "filterOptions" | "report"> & { scope: "skills" })
  | (Pick<FullDashboardReady, "kind" | "databasePath" | "filterOptions" | "resources" | "resourceCoverage"> & { scope: "resources" });

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
  await respondDashboard({ request, response, databasePath });
}

// Listeners must authorize the request before calling this shared responder.
export async function respondDashboard(args: { request: IncomingMessage; response: ServerResponse; databasePath: string }): Promise<void> {
  const { request, response, databasePath } = args;
  setSecurityHeaders(response);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendText(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url ?? "/", "http://dashboard.invalid");
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
  if (url.pathname === "/assets/fonts/archivo-latin.woff2") {
    send(response, 200, "font/woff2", archivoFont, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/assets/fonts/jetbrains-mono-latin.woff2") {
    send(response, 200, "font/woff2", jetbrainsMonoFont, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/assets/fonts/LICENSE.txt") {
    send(response, 200, "text/plain; charset=utf-8", fontLicenses, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/api/dashboard") {
    const payload = await readDashboardPayload(databasePath, url.searchParams);
    sendJson(response, 200, payload, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/api/content-analytics") {
    const payload = await readContentPayload(databasePath, url.searchParams);
    sendJson(response, 200, payload, request.method === "HEAD");
    return;
  }
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true }, request.method === "HEAD");
    return;
  }

  sendText(response, 404, "Not found");
}

async function readContentPayload(databasePath: string, params: URLSearchParams): Promise<
  | { kind: "ready"; databasePath: string; report: ContentReport }
  | { kind: "missing"; databasePath: string }
  | { kind: "error"; databasePath: string; message: string }
> {
  let reader: HotplateReadonlyStore | undefined;
  try {
    const query = parseContentParams(params);
    const opened = openHotplateReadStore({ databasePath });
    if (opened.kind === "missing") return opened;
    reader = opened.store;
    return { kind: "ready", databasePath: opened.databasePath, report: await reader.queryContentAnalytics(query) };
  } catch (error) {
    return { kind: "error", databasePath, message: error instanceof Error ? error.message : "Unknown content analytics error" };
  } finally { await reader?.close(); }
}

function parseContentParams(params: URLSearchParams): ContentQuery {
  const { filter } = parseDashboardParams(params);
  const content = params.get("content") ?? "both";
  if (content !== "resources" && content !== "both") throw new Error("content must be resources or both");
  const measure = params.get("measure") ?? "toolActivity";
  if (!isContentMeasure(measure)) throw new Error("Invalid content measure");
  const split = params.get("split") ?? "item";
  if (split !== "item" && split !== "agent" && split !== "model" && split !== "agent-model") throw new Error("split must be item, agent, model, or agent-model");
  const from = params.get("selectionFrom"); const to = params.get("selectionTo");
  let selection: ContentInterval = { kind: "all" };
  if (from !== null || to !== null) {
    if (from === null || to === null) throw new Error("selectionFrom and selectionTo must be provided together");
    const startAt = parseObservedAt(from, "selectionFrom"); const endAt = parseObservedAt(to, "selectionTo");
    if (Date.parse(startAt) >= Date.parse(endAt)) throw new Error("selectionFrom must be before selectionTo");
    selection = { kind: "interval", startAt, endAt };
  }
  if (content === "resources") {
    if (!isResourceMeasure(measure)) throw new Error("This measure requires content=both");
    return { content, filter, measure, split, selection };
  }
  return { content, filter, measure, split, selection };
}

async function readDashboardPayload(databasePath: string, params: URLSearchParams): Promise<DashboardPayload> {
  let filterOptions = emptyFilterOptions();
  let reader: HotplateReadonlyStore | undefined;
  try {
    const open = openHotplateReadStore({ databasePath });
    if (open.kind === "missing") {
      return { kind: "missing", databasePath: open.databasePath, filterOptions };
    }
    reader = open.store;
    const parsed = parseDashboardParams(params);
    filterOptions = await reader.queryFilterOptions(parsed.filter);
    if (parsed.scope === "skills") {
      const skills = await reader.querySkillTable(parsed.filter);
      const chains = await reader.querySkillChain(parsed.filter);
      return { kind: "ready", scope: "skills", databasePath: open.databasePath, filterOptions,
        report: buildDashboardReport({ filter: parsed.filter, skills, chains }) };
    }
    if (parsed.scope === "resources") {
      const resources = await reader.queryResources(parsed.filter);
      const resourceCoverage = await reader.queryResourceCoverage(parsed.filter);
      return { kind: "ready", scope: "resources", databasePath: open.databasePath, filterOptions, resources, resourceCoverage };
    }
    const overview = await open.store.queryOverview(parsed.filter);
    const skills = await open.store.querySkillTable(parsed.filter);
    const matrix = await open.store.queryModelMatrix(parsed.filter);
    const health = await open.store.queryCaptureHealth(parsed.filter);
    const resources = await open.store.queryResources(parsed.filter);
    const resourceCoverage = await open.store.queryResourceCoverage(parsed.filter);
    const allChains = await open.store.querySkillChain(parsed.filter);
    const chainFilter = chainFilterFor(parsed.filter, parsed.chainSkillName);
    const chains = parsed.chainSkillName === null ? allChains : await open.store.querySkillChain(chainFilter);
    return {
      kind: "ready",
      databasePath: open.databasePath,
      report: buildDashboardReport({ filter: parsed.filter, skills, chains: allChains }),
      overview,
      skills,
      matrix,
      chains,
      health,
      resources,
      resourceCoverage,
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

function parseDashboardParams(params: URLSearchParams): { scope: "full" | "skills" | "resources"; filter: DashboardFilter; chainSkillName: string | null } {
  const scope = params.get("scope") ?? "full";
  if (scope !== "full" && scope !== "skills" && scope !== "resources") throw new Error("scope must be full, skills, or resources");
  const filter: DashboardFilter = {};
  const host = nonEmptyParam(params, "host");
  if (host !== null) filter.host = parseHostId(host);
  const machineId = nonEmptyParam(params, "machineId");
  if (machineId !== null) filter.machineId = parseMachineId(machineId);
  const projectCwd = nonEmptyParam(params, "projectCwd");
  const source = nonEmptyParam(params, "source");
  const model = params.get("model");
  if (model !== null && model !== "") filter.modelSelection = parseModelSelection(model);
  const modelProvider = nonEmptyParam(params, "modelProvider");
  const modelId = nonEmptyParam(params, "modelId");
  const fromObservedAt = nonEmptyParam(params, "fromObservedAt");
  const toObservedAt = nonEmptyParam(params, "toObservedAt");
  if (projectCwd !== null) filter.projectCwd = projectCwd;
  if (source !== null) filter.source = parseInputSource(source);
  if (modelProvider !== null) filter.modelProvider = modelProvider;
  if (modelId !== null) filter.modelId = modelId;
  if (fromObservedAt !== null) filter.fromObservedAt = parseObservedAt(fromObservedAt, "fromObservedAt");
  if (toObservedAt !== null) filter.toObservedAt = parseObservedAt(toObservedAt, "toObservedAt");
  if (filter.fromObservedAt !== undefined && filter.toObservedAt !== undefined
    && Date.parse(filter.fromObservedAt) > Date.parse(filter.toObservedAt)) {
    throw new Error("fromObservedAt must not be after toObservedAt");
  }
  return { scope, filter, chainSkillName: nonEmptyParam(params, "chainSkill") };
}

function parseModelSelection(value: string): NonNullable<DashboardFilter["modelSelection"]> {
  if (value === "unknown") return { kind: "unknown" };
  let tuple: unknown;
  try { tuple = JSON.parse(value); } catch { throw new Error("model must be unknown or a provider/model JSON pair"); }
  if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || typeof tuple[1] !== "string"
    || tuple[0].trim().length === 0 || tuple[1].trim().length === 0) throw new Error("model must be unknown or a provider/model JSON pair");
  return { kind: "known", model: { provider: tuple[0], id: tuple[1] } };
}

function parseObservedAt(value: string, name: string): string {
  const isoFormat = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
  const time = Date.parse(value);
  const calendarDate = value.slice(0, 10);
  const calendarTime = Date.parse(`${calendarDate}T00:00:00.000Z`);
  const nextDay = (Math.floor(time / 86_400_000) + 1) * 86_400_000;
  if (!isoFormat.test(value) || !Number.isFinite(time) || !Number.isFinite(calendarTime)
    || new Date(calendarTime).toISOString().slice(0, 10) !== calendarDate
    || !Number.isFinite(new Date(nextDay).getTime())) {
    throw new Error(`${name} must be a valid ISO date or date and time with a timezone`);
  }
  return new Date(time).toISOString();
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

function emptyFilterOptions(): FilterOptions {
  return { hosts: [], machines: [], projects: [], agentModelPairs: [], modelProviders: [], modelIds: [], timeRange: { firstObservedAt: null, lastObservedAt: null } };
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
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

function send(response: ServerResponse, statusCode: number, contentType: string, body: string | Uint8Array, headOnly: boolean): void {
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
