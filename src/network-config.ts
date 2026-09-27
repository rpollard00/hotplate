import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CaptureEnrollment, CollectorOrigin, SourceIdentity } from "./domain.js";
import { parseCollectorOrigin, parseMachineId, parseSourceId, validateNetworkIdentity } from "./observation.js";
import { resolveHotplateDatabasePath } from "./store.js";

type Transport = "tls" | "trusted-http";
export type AccountConfiguration = {
  databasePath: string;
  enrollment: CaptureEnrollment;
  tokenFile: string;
  transport: Transport;
};
export type AggregationConfiguration = {
  databasePath: string;
  host: string;
  port: number;
  publicOrigin: CollectorOrigin;
  credentialsFile: string;
  openEnrollment?: boolean;
  transport: Transport;
};

export function readAccountConfiguration(args: { path: string; env?: NodeJS.ProcessEnv }): AccountConfiguration {
  try {
    const value = object(readJson(args.path));
    keys(value, ["databasePath", "sourceId", "endpoint", "tokenFile", "trustedHttp"]);
    const collectorOrigin = parseCollectorOrigin(value.endpoint);
    return {
      databasePath: value.databasePath === undefined
        ? resolveHotplateDatabasePath({ env: args.env ?? process.env })
        : filePath(value.databasePath, args.path),
      enrollment: { sourceId: parseSourceId(value.sourceId), collectorOrigin },
      tokenFile: filePath(value.tokenFile, args.path),
      transport: transport(collectorOrigin, value.trustedHttp),
    };
  } catch { throw new Error("Invalid account configuration. Check sourceId, endpoint, tokenFile, databasePath, and trustedHttp."); }
}

export function readAggregationConfiguration(args: { path: string }): AggregationConfiguration {
  try {
    const value = object(readJson(args.path));
    keys(value, ["databasePath", "host", "port", "publicOrigin", "credentialsFile", "trustedHttp", "openEnrollment"]);
    const publicOrigin = parseCollectorOrigin(value.publicOrigin);
    if (value.openEnrollment !== undefined && typeof value.openEnrollment !== "boolean") throw new Error();
    const host = value.host === undefined ? "0.0.0.0" : text(value.host);
    if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(host)) throw new Error();
    const port = value.port === undefined ? 7345 : value.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return {
      databasePath: filePath(value.databasePath, args.path), host, port, publicOrigin,
      credentialsFile: filePath(value.credentialsFile, args.path),
      openEnrollment: value.openEnrollment === true,
      transport: transport(publicOrigin, value.trustedHttp),
    };
  } catch { throw new Error("Invalid aggregate configuration. Check databasePath, publicOrigin, credentialsFile, host, port, and trustedHttp."); }
}

export function readIngestToken(path: string): string {
  try { return token(readBoundedFile(path, 4096).trim()); }
  catch { throw new Error("Cannot read a valid ingest token. Check the token file and restart the relay."); }
}

export function readAggregationCredentials(path: string): {
  ingest: readonly { token: string; source: SourceIdentity }[];
  dashboard: { kind: "public" } | { kind: "basic"; username: string; password: string };
} {
  try {
    const value = object(readJson(path));
    keys(value, ["ingest", "dashboard"]);
    if (!Array.isArray(value.ingest) || value.ingest.length < 1 || value.ingest.length > 1000) throw new Error();
    const sources = new Map<string, string>();
    const tokens = new Set<string>();
    const ingest = value.ingest.map((entry: unknown) => {
      const item = object(entry);
      keys(item, ["token", "machineId", "sourceId"]);
      const source = validateNetworkIdentity({ machineId: parseMachineId(item.machineId), sourceId: parseSourceId(item.sourceId) });
      const secret = token(item.token);
      if (tokens.has(secret) || (sources.has(source.sourceId) && sources.get(source.sourceId) !== source.machineId)) throw new Error();
      tokens.add(secret);
      sources.set(source.sourceId, source.machineId);
      return { token: secret, source };
    });
    const dashboard = object(value.dashboard);
    if (dashboard.kind === "public") {
      keys(dashboard, ["kind"]);
      return { ingest, dashboard: { kind: "public" } };
    }
    keys(dashboard, ["username", "password"]);
    const username = text(dashboard.username);
    const password = text(dashboard.password);
    if (!/^[\x21-\x39\x3b-\x7e]{1,128}$/.test(username) || !/^[\x20-\x7e]{16,256}$/.test(password)
      || tokens.has(password) || tokens.has(`${username}:${password}`)) throw new Error();
    return { ingest, dashboard: { kind: "basic", username, password } };
  } catch { throw new Error("Invalid aggregate credentials. Configure separate ingest tokens and dashboard credentials."); }
}

function transport(origin: CollectorOrigin, trustedHttp: unknown): Transport {
  if (trustedHttp !== undefined && typeof trustedHttp !== "boolean") throw new Error();
  if (origin.startsWith("https://")) return "tls";
  if (trustedHttp !== true) throw new Error();
  return "trusted-http";
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/-]{32,512}={0,2}$/.test(value)) throw new Error();
  return value;
}
function filePath(value: unknown, configPath: string): string { return resolve(dirname(resolve(configPath)), text(value)); }
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) throw new Error();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error();
}
function readBoundedFile(path: string, maxBytes: number): string {
  if (statSync(path).size > maxBytes) throw new Error();
  const data = readFileSync(path);
  if (data.length > maxBytes) throw new Error();
  return data.toString("utf8");
}
function readJson(path: string): unknown { return JSON.parse(readBoundedFile(path, 1024 * 1024)); }

export function parseConnectionOrigin(instance: string): CollectorOrigin {
  const raw = instance.includes("://") ? instance : `http://${instance}`;
  const match = /^(https?):\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(raw);
  if (!match || !match[2] || match[2].length > 253
    || !match[2].split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || (match[3] !== undefined && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
    throw new Error("Invalid instance. Use a DNS name or IPv4 address, optional port, or HTTP/HTTPS origin without a path.");
  }
  const url = new URL(raw);
  if (url.hostname !== match[2].toLowerCase()) throw new Error("Invalid instance authority.");
  return parseCollectorOrigin(url.origin);
}
