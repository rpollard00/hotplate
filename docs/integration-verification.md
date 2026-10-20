# Integration verification

This report separates earlier verification from the tool-capture changes.
The historical results do not establish current runtime coverage or current test counts.
The [integration guide](integrations.md#evidence-coverage) describes the implemented host contracts and limits.

## Tool-capture checks

The tool-capture checks cover structured reads, recognized literal commands, opaque operations, requested and returned portions, and unknown outcomes.
They also cover duplicate receipts, protocol compatibility, migration, privacy, and exclusion of filesystem events from default metrics.
The watcher tests run the deactivation script against isolated systemd fixtures. They do not stop the account's real service.

Run these checks against the current build:

```sh
npm run check
npm run pack:dry
node scripts/tool-capture-smoke.mjs
node scripts/native-host-smoke.mjs codex
node scripts/native-host-smoke.mjs claude-code
node scripts/capture-smoke.mjs
node scripts/probe-opencode.mjs 1 /absolute/path/to/opencode-v1
node scripts/probe-opencode.mjs 2 /absolute/path/to/opencode-v2
npm run smoke:dashboard
node scripts/dashboard-lazy-smoke.mjs
node scripts/dashboard-motion-smoke.mjs
node scripts/dashboard-coverage-smoke.mjs
node scripts/resource-dashboard-smoke.mjs
```

The installed host executables must be available for native checks. Rebuild before checking changed source files.
The tool-capture smoke uses temporary configuration. It checks that content and command canaries do not enter storage.
Native runtime checks use local deterministic providers. They do not establish behavior for authenticated providers or every host version.

## Current tool-capture verification

Verified on 2026-10-20 with Node 24.19.0 in an isolated worktree:

- `npm run check` passed: 365 core tests, 22 deployment tests, and 2 dashboard preview tests.
- `npm run pack:dry` passed.
- `node scripts/tool-capture-smoke.mjs` passed 17 captures and four duplicate retries. It verified nine reference reads, four opaque operations, requested and returned ranges, and absence of content and command canaries. Maximum capture time was 158 ms.
- `node scripts/capture-smoke.mjs` passed 29 captures and one duplicate retry. Sequential p95 was 128 ms; burst p95 was 189 ms. Timing depends on machine load.

The current tests cover protocol-v4 delivery through an aggregate, schema-v7 migration with historical data and foreign keys, replay after Pi collector recreation, literal path semantics, and exclusion of filesystem floods from default metrics.
An independent reviewer also compared 38 valid legacy observation shapes against the baseline serializer. Their serialized bytes matched.

| Host version | Current runtime result |
| --- | --- |
| Pi SDK 0.87.1 | Real SDK tools and collector lifecycle tests passed for structured reads, shell and Python references, failures, path prefixes, duplicate replay, and model attribution. |
| Codex 0.163.0 | Absolute skill and reference targets produced attempts. A relative read in a different workdir produced opaque coverage and no false attribution to a project shadow file. |
| Claude Code 2.1.304 | Successful and failed reads, a reference read, and a native invocation reached storage. A separate persistent-directory probe verified that hook cwd follows Bash directory changes. |
| OpenCode 1.18.33 | The installed v1 plugin recorded two skill reads, a reference read, and a native invocation. The host did not report the failed read through its completion hook. |
| OpenCode 2.0.32 | The installed v2 plugin recorded reads, a failed read, and an invocation. Real long-line truncation in file and final-page results retained unknown delivery. |

Native checks used isolated configuration and local deterministic providers. They verified that synthetic tool content did not enter storage.
The Pi result is SDK runtime coverage; it does not establish an end-to-end session with every installed Pi executable version.
Initial native runs failed during observed CPU saturation. Saturation is a possible cause, not a proven explanation. Subsequent runs passed without relaxing deadlines or assertions.

The default dashboard was inspected at 1280 × 800 and 390 × 844.
Six tool records stayed separate from 400 filesystem events. Reference-only activity, partial delivery, unknown outcomes, diagnostic measures, and filter reset behaved as expected, with no page overflow or console errors.
Independent browser verification confirmed that loading, failure, and retry hide coverage from the previous scope until the current response succeeds.
Main dashboard, lazy-loading, motion, coverage-recovery, and resource browser smoke checks passed.
After a final table-width adjustment, the build, both preview tests, and lazy-loading/resource browser checks passed again. Desktop and mobile screenshots retained readable headers and table scrolling.

Independent gpt-6-astra reviewers inspected capture, storage, adapters, analytics, dashboard behavior, and watcher deactivation. All six findings were fixed and rechecked. A separate comment review found no added comments or suppressions requiring removal.
The eight deactivation tests execute the actual script against isolated systemd fixtures. No real watcher was stopped and no production deployment was performed.

## Prior runtime verification

The following checks preceded protocol version 4 and the shared tool-read parser.
Verification used Node 24.19.0 and isolated temporary host configuration.
Local deterministic model providers drove real tools without account credentials or changes to personal host settings.

| Host version | Runtime result |
| --- | --- |
| Codex 0.158.0 | Two shell read completions produced two read attempts. Neither increased successful reads. |
| Claude Code 2.1.283 | A native skill invocation, a successful read, and a failed read each reached SQLite. |
| OpenCode 1.18.33 | The production installer loaded the v1 plugin. Two successful reads and a native skill invocation reached SQLite. The failed read did not fire the native completion hook. |
| OpenCode 2.0.15 | The production installer activated the v2 plugin. Two successful reads, a failed read, and a native skill invocation reached SQLite. |

The tested Codex hook sent tool output as a string without an exit status.
Hotplate recorded an attempt and did not infer an outcome from the output.
That implementation accepted only a literal absolute `SKILL.md` path.
The current parser accepts the additional forms documented in [supported tool reads](integrations.md#supported-tool-reads).

OpenCode v2 uses an auto-discovered wrapper because configured file entries did not activate in the tested runtime. The OpenCode smoke tests select the project explicitly (`--dir` in v1 and a project session in v2) and verify project attribution.

The native smoke tests assert that synthetic tool-content canaries do not enter SQLite. They verify real host hooks and production capture. They do not establish coverage for other host versions or authenticated model providers. OpenCode session resume and subagent sessions remain unverified.

## Prior storage and delivery verification

Tests cover durable duplicate receipts, changed metadata under the same receipt, metadata bounds, SQLite migration, immutable version-1 backlog bytes, and mixed protocol versions. Receiver rejection of new protocol evidence retains the backlog for an aggregate upgrade.

Read attempts and native invocations stay separate from successful reads in analytics. New host metadata does not reclassify historical untagged observations.

## Prior timing and dashboard verification

A production CLI smoke test wrote 28 distinct observations and retried a duplicate. Final p95 capture time was 126 ms sequentially and 134 ms in an eight-process burst, below the 250 ms sequential target and 750 ms capture deadline. Timing depends on the machine and database load.

The dashboard was inspected in the shared browser at 1280 × 800 and 390 × 844. Selecting Codex showed read attempts with zero successful reads. The path view retained the attempt evidence. No horizontal overflow or browser console errors were observed.

The full repository check passed 155 tests: 131 core tests, 22 deployment tests, and 2 preview tests. A separate 15-test adapter and installer run passed, including four additional installer regressions. Package dry-run validation also passed.

Independent GPT-6-Astra reviewers inspected capture, protocol, migration, adapters, and installation. They reproduced the Codex, Claude Code, and capture smoke tests in a separate build. Dashboard visual inspection was performed by the implementation agent in the shared browser.

## Prior account-wide relay verification

The follow-up setup implementation passed all 169 repository tests. Coverage includes all-host installation, repeat setup, separate OpenCode configuration, service ownership, receiver reachability, and consistent database selection across capture and relay.

Local acceptance verified all four installations against the existing enrolled aggregate. The systemd user relay was enabled and running. The receiver returned HTTP 200, and the backlog had zero pending or blocked observations. An authenticated retry of an existing observation returned one duplicate and zero new records.

The aggregate required recovery from a failed schema migration. A fresh backup preceded migration and recovery. The permanent image sets `SQLITE_TMPDIR=/data` for its read-only root filesystem. Deployment and dashboard health checks passed after replacement. No database backup was restored.
