import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];
const fields = new Set(['session_id', 'turn_id', 'tool_use_id', 'agent_id', 'hook_event_name', 'tool_name', 'tool_input', 'tool_response', 'command', 'file_path', 'skill', 'success', 'exit_code', 'exitCode', 'stdout', 'stderr', 'output', 'content', 'type', 'duration_ms', 'file', 'filePath', 'numLines', 'startLine', 'totalLines', 'source', 'model', 'cwd', 'transcript_path', 'permission_mode', 'error', 'is_interrupt', 'name', 'baseDir']);

function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (depth > 4) return typeof value;
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, shape(item, depth + 1)]));
}

if (process.argv[2] === '--hook') {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const record = { event: events.includes(input.hook_event_name) ? input.hook_event_name : 'other', schema: shape(input) };
  if (['Read', 'Skill', 'Bash'].includes(input.tool_name)) record.tool = input.tool_name;
  for (const key of ['session_id', 'turn_id', 'tool_use_id', 'agent_id']) {
    if (typeof input[key] === 'string') record[key] = createHash('sha256').update(input[key]).digest('hex').slice(0, 16);
  }
  for (const key of ['exit_code', 'exitCode', 'success']) {
    const value = input.tool_response?.[key];
    if (typeof value === 'number' || typeof value === 'boolean') record[key] = value;
  }
  if (typeof input.tool_input?.command === 'string') {
    record.exactProbeRead = input.tool_input.command === 'cat .agents/skills/hotplate-probe/SKILL.md';
  }
  appendFileSync(process.argv[3], `${JSON.stringify(record)}\n`, { mode: 0o600 });
  process.exit(0);
}

const target = process.argv[2];
if (!['codex', 'claude'].includes(target)) {
  process.stderr.write('Usage: node scripts/probe-native-hooks.mjs codex|claude [output-directory]\n');
  process.exit(2);
}
const output = resolve(process.argv[3] ?? '.audit/probe-codex-claude');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'hotplate-native-probe-'));
const config = join(scratch, 'config');
const project = join(scratch, 'project');
const receipt = join(scratch, 'hooks.jsonl');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  mkdirSync(config);
  mkdirSync(project);
  const skillDir = join(project, target === 'codex' ? '.agents/skills/hotplate-probe' : '.claude/skills/hotplate-probe');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: hotplate-probe\ndescription: Synthetic hook capability probe.\n---\nReply with probe complete. Do not edit files.\n');
  const command = `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --hook ${quote(receipt)}`;
  const supportedEvents = target === 'codex' ? events.filter((event) => event !== 'PostToolUseFailure') : events;
  const hooks = Object.fromEntries(supportedEvents.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]]));
  const configuration = join(config, target === 'codex' ? 'hooks.json' : 'settings.json');
  writeFileSync(configuration, JSON.stringify({ hooks }));
  if (target === 'codex') writeFileSync(join(config, 'config.toml'), '');
  const prompt = target === 'codex'
    ? 'Use exec_command to run exactly cat .agents/skills/hotplate-probe/SKILL.md. Then run exactly cat absent/SKILL.md to probe failure. Do not edit files. Reply briefly.'
    : 'Invoke the hotplate-probe skill with the Skill tool. Then use Read on .claude/skills/hotplate-probe/SKILL.md and absent/SKILL.md. Do not edit files. Reply briefly.';
  const args = target === 'codex'
    ? ['exec', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--ignore-rules', '-s', 'read-only', '--json', prompt]
    : ['-p', '--no-session-persistence', '--setting-sources', '', '--settings', configuration, '--tools', 'Read,Skill', '--permission-mode', 'dontAsk', '--output-format', 'json', prompt];
  const env = { ...process.env, [target === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: config };
  const version = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const started = performance.now();
  const result = spawnSync(target, args, { cwd: project, env, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const elapsedMs = Math.round(performance.now() - started);
  let records = [];
  try { records = readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const report = {
    target,
    version: version.stdout?.trim().match(/(?:codex-cli )?\d+\.\d+\.\d+(?: \(Claude Code\))?/)?.[0] ?? 'unknown',
    elapsedMs,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    authUnavailable: /not logged in|authentication|unauthorized|missing.*(?:api|auth)|sign in|login|401/i.test(raw),
    rawOutputRetained: false,
    configurationIsolation: true,
    hookRecords: records,
    successfulToolHooks: records.filter((record) => record.event === 'PostToolUse').length,
  };
  writeFileSync(join(output, `${target}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
