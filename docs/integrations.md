# Coding-agent integrations

Hotplate captures live metadata from Pi, Codex, Claude Code, OpenCode v1, and OpenCode v2. Capture uses local SQLite. Explicit enrollment enables the existing account relay.

Node 24.19.0 or newer is required. Automatic Codex and Claude Code installation currently requires a POSIX shell. OpenCode plugins invoke Node through a subprocess, so they do not load SQLite inside the plugin runtime.

## Install

Build Hotplate before installing an integration:

```sh
npm ci
npm run build
```

For account-wide installation and continuous relay delivery on Linux with systemd, run:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js setup --relay http://your-aggregate
node /absolute/path/to/hotplate/dist/src/cli.js setup --status
```

`--relay` reuses an existing enrolled account for that origin. For a manually configured account, use `--config /private/account/hotplate.json` instead. Setup installs the available native hosts, saves the account selection and resolved database path, and enables the `hotplate-relay.service` user service. Status reports installation results, the selected endpoint, service state, receiver HTTP reachability, and delivery backlog. A protected dashboard can return HTTP 401 or 403 without indicating an ingest failure. A running service alone does not prove that the receiver accepted data.

For two OpenCode majors, pass `--opencode-v1-config-home /path/to/v1-config-home` and optionally `--opencode-v1-binary /path/to/opencode-v1`. The v1 launcher must use that same `XDG_CONFIG_HOME`. Setup does not rewrite third-party launchers. The selected relay applies to both majors despite their separate configuration directories.

The selection is stored in `~/.config/hotplate/integrations.json`. This account-wide path deliberately does not follow OpenCode's per-version XDG overrides. `HOTPLATE_INTEGRATION_SETTINGS` can select a different settings file for isolated testing.

For individual installation without a relay selection, run the matching command from the project that you want to observe:

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

`HOTPLATE_CONFIG` overrides the saved relay selection. If that variable is unset, a nonempty `HOTPLATE_DB` selects local capture instead. Otherwise native capture uses the account saved by `setup`, or local storage when no selection exists. `HOTPLATE_DISABLED=1` disables capture. `HOTPLATE_NODE_BIN` selects the Node executable used by OpenCode plugins.

An invalid explicit or saved account configuration refuses capture. Setup supervises the relay through the user service. For manual delivery without the service, run:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js relay --config /private/account/hotplate.json
```

The native relay service runs independently of Pi sessions. Stop it with `systemctl --user stop hotplate-relay.service`; disable automatic startup with `systemctl --user disable hotplate-relay.service`. Pi disconnect does not stop this explicit service. Capture does not send HTTP requests or read the ingest token. Prompt text, tool output, credentials, and error bodies do not enter observation storage.

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
