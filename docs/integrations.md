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
| Pi | `read` results, `bash` reads, selected Python tool attempts, and existing command, wrapper, catalog, and gap evidence | Custom Python tool success remains unreported |
| Codex | Recognized reads and opaque coverage from `Bash` completions | The hook supplies no exit status, so recognized targets remain attempts |
| Claude Code | `Read` results, `Skill` invocation results, and `Bash` attempts or opaque coverage | Bash completion supplies no exit status. Direct slash expansion and pre-execution denial remain outside capture |
| OpenCode v1 | `read`, `skill`, and `bash` completion hooks | Failed tool calls without a completion hook remain outside capture |
| OpenCode v2 | `read`, `skill`, `bash`, and `shell` completion/error hooks | Shell success requires a reported exit status. Running operations remain attempts |

Tool capture qualifies paths against selected resource roots. It includes supporting references without a preceding `SKILL.md` read or a native skill invocation.
Relative paths require a working directory established by the host's tool contract. The host project directory is used only when that contract defines it as the tool's default.
Missing model and run attribution stays unknown.

Confirmed reads, inferred reads, attempts, and native invocations retain separate counts.
Inferred reads and attempts do not increase confirmed reads or legacy read-based skill shares.
Codex and Claude Bash output text cannot establish success. Hotplate does not inspect that text to guess an outcome.

New Pi observations identify their host. Existing untagged data remains `unknown`, because library-created rows cannot reliably be identified as Pi. The dashboard's Agent host filter separates integrations, including OpenCode majors.

## Supported tool reads

Structured read tools report a file path and can report a requested line range.
A successful structured read produces a confirmed read. An error produces a read failure.

Shell capture statically parses a command and recognizes these readers:

| Form | Requested portion |
| --- | --- |
| `cat [-n] [--] path...` | Whole files |
| `nl path...` | Whole files |
| `head [-n N \| -N] [--] path...` | First `N` lines, or 10 lines without `-n` |
| `tail -n +N [--] path...` or `tail +N path` | Lines from `N` to the end |
| `tail [-n N \| -N] [--] path...` | Unknown portion |
| `sed -n 'Np' [--] path` | One line |
| `sed -n 'N,Mp' [--] path` | Inclusive line range |
| `sed -n 'N,$p' [--] path` | Lines from `N` to the end |
| `python -c 'expression'` or `python3 -c 'expression'` | Whole file from the supported Python forms |

`N` and `M` must be positive integers, with `M` no smaller than `N`.
`sed` accepts one file. A reader without file operands reads `< path` as its target. Other flags and executable paths remain unsupported.
Readers can appear in any pipeline stage and in lists joined by `&&`, `||`, `;`, or newlines.
`#` comments, leading `NAME=value` prefix assignments, unquoted `~` and `~/...`, and `$HOME` or `${HOME}` are supported.
Literal quoting and escaped spaces are supported.
A reader target with a `..` segment is dropped, and coverage becomes opaque `missing-input`, because the shell resolves it against the physical directory.
Redirections apply left to right. A read requires the reader's final stdout to reach the original stdout or stderr.
Piped content must pass through stdin filters to that destination. `2>/dev/null` and `1>&2 2>/tmp/x` are reads. `>/tmp/x` and `2>/tmp/x >&2` are not.

`cd` tracks the working directory. `cd` without arguments goes home.
`cd -` (also after `--`), `pushd`, `popd`, and a `cd` reached through `||` make the directory unknown.
The new directory applies to the following `&&` chain. A later `||` in the same list makes it unknown, except after the guard `cd path || exit [N]`.
After `;` or a newline, the new directory remains only when the `cd` was unconditional. `test -d x && cd x; cat f` has an unknown directory.
A `cd` inside a multi-command pipeline has no effect.
Relative targets resolve against the tracked directory. Targets that cannot resolve are dropped, and coverage becomes opaque `missing-input`.
Codex Bash hooks report the session directory and omit a command's `workdir`. Hotplate accepts only absolute targets from these hooks.
Claude Bash hooks track persistent working-directory changes.

The reported tool outcome applies to a reader only when every connector is `&&` and the reader is alone in its pipeline.
Other readers produce attempts.
`echo`, `printf`, `true`, `false`, `pwd`, `ls`, `export`, `exit`, `return`, `[`, `test`, `[[ ... ]]`, and stdin filters after a pipe (`head`, `tail`, `sed`, `grep`, `rg`, `wc`, `sort`, `uniq`, `cut`, `tr`, `nl`, `cat`, `awk`, `jq`, `less`) are understood.
Any other command makes coverage opaque `unsupported-syntax`, and the recognized readers still produce evidence.

Opacity is per step. A step is opaque when a word holds command substitution, backticks, process substitution, `$((...))` or `$[...]`, an unknown variable, `$?` or another special parameter, `${...}` beyond `${NAME}`, `~user`, brace expansion, `**`, or a glob that cannot expand.
Background `&` and interpreters fed a heredoc (`python3 - <<EOF`) are opaque steps.
Hotplate models `cd`, `pushd`, `popd`, assignments, `export`, `echo`, `printf` without `-v`, `true`, `false`, `:`, `test`, `[`, `[[`, `pwd`, `exit`, `return`, `break`, `continue`, and external commands.
Every other bash builtin (`eval`, `source`, `.`, `builtin`, `command`, `exec`, `declare`, `read`, `set`, `trap`, `alias`, `let`, `umask`, and so on), `printf -v`, a call to a function defined in the command, and an opaque command word are opaque steps. No later step emits after one runs, even when it is reached through `&&` or `||`.
An opaque step emits nothing. Coverage becomes opaque `unsupported-syntax`, and every target in the command becomes an attempt. Other steps still emit.
An opaque step makes the directory unknown only when it can change it: `cd`, `pushd`, `popd`, one of the forms above, or a block whose body can.
External commands with opaque arguments keep the directory.
`exit`, `return`, or a block that contains one ends the command when reached unconditionally. After `a || exit 1`, later steps still run.
A function definition emits nothing and makes the directory unknown.
Unterminated quotes, substitutions or heredocs, control characters, nesting deeper than 32 levels, and the size limits make the whole command opaque.

Assignment-only steps (`S=/x/skills`, `export S=/x/skills`) define variables for later steps. Values expand `~`, `$HOME`, and known variables. An opaque value makes the variable unknown.
Only assignments reached by `;`, a newline, or the start define a variable. Assignments after `&&` or `||`, prefix assignments, and assignments inside multi-command pipelines do not.
`$NAME` and `${NAME}` expand known variables, unquoted or in double quotes. An unquoted value with whitespace or glob characters makes the word opaque.
`${NAME:=...}`, `$((...))`, `$[...]`, `((...))`, `for ((...))`, array subscript assignments, and `[[ ... -eq ... ]]` make all variables unknown, also in assignment values and redirect targets.
An assignment or `export` of `HOME`, `CDPATH`, `PWD`, `OLDPWD`, `GLOBIGNORE`, `FIGNORE`, `GLOBSORT`, `BASH_ENV`, `ENV`, `POSIXLY_CORRECT`, `SHELLOPTS` or `BASHOPTS`, and a persistent `IFS=` assignment, make the whole command opaque.

Native hooks expand unquoted `*`, `?`, and `[...]` against the filesystem with bash defaults: names that start with `.` match only a pattern that starts with `.`, and results are sorted.
Globs expand in command arguments and in `for` word lists. A reader operand without a match is dropped. A glob in a `cd` argument, a command word, or a redirect target is opaque.
A scan over 10,000 directory entries or a result over 128 paths makes the word opaque.
Interpreted steps, loop iterations, glob directory entries, and glob matching share one work budget per tool call. When the budget runs out, the whole command is opaque `limit` without evidence.

`for NAME in WORDS; do BODY; done` runs the body once for each word, with the directory at loop entry. Loop targets are attempts.
The loop is opaque when a word is opaque or is a glob without a match, when it has more than 128 words, when the body can change the directory or uses `break` or `continue`, or when the loop has redirections.
`if`, `while`, `until`, `case`, `select`, `{ ... }`, `( ... )`, `((...))`, `!`, `time`, and pipelines with a compound command are opaque blocks.
A `( ... )` subshell keeps the directory and variables. Other blocks make the directory unknown when their body can change it, and make variables unknown when their body can assign them.

Heredoc bodies (`<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`) and herestrings (`<<<word`) are data. A reader whose stdin is a heredoc or herestring reads no file.
`a |& b` is `a 2>&1 | b`.

The Python parser accepts these forms:

```python
open("path").read()
open("path", "r").read()
from pathlib import Path; Path("path").read_text()
import pathlib; pathlib.Path("path").read_text()
```

Each expression can have an outer `print(...)`.
The required `pathlib` import uses the same line and semicolon shown here.
Pi also applies this parser to the `code` input of `python`, `python_exec`, and `execute_python`.
Those custom tools do not establish success from the absence of `isError`.

The parser rejects compounds, pipelines, redirection, substitutions, globs, variable paths, multiline code, comments, and arbitrary scripts such as `python analyze.py`.
Commands have a 32,768-character limit. Paths have a 4,096-character limit, and each operation can select at most 128 file targets.
Repeated aliases for one physical file count once per operation.

A recognized command with a successful tool outcome produces an inferred read.
Without that outcome, its targets remain read attempts.
A failed command can read some files before it fails. Its operation records the failure, but each target retains an unconfirmed outcome.
Command capture does not establish a returned portion, even for a recognized `print(...)`.

Unresolved operations produce opaque coverage with a bounded reason, not file rows.
Pi `powershell` and Claude `PowerShell` report opaque coverage.
Unrecognized tool names and operations that produce no supported hook remain outside capture.
Tool coverage is not a completeness percentage.

## Requested and returned portions

Hotplate stores requested portions separately from reported returned portions.
Line ranges use a one-based start and a count. An unknown count does not prove that the result contained the rest of the file.

| Host | Returned portion evidence |
| --- | --- |
| Pi | Structured truncation details, when they report whole output lines |
| Codex | Unknown |
| Claude Code | Structured text-file start line, line count, and token-cap truncation |
| OpenCode v1 | Unknown |
| OpenCode v2 | A positively truncated text page with valid start and next-line metadata |

Missing delivery metadata remains unknown. Failed reads do not establish delivery.
OpenCode v2 can shorten long lines in both whole-file and paged output. Its `truncated: false` page flag only means that no further page remains.
These outputs do not prove complete delivery. A positively truncated page records its reported line span and retains the truncation flag.
Content revisions remain unknown. Hotplate does not reopen files to calculate a hash or reconstruct returned content.
The dashboard exposes these fields in file details under **Read portions**.

## Capture and delivery

`HOTPLATE_CONFIG` overrides the saved relay selection. If that variable is unset, a nonempty `HOTPLATE_DB` selects local capture instead. Otherwise native capture uses the account saved by `setup`, or local storage when no selection exists. `HOTPLATE_DISABLED=1` disables capture. `HOTPLATE_NODE_BIN` selects the Node executable used by OpenCode plugins.

An invalid explicit or saved account configuration refuses capture. Setup supervises the relay through the user service. For manual delivery without the service, run:

```sh
node /absolute/path/to/hotplate/dist/src/cli.js relay --config /private/account/hotplate.json
```

The native relay service runs independently of Pi sessions. Stop it with `systemctl --user stop hotplate-relay.service`; disable automatic startup with `systemctl --user disable hotplate-relay.service`. Pi disconnect does not stop this explicit service. Capture does not send HTTP requests or read the ingest token. Prompt text, tool output, credentials, and error bodies do not enter observation storage.
Shell commands and Python source serve only as extraction input. They do not enter persisted evidence or relay payloads.

The filesystem watcher is optional. `scripts/deactivate-watcher` stops and disables the managed watcher for the current account while preserving history and relay delivery.
See [watcher deactivation](resources.md#deactivate-the-filesystem-watcher) for the ownership checks and scope.

Repeated native occurrences reuse a durable receipt. A repeated delivery retains the original observation and timestamp. Conflicting read semantics under the same identity produce a capture failure.
For new Pi tool records, replay comparison ignores transient lifecycle, model, and process attribution. The first stored observation retains those fields.

Capture has a bounded process deadline and reports failures without blocking the agent. An unavailable database or killed process can lose an uncommitted observation. No successful installation or missing gap count proves complete coverage.

## Upgrade and verification

Upgrade the aggregate before enabling updated producers.
New tool-read metadata, inferred reads, and tool coverage use protocol version 4.
Existing version-1, version-2, and version-3 payloads, receipts, and canonical digests retain their interpretation.
Schema version 7 adds storage for tool coverage.
An incompatible receiver leaves new evidence in the delivery backlog until the receiver is upgraded.

Writer opens migrate existing databases. Back up databases before upgrading. The current read-only dashboard requires a writer migration before it can read an older database.

Run the repository checks and deterministic host smoke tests:

```sh
npm run check
npm run pack:dry
node scripts/native-host-smoke.mjs codex
node scripts/native-host-smoke.mjs claude-code
node scripts/capture-smoke.mjs
node scripts/tool-capture-smoke.mjs
node scripts/probe-opencode.mjs 1 /absolute/path/to/opencode-v1
node scripts/probe-opencode.mjs 2 /absolute/path/to/opencode-v2
```

The smoke tests use temporary projects and a local deterministic provider. They execute real host tools and production capture without account credentials. They do not test authenticated provider behavior.

OpenCode adapter tests verify each major separately. Live runtime evidence and remaining limitations are recorded in the [verification report](integration-verification.md).
