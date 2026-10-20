#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { arch, cpus, loadavg, platform, totalmem } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const databasePath = resolve(option('--db', ''));
if (!args.includes('--db')) throw new Error('Usage: node scripts/analytics-benchmark.mjs --db /path/to/snapshot.sqlite [--output /tmp/benchmark.json] [--samples 2] [--module-root /path/to/compiled/src]');
const outputPath = resolve(option('--output', '/tmp/hotplate-analytics-benchmark.json'));
const sampleCount = Number(option('--samples', '2'));
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) throw new Error('--samples must be between 1 and 10');
const moduleRoot = resolve(option('--module-root', new URL('../dist/src/', import.meta.url).pathname));
const { openHotplateReadStore } = await import(pathToFileURL(resolve(moduleRoot, 'store.js')).href);
const { startDashboardServer } = await import(pathToFileURL(resolve(moduleRoot, 'server.js')).href);
const db = new DatabaseSync(databasePath, { readOnly: true });
const last = db.prepare('SELECT MAX(observed_at) AS last FROM observations').get()?.last;
if (typeof last !== 'string' || !Number.isFinite(Date.parse(last))) throw new Error('A dated workload is required');
const from = new Date(Date.parse(last) - 3_600_000).toISOString();
const middle = new Date(Math.floor((Date.parse(last) - 86_400_000) / 3_600_000) * 3_600_000).toISOString();
const knownModel = db.prepare("SELECT model_provider, model_id FROM observations WHERE model_provider IS NOT NULL AND model_id IS NOT NULL ORDER BY observed_at DESC LIMIT 1").get();
const host = option('--host', 'codex');
const project = option('--project', '/home/reese/projects/hotplate');
const filters = [
  ['all', {}], ['agent', { host }], ['project', { projectCwd: project }],
  ['recent', { fromObservedAt: from, toObservedAt: last }],
  ['matched-unknown-model', { modelSelection: { kind: 'unknown' } }],
  ['combined', { host, modelSelection: { kind: 'unknown' }, fromObservedAt: from, toObservedAt: last }],
  ['historical', { toObservedAt: middle }],
];
if (knownModel) filters.push(['known-model', { modelSelection: { kind: 'known', model: { provider: knownModel.model_provider, id: knownModel.model_id } } }]);
const workload = {
  schemaVersion: db.prepare('PRAGMA user_version').get()?.user_version,
  observations: db.prepare('SELECT evidence_kind, COUNT(*) AS count FROM observations GROUP BY evidence_kind').all(),
  pageCount: db.prepare('PRAGMA page_count').get()?.page_count,
  freePages: db.prepare('PRAGMA freelist_count').get()?.freelist_count,
};
db.close();
const revision = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim(); } catch { return null; } })();
const dirtyDiffSha256 = (() => { try { return createHash('sha256').update(execFileSync('git', ['diff', '--binary'], { cwd: resolve(import.meta.dirname, '..') })).digest('hex'); } catch { return null; } })();
const compiledFiles = [];
function hashCompiled(directory) { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = resolve(directory, entry.name); if (entry.isDirectory()) hashCompiled(path); else if (entry.name.endsWith('.js')) compiledFiles.push({ path: path.slice(moduleRoot.length + 1), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }); } }
hashCompiled(moduleRoot); compiledFiles.sort((left, right) => left.path.localeCompare(right.path));
const compiledTreeSha256 = createHash('sha256').update(JSON.stringify(compiledFiles)).digest('hex');
const result = { revision, dirtyDiffSha256, compiledTreeSha256, compiledFiles, environment: { platform: platform(), arch: arch(), cpuCount: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem(), loadAverage: loadavg() }, node: process.version, databasePath, databaseBytes: statSync(databasePath).size, moduleRoot, workload, startedAt: new Date().toISOString(), sampling: 'New read-only SQLite connection per method sample. First connection and warmed OS cache; no disk-cache drop. Local loopback HTTP; gzip bytes are encoded bytes.', methods: [], http: [], queryPlans: [] };
mkdirSync(dirname(outputPath), { recursive: true });
const persist = () => writeFileSync(outputPath, JSON.stringify(result, null, 2));
const prepare = DatabaseSync.prototype.prepare;
let active;
let supportsTimelines = false;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  for (const name of ['all', 'get']) {
    const original = statement[name];
    statement[name] = function(...params) { const start = performance.now(); const value = original.call(this, ...params); if (active) { active.sqlMs += performance.now() - start; active.rows += Array.isArray(value) ? value.length : value ? 1 : 0; active.queries++; } return value; };
  }
  const original = statement.iterate;
  statement.iterate = function*(...params) { const iterator = original.call(this, ...params); if (active) active.queries++; while (true) { const start = performance.now(); const value = iterator.next(); if (active) active.sqlMs += performance.now() - start; if (value.done) return; if (active) active.rows++; yield value.value; } };
  return statement;
};
try {
  for (let sample = 0; sample < sampleCount; sample++) for (const [filterName, filter] of filters) {
    for (const method of ['queryFilterOptions', 'queryOverview', 'querySkillTable', 'queryModelMatrix', 'querySkillChain', 'queryCaptureHealth', 'queryResources', 'queryResourceCoverage', 'queryContentAnalytics']) {
      const opened = openHotplateReadStore({ databasePath }); if (opened.kind !== 'ready') throw new Error('Missing benchmark database');
      supportsTimelines ||= typeof opened.store.queryContentTimelines === 'function';
      const input = method === 'queryContentAnalytics' ? { content: 'both', measure: 'toolActivity', split: 'agent-model', selection: { kind: 'all' }, filter } : filter;
      active = { rows: 0, queries: 0, sqlMs: 0 }; const cpuStart = process.cpuUsage(); const start = performance.now();
      try {
        const value = await opened.store[method](input); const ms = performance.now() - start; const json = JSON.stringify(value);
        const cpu = process.cpuUsage(cpuStart);
        const row = { sample, filterName, method, input, ms, cpuMs: (cpu.user + cpu.system) / 1000, bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex'), ...active };
        result.methods.push(row); console.log(JSON.stringify(row));
      } finally { active = undefined; await opened.store.close(); }
      persist();
    }
  }
} finally { DatabaseSync.prototype.prepare = prepare; }
const server = await startDashboardServer({ databasePath, port: 0 });
try {
  for (let sample = 0; sample < sampleCount; sample++) for (const [filterName, filter] of filters) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (key === 'modelSelection') params.set('model', value.kind === 'unknown' ? 'unknown' : JSON.stringify([value.model.provider, value.model.id])); else params.set(key, String(value));
    let contentReport;
    for (const scope of ['full', 'skills', 'resources', 'content']) {
      const path = scope === 'content' ? '/api/content-analytics?' + new URLSearchParams([...params, ['content', 'both'], ['measure', 'toolActivity'], ['split', 'agent-model']]) : '/api/dashboard?' + new URLSearchParams([...params, ['scope', scope]]);
      for (const encoding of ['identity', 'gzip']) {
        const start = performance.now(); const response = await http(server.url + path, encoding); const ms = performance.now() - start;
        const json = response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;
        const payload = JSON.parse(json.toString('utf8'));
        if (response.status !== 200 || payload.kind !== 'ready') throw new Error(`Invalid benchmark response: ${path}, HTTP ${response.status}, kind ${payload.kind}`);
        if (scope === 'content') contentReport = payload.report;
        const row = { sample, filterName, scope, encoding, path, ms, status: response.status, wireBytes: response.body.length, decodedBytes: json.length, sha256: createHash('sha256').update(json).digest('hex') };
        result.http.push(row); console.log(JSON.stringify(row)); persist();
      }
    }
    if (supportsTimelines && contentReport) {
      const projection = new URLSearchParams([...params, ['content', 'both'], ['measure', 'toolActivity'], ['split', 'agent-model']]);
      for (const row of contentReport.selection.rows.slice(0, 24)) projection.append('rowKey', row.key);
      for (const cohort of contentReport.selection.series.slice(0, 6)) projection.append('cohortKey', cohort.key);
      if (!contentReport.selection.rows.length) projection.append('rowKey', 'unknown');
      const path = '/api/content-timelines?' + projection;
      for (const encoding of ['identity', 'gzip']) {
        const start = performance.now(); const response = await http(server.url + path, encoding); const ms = performance.now() - start;
        const json = response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body;
        const payload = JSON.parse(json.toString('utf8'));
        if (response.status !== 200 || payload.kind !== 'ready') throw new Error(`Invalid timeline benchmark response: HTTP ${response.status}, kind ${payload.kind}`);
        result.http.push({ sample, filterName, scope: 'timelines', encoding, path, ms, status: response.status, wireBytes: response.body.length, decodedBytes: json.length, sha256: createHash('sha256').update(json).digest('hex') });
        persist();
      }
    }
  }
} finally { await server.close(); }
const planDb = new DatabaseSync(databasePath, { readOnly: true });
try {
  for (const [name, sql, params] of [
    ['observation-evidence-time', "SELECT id FROM observations WHERE evidence_kind = ? AND observed_at >= ?", ['read-result', from]],
    ['resource-bucket', "SELECT observation_id FROM resource_access_facts WHERE bucket_start = ? AND access IN ('open','access')", [new Date(Math.floor(Date.parse(from) / 3_600_000) * 3_600_000).toISOString()]],
    ['inventory-history-seek', 'SELECT observation_id FROM inventory_location_buckets WHERE machine_id = ? AND source_id = ? AND variant_id = ? ORDER BY last_at DESC,producer_id DESC,sequence DESC,observation_id DESC,resource_order DESC LIMIT 1', ['local', 'local', 1]],
  ]) {
    try { result.queryPlans.push({ name, sql, params, plan: planDb.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) }); } catch (error) { result.queryPlans.push({ name, sql, error: String(error) }); }
  }
} finally { planDb.close(); }
persist();
function http(url, encoding) {
  return new Promise((resolveResponse, reject) => { const outgoing = request(url, { headers: { 'accept-encoding': encoding } }, incoming => { const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.once('error', reject); incoming.once('end', () => resolveResponse({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) })); }); outgoing.once('error', reject); outgoing.end(); });
}
