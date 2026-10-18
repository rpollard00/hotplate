import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, linkSync, unlinkSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionCommandContext, ExtensionContext, SessionStartEvent, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { HotplateCollector } from "./collector/collector.js";
import type { CollectorOrigin } from "./domain.js";
import { parseConnectionOrigin, readAccountConfiguration, readIngestToken, type AccountConfiguration } from "./network-config.js";
import { MAX_ENROLLMENT_BYTES, REQUEST_DEADLINE_MS, validateEnrollmentReply } from "./network-protocol.js";
import { parseCollectorOrigin, parseSourceId } from "./observation.js";
import { readRelayStatus, runRelay, type RelayState } from "./relay.js";
import { openCaptureStore, openHotplateStore, resolveHotplateDatabasePath, type DeliveryStatus } from "./store.js";

const LEGACY_CONTROL_SCHEMA = "CREATE TABLE selection (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, intent INTEGER NOT NULL, origin TEXT)";
const CONTROL_SCHEMA = `CREATE TABLE selection (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
  intent INTEGER NOT NULL CHECK(intent >= revision AND intent <= 9007199254740991), origin TEXT) STRICT`;
class ControlStateError extends Error {}

type Selection = { kind: "local"; revision: number } | { kind: "managed"; revision: number; origin: CollectorOrigin };
export type ConnectionCommand = { kind: "connect"; instance: string } | { kind: "status" } | { kind: "disconnect" };
export type ConnectionStatus = {
  mode: "disabled" | "manual" | "local" | "managed" | "unavailable";
  origin: CollectorOrigin | null;
  desiredMode: Selection["kind"] | null;
  desiredOrigin: CollectorOrigin | null;
  desiredRevision: number | null;
  appliedRevision: number | null;
  phase: "enrolling" | "inactive" | "ready" | "transitioning" | "paused" | "closed";
  delivery: DeliveryStatus | null;
  deliveryState: RelayState | "off";
  failure: string | null;
};

export class SessionConnection {
  #collector = new HotplateCollector();
  #control: AccountConnections | undefined;
  #context: ExtensionContext | undefined;
  #applied: Selection | undefined;
  #configuration: AccountConfiguration | undefined;
  #timer: NodeJS.Timeout | undefined;
  #relay: { abort: AbortController; task: Promise<void> } | undefined;
  #enrollments = new Set<AbortController>();
  #transition = Promise.resolve();
  #closed = false;
  #cutoverWaiters = 0;
  #closing: Promise<void> | undefined;
  #failure: string | null = null;
  #phase: ConnectionStatus["phase"] = "inactive";
  #deliveryState: ConnectionStatus["deliveryState"] = "off";
  readonly #env: NodeJS.ProcessEnv;

  constructor(readonly commands: () => readonly SlashCommandInfo[], env: NodeJS.ProcessEnv = process.env) { this.#env = { ...env }; }
  get collector(): HotplateCollector { return this.#collector; }

  async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    if (this.#closed || this.#env.HOTPLATE_DISABLED === "1") return;
    this.#context = ctx;
    try {
      if (this.#env.HOTPLATE_CONFIG !== undefined) {
        this.#configuration = readAccountConfiguration({ path: this.#env.HOTPLATE_CONFIG, env: this.#env });
        this.#collector = this.#newCollector(this.#configuration);
        await this.#collector.sessionStart(event, ctx, this.commands);
        this.#phase = "ready";
        ctx.ui.setStatus("hotplate-connection", undefined);
        return;
      }
      this.#control ??= new AccountConnections(this.#env);
      await this.#reconcile(event);
      if (!this.#closed && !this.#timer) this.#timer = setInterval(() => {
        if (this.#cutoverWaiters === 0) void this.#reconcile({ type: "session_start", reason: "reload" });
      }, 1000);
    } catch (error) {
      this.#fail(error instanceof ControlStateError ? error.message : "Connection state unavailable. Check private storage and configuration, then reload. Capture and managed delivery remain stopped.");
    }
  }

  async execute(command: ConnectionCommand, ctx: ExtensionCommandContext): Promise<ConnectionStatus> {
    if (command.kind === "status") return this.status();
    if (this.#closed || this.#env.HOTPLATE_DISABLED === "1" || this.#env.HOTPLATE_CONFIG !== undefined) {
      this.#failure = "Managed changes are unavailable while disabled, under HOTPLATE_CONFIG, or after shutdown.";
      return this.status();
    }
    if (!this.#control) {
      this.#failure ??= "Hotplate has not initialized. Reload Pi and check /hotplate status.";
      return this.status();
    }
    const control = this.#control;
    let published = false;
    try {
      if (command.kind === "disconnect") {
        control.disconnect();
        published = true;
        for (const abort of this.#enrollments) abort.abort();
        this.#relay?.abort.abort();
      } else {
        const origin = parseConnectionOrigin(command.instance);
        ctx.ui.notify(origin.startsWith("http:")
          ? "Hotplate uses plaintext HTTP on a trusted LAN: metadata and credentials are visible on the network. Open enrollment is not trusted membership."
          : "Hotplate open enrollment permits reachable clients to register metadata; it is not trusted membership.", "warning");
        const intent = control.reserve();
        const configuration = control.prepare(origin);
        const abort = new AbortController();
        this.#enrollments.add(abort);
        try {
          await enroll(configuration, abort.signal);
          if (this.#closed || abort.signal.aborted) return this.status();
          const store = openCaptureStore(configuration);
          await store.close();
          if (this.#closed || abort.signal.aborted) return this.status();
          published = control.activate(intent, origin);
        } finally { this.#enrollments.delete(abort); }
      }
      this.#cutoverWaiters += 1;
      try {
        await ctx.waitForIdle();
        if (!this.#closed) await this.#reconcile({ type: "session_start", reason: "reload" });
      } finally { this.#cutoverWaiters -= 1; }
    } catch {
      this.#failure = published ? "Selection persisted, but this session's cutover did not finish. Check status and private storage."
        : "Connection change failed. Previous selection and reusable identity are retained; check instance, enrollment policy, and private storage.";
    }
    return this.status();
  }

  async status(): Promise<ConnectionStatus> {
    let desired: Selection | undefined;
    let delivery: DeliveryStatus | null = null;
    try {
      if (!this.#closed) desired = this.#control?.selection();
      if (!this.#closed && this.#configuration) {
        const result = await readRelayStatus({ configuration: this.#configuration });
        if (result.kind === "ready") delivery = result.delivery;
      }
    } catch { this.#failure = "Connection status unavailable; private storage could not be read."; }
    return {
      mode: this.#env.HOTPLATE_DISABLED === "1" ? "disabled" : this.#env.HOTPLATE_CONFIG !== undefined ? "manual"
        : desired ? this.#applied?.kind ?? "unavailable" : this.#control || this.#failure ? "unavailable" : "local",
      origin: this.#configuration?.enrollment.collectorOrigin ?? null,
      desiredMode: desired?.kind ?? null,
      desiredOrigin: desired?.kind === "managed" ? desired.origin : null,
      desiredRevision: desired?.revision ?? null, appliedRevision: this.#applied?.revision ?? null,
      phase: this.#closed ? "closed" : this.#enrollments.size > 0 ? "enrolling" : this.#phase === "paused" ? "paused"
        : desired && desired.revision !== this.#applied?.revision ? "transitioning" : this.#phase,
      delivery, deliveryState: this.#deliveryState, failure: this.#failure,
    };
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const abort of this.#enrollments) abort.abort();
    this.#relay?.abort.abort();
    this.#closing = (async () => {
      await this.#transition;
      await this.#stopRelay();
      if (this.#context) await this.#collector.shutdown("quit", this.#context);
      this.#control?.close();
      this.#phase = "closed";
    })();
    return this.#closing;
  }

  #newCollector(configuration?: AccountConfiguration): HotplateCollector {
    const store = configuration ? openCaptureStore(configuration)
      : openHotplateStore({ databasePath: resolveHotplateDatabasePath({ env: this.#env }) });
    return new HotplateCollector({ openStore: () => store, env: this.#env });
  }

  #reconcile(event: SessionStartEvent): Promise<void> {
    this.#transition = this.#transition.then(async () => {
      if (this.#closed || !this.#control || !this.#context) return;
      while (!this.#closed) {
        const selected = this.#control.selection();
        if (selected.revision === this.#applied?.revision) return;
        const configuration = selected.kind === "managed" ? this.#control.read(selected.origin) : undefined;
        this.#phase = "transitioning";
        this.#relay?.abort.abort();
        await this.#collector.shutdown("reload", this.#context);
        await this.#stopRelay();
        if (this.#closed) return;
        if (this.#control.selection().revision !== selected.revision) continue;
        this.#collector = this.#newCollector(configuration);
        await this.#collector.sessionStart(event, this.#context, this.commands);
        if (this.#closed) { await this.#collector.shutdown("quit", this.#context); return; }
        this.#configuration = configuration;
        this.#applied = selected;
        this.#phase = "ready";
        this.#failure = null;
        this.#context.ui.setStatus("hotplate-connection", undefined);
        if (configuration) {
          const abort = new AbortController();
          const task = runRelay({ configuration, signal: abort.signal, maySend: () => {
            if (this.#closed || abort.signal.aborted) return false;
            try { return this.#control?.selection().revision === selected.revision; } catch { return false; }
          }, onState: state => {
            if ((!abort.signal.aborted || state === "stopped") && !this.#closed && this.#applied?.revision === selected.revision) this.#deliveryState = state;
          } }).catch(() => {
            if (!abort.signal.aborted && !this.#closed) {
              this.#deliveryState = "paused";
              this.#fail("Managed delivery paused. Check authorization and private storage; reconnect to retry.");
            }
          });
          this.#relay = { abort, task };
        }
      }
    }).catch(() => { this.#relay?.abort.abort(); this.#fail("Connection reconciliation failed. Managed sends are paused."); });
    return this.#transition;
  }

  async #stopRelay(): Promise<void> {
    const relay = this.#relay;
    this.#relay = undefined;
    if (relay) { relay.abort.abort(); await relay.task; }
    this.#deliveryState = "off";
  }
  #fail(message: string): void { this.#failure = message; this.#phase = "paused"; this.#context?.ui.setStatus("hotplate-connection", message); }
}

class AccountConnections {
  readonly root: string;
  readonly db: DatabaseSync;
  readonly controlPath: string;
  readonly identity: { dev: number; ino: number };
  constructor(env: NodeJS.ProcessEnv) {
    this.root = dirname(resolveHotplateDatabasePath({ env: { ...env, HOTPLATE_DB: "" } }));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    privatePath(this.root, "directory");
    if (realpathSync(this.root) !== this.root) throw new Error("Unsafe account path");
    mkdirSync(join(this.root, "connections"), { recursive: true, mode: 0o700 });
    privatePath(join(this.root, "connections"), "directory");
    this.controlPath = join(this.root, "control.sqlite");
    if (lstatSync(this.controlPath, { throwIfNoEntry: false }) === undefined) this.#publishControl();
    const deadline = Date.now() + 200;
    while (lstatSync(this.controlPath).nlink === 2 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    privatePath(this.controlPath, "file");
    this.identity = lstatSync(this.controlPath);
    this.#checkControl();
    this.db = new DatabaseSync(this.controlPath, { timeout: 100, allowExtension: false });
    try {
      this.#migrateLegacyControl();
      if (this.db.prepare("PRAGMA user_version").get()?.user_version !== 1
        || this.db.prepare("SELECT COUNT(*) AS count FROM selection").get()?.count !== 1) throw new ControlStateError("Unsupported Hotplate control database schema. Existing state was not reset.");
      this.selection();
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      this.#checkControl();
    } catch (error) { this.db.close(); throw error; }
  }
  #migrateLegacyControl(): void {
    if (this.db.prepare("PRAGMA user_version").get()?.user_version !== 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        const schema = this.db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
        const table = schema[0];
        if (schema.length !== 1 || table?.type !== "table" || table.name !== "selection" || table.sql !== LEGACY_CONTROL_SCHEMA
          || this.db.prepare("SELECT COUNT(*) AS count FROM selection").get()?.count !== 1) {
          throw new ControlStateError("Unrecognized legacy Hotplate control database. Existing state was not reset.");
        }
        const selection = this.selection();
        const storedOrigin = this.db.prepare("SELECT origin FROM selection WHERE singleton = 1").get()?.origin;
        if (storedOrigin !== (selection.kind === "local" ? null : selection.origin)) {
          throw new ControlStateError("Invalid legacy Hotplate destination. Existing state was not reset.");
        }
        this.db.exec(`ALTER TABLE selection RENAME TO selection_legacy;
          ${CONTROL_SCHEMA};
          INSERT INTO selection SELECT singleton, revision, intent, origin FROM selection_legacy;
          DROP TABLE selection_legacy;
          PRAGMA user_version = 1;`);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #publishControl(): void {
    const staging = mkdtempSync(join(this.root, ".control-"));
    const path = join(staging, "control.sqlite");
    try {
      writePrivate(path, "");
      const db = new DatabaseSync(path, { timeout: 100, allowExtension: false });
      try {
        db.exec(`PRAGMA synchronous = FULL; BEGIN IMMEDIATE;
          ${CONTROL_SCHEMA};
          INSERT INTO selection VALUES (1, 0, 0, NULL); PRAGMA user_version = 1; COMMIT;`);
      } finally { db.close(); }
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(path, this.controlPath); }
      catch (error) { if (lstatSync(this.controlPath, { throwIfNoEntry: false }) === undefined) throw error; }
      unlinkSync(path);
      syncDirectory(this.root);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  #checkControl(): void {
    privatePath(this.root, "directory");
    if (realpathSync(this.root) !== this.root) throw new Error("Unsafe account path");
    privatePath(this.controlPath, "file");
    const current = lstatSync(this.controlPath);
    if (current.ino !== this.identity.ino || current.dev !== this.identity.dev) throw new Error("Control state replaced");
    for (const suffix of ["-wal", "-shm"]) if (lstatSync(this.controlPath + suffix, { throwIfNoEntry: false })) privatePath(this.controlPath + suffix, "file");
  }
  selection(): Selection {
    this.#checkControl();
    const row = this.db.prepare("SELECT revision, intent, origin FROM selection WHERE singleton = 1").get();
    if (!row || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0
      || typeof row.intent !== "number" || !Number.isSafeInteger(row.intent) || row.intent < row.revision) throw new Error("Invalid control state");
    return row.origin === null ? { kind: "local", revision: row.revision }
      : { kind: "managed", revision: row.revision, origin: parseCollectorOrigin(row.origin) };
  }
  reserve(): number {
    this.selection();
    const row = this.db.prepare("UPDATE selection SET intent = intent + 1 WHERE singleton = 1 RETURNING intent").get();
    if (typeof row?.intent !== "number" || !Number.isSafeInteger(row.intent)) throw new Error("Invalid intent");
    return row.intent;
  }
  activate(intent: number, origin: CollectorOrigin): boolean {
    this.selection();
    return this.db.prepare("UPDATE selection SET revision = intent, origin = ? WHERE singleton = 1 AND intent = ?").run(origin, intent).changes === 1;
  }
  disconnect(): void {
    this.selection();
    this.db.exec("UPDATE selection SET intent = intent + 1, revision = intent + 1, origin = NULL WHERE singleton = 1");
  }
  #bundle(origin: CollectorOrigin): string { return join(this.root, "connections", createHash("sha256").update(origin).digest("hex")); }
  read(origin: CollectorOrigin): AccountConfiguration {
    const bundle = this.#bundle(origin);
    privatePath(join(this.root, "connections"), "directory");
    privatePath(bundle, "directory");
    for (const file of ["account.json", "token"]) privatePath(join(bundle, file), "file");
    const configuration = readAccountConfiguration({ path: join(bundle, "account.json") });
    if (configuration.enrollment.collectorOrigin !== origin || configuration.databasePath !== join(bundle, "capture.sqlite") || configuration.tokenFile !== join(bundle, "token")) throw new Error("Invalid private binding");
    readIngestToken(configuration.tokenFile);
    for (const suffix of ["", "-wal", "-shm"]) if (lstatSync(configuration.databasePath + suffix, { throwIfNoEntry: false })) privatePath(configuration.databasePath + suffix, "file");
    return configuration;
  }
  prepare(origin: CollectorOrigin): AccountConfiguration {
    const bundle = this.#bundle(origin);
    if (lstatSync(bundle, { throwIfNoEntry: false })) return this.read(origin);
    const parent = dirname(bundle);
    privatePath(parent, "directory");
    const staging = mkdtempSync(join(parent, ".preparing-"));
    try {
      writePrivate(join(staging, "token"), randomBytes(32).toString("hex"));
      writePrivate(join(staging, "account.json"), JSON.stringify({ sourceId: parseSourceId(randomUUID()), endpoint: origin, databasePath: "capture.sqlite", tokenFile: "token", trustedHttp: origin.startsWith("http:") }));
      syncDirectory(staging);
      try { renameSync(staging, bundle); }
      catch (error) { if (!existsSync(bundle)) throw error; }
      syncDirectory(parent);
      return this.read(origin);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  close(): void { this.db.close(); }
}

function privatePath(path: string, kind: "directory" | "file"): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600)) throw new Error("Unsafe private storage");
}
function writePrivate(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

async function enroll(configuration: AccountConfiguration, signal: AbortSignal): Promise<void> {
  const endpoint = new URL("/api/enroll", configuration.enrollment.collectorOrigin);
  const body = JSON.stringify({ version: 1, sourceId: configuration.enrollment.sourceId, token: readIngestToken(configuration.tokenFile) });
  if (Buffer.byteLength(body) > MAX_ENROLLMENT_BYTES) throw new Error("Invalid enrollment");
  await new Promise<void>((resolve, reject) => {
    const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
      method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]), maxHeaderSize: 4096,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      if (response.statusCode !== 200 || response.headers["content-encoding"] !== undefined) { response.destroy(); reject(new Error("Enrollment refused")); return; }
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ENROLLMENT_BYTES) { response.destroy(); reject(new Error("Invalid enrollment reply")); }
        else chunks.push(chunk);
      });
      response.once("error", () => reject(new Error("Enrollment failed")));
      response.once("end", () => {
        try { validateEnrollmentReply(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), configuration.enrollment.sourceId); resolve(); }
        catch { reject(new Error("Invalid enrollment reply")); }
      });
    });
    request.once("error", () => reject(new Error("Enrollment failed")));
    request.end(body);
  });
}
