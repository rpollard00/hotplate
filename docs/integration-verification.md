# Integration verification

Verification used Node 24.19.0 and isolated temporary host configuration. Local deterministic model providers drove real tools. These checks did not use account credentials or modify personal host settings.

## Runtime coverage

| Host version | Runtime result |
| --- | --- |
| Codex 0.158.0 | Two shell read completions produced two read attempts. Neither increased successful reads. |
| Claude Code 2.1.283 | A native skill invocation, a successful read, and a failed read each reached SQLite. |
| OpenCode 1.18.33 | The production installer loaded the v1 plugin. Two successful reads and a native skill invocation reached SQLite. The failed read did not fire the native completion hook. |
| OpenCode 2.0.15 | The production installer activated the v2 plugin. Two successful reads, a failed read, and a native skill invocation reached SQLite. |

Codex sends tool output as a string without an exit status in the tested hook. Hotplate records an attempt and does not infer an outcome from the output. The integration accepts only a literal absolute `SKILL.md` path in the supported shell command.

OpenCode v2 uses an auto-discovered wrapper because configured file entries did not activate in the tested runtime. The OpenCode smoke tests select the project explicitly (`--dir` in v1 and a project session in v2) and verify project attribution.

The native smoke tests assert that synthetic tool-content canaries do not enter SQLite. They verify real host hooks and production capture. They do not establish coverage for other host versions or authenticated model providers. OpenCode session resume and subagent sessions remain unverified.

## Storage and delivery

Tests cover durable duplicate receipts, changed metadata under the same receipt, metadata bounds, SQLite migration, immutable version-1 backlog bytes, and mixed protocol versions. Receiver rejection of new protocol evidence retains the backlog for an aggregate upgrade.

Read attempts and native invocations stay separate from successful reads in analytics. New host metadata does not reclassify historical untagged observations.

## Timing and dashboard

A production CLI smoke test wrote 28 distinct observations and retried a duplicate. Final p95 capture time was 126 ms sequentially and 134 ms in an eight-process burst, below the 250 ms sequential target and 750 ms capture deadline. Timing depends on the machine and database load.

The dashboard was inspected in the shared browser at 1280 × 800 and 390 × 844. Selecting Codex showed read attempts with zero successful reads. The path view retained the attempt evidence. No horizontal overflow or browser console errors were observed.

The full repository check passed 155 tests: 131 core tests, 22 deployment tests, and 2 preview tests. A separate 15-test adapter and installer run passed, including four additional installer regressions. Package dry-run validation also passed.

## Repeat the checks

```sh
npm run check
npm run pack:dry
node scripts/native-host-smoke.mjs codex
node scripts/native-host-smoke.mjs claude-code
node scripts/capture-smoke.mjs
node scripts/probe-opencode.mjs 1 /absolute/path/to/opencode-v1
node scripts/probe-opencode.mjs 2 /absolute/path/to/opencode-v2
```

The installed host executables must be available for the native smoke tests. Rebuild before testing changed source files.

Independent GPT-6-Astra reviewers inspected capture, protocol, migration, adapters, and installation. They reproduced the Codex, Claude Code, and capture smoke tests in a separate build. Dashboard visual inspection was performed by the implementation agent in the shared browser.
