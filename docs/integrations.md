# Coding-agent integrations

Hotplate captures live metadata from Pi, Codex, Claude Code, OpenCode v1, and OpenCode v2. Capture uses local SQLite. Explicit enrollment enables the existing account relay.

Node 24.19.0 or newer is required. Automatic Codex and Claude Code installation currently requires a POSIX shell. OpenCode plugins invoke Node through a subprocess, so they do not load SQLite inside the plugin runtime.

## Install

Build Hotplate before installing an integration:

```sh
npm ci
npm run build
```

Run the matching command from the project that you want to observe:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js integration install codex
node /absolute/path/to/hotplate/dist/src/cli.js integration install claude-code
node /absolute/path/to/hotplate/dist/src/cli.js integration install opencode-v1
node /absolute/path/to/hotplate/dist/src/cli.js integration install opencode-v2
```

Choose one OpenCode major for each configuration. `--binary /path/to/opencode` selects the executable for version verification. Installation refuses a mismatched major. It does not upgrade the host.

Add `--global` to install for your account. Codex uses `hooks.json`; Claude Code uses project `settings.local.json` or account `settings.json`. OpenCode v1 uses a plugin entry in `opencode.json`. OpenCode v2 uses an owned `hotplate.js` wrapper in the project `.opencode/plugins/` directory or the account OpenCode `plugins/` directory. The installer refuses to replace an unrelated wrapper file.

Installation preserves unrelated JSON entries. Malformed JSON and existing OpenCode JSONC cause an explicit refusal. Keep the Hotplate installation path stable because installed entries use absolute paths.

For Codex, review and trust the installed definition through `/hooks`. Codex skips new or changed hooks until you trust them. Hotplate does not change that trust policy. [Codex hook trust](https://learn.chatgpt.com/docs/hooks)

Restart the host after installation. Inspect or remove the integration with:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js integration status
node /absolute/path/to/hotplate/dist/src/cli.js integration status opencode-v2 --global
node /absolute/path/to/hotplate/dist/src/cli.js integration remove claude-code
```

Removal affects matching Hotplate entries only. It retains captured observations. Status describes configuration and supported evidence; installation alone does not prove that a hook ran.

## Evidence coverage

| Host | Captured evidence | Limits |
| --- | --- | --- |
| Pi | Existing command, wrapper, read, catalog, and gap evidence | Existing extension behavior |
| Codex | Read attempts from a literal `cat /absolute/path/SKILL.md` completion | No success/failure claim; relative paths and compound shell commands are excluded |
| Claude Code | `Read` results and `Skill` invocation results | Direct slash expansion and denied calls before execution are not captured |
| OpenCode v1 | Supported `read` and `skill` completion hooks | The tested runtime does not fire this hook for failed tool calls; those failures are not captured |
| OpenCode v2 | Supported `read` and `skill` completion/error hooks | Separate adapter and native event contract from v1 |

Read attempts and native skill invocations have separate counts. They do not increase successful reads, read-based skill shares, or model-read counts. Missing model and run attribution stays unknown.

The installed Codex hook sends shell output without an exit status. Hotplate does not inspect that output to guess success. An absolute literal path avoids attributing a relative path to the wrong working directory.

New Pi observations identify their host. Existing untagged data remains `unknown`, because library-created rows cannot reliably be identified as Pi. The dashboard's Agent host filter separates integrations, including OpenCode majors.

## Capture and delivery

`HOTPLATE_DB` selects a local database. `HOTPLATE_DISABLED=1` disables capture. `HOTPLATE_NODE_BIN` selects the Node executable used by OpenCode plugins.

Set `HOTPLATE_CONFIG` to a valid explicit account configuration to enroll new observations. An invalid explicit configuration refuses capture. Run the existing relay separately:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js relay --config /private/account/hotplate.json
```

Native adapters do not use Pi's managed session relay. Capture does not send HTTP requests or read the ingest token. Prompt text, tool output, credentials, and error bodies do not enter observation storage.

Repeated native occurrences reuse a durable receipt. A repeated delivery retains the original observation and timestamp. Changed metadata under the same identity produces a capture failure.

Capture has a bounded process deadline and reports failures without blocking the agent. An unavailable database or killed process can lose an uncommitted observation. No successful installation or missing gap count proves complete coverage.

## Upgrade and verification

Upgrade the aggregate before enabling new integrations. New host evidence uses protocol version 2. Existing version-1 outbox payloads and canonical digests remain unchanged. Schema version 4 adds host and evidence support.

Writer opens migrate existing databases. Back up databases before upgrading. The current read-only dashboard requires a writer migration before it can read an older database.

Run the repository checks and deterministic host smoke tests:

```sh
npm run check
npm run pack:dry
node scripts/native-host-smoke.mjs codex
node scripts/native-host-smoke.mjs claude-code
node scripts/capture-smoke.mjs
node scripts/probe-opencode.mjs 1 /absolute/path/to/opencode-v1
node scripts/probe-opencode.mjs 2 /absolute/path/to/opencode-v2
```

The smoke tests use temporary projects and a local deterministic provider. They execute real host tools and production capture without account credentials. They do not test authenticated provider behavior.

OpenCode adapter tests verify each major separately. Live runtime evidence and remaining limitations are recorded in the [verification report](integration-verification.md).
