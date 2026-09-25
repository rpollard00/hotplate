# Hotplate

Hotplate is a local pi extension that records metadata about skill use.
It writes observations to a shared SQLite database and serves a read-only dashboard on loopback.

Hotplate is for one OS account.
It does not collect data across user accounts or machines.
It does not send telemetry to a remote service.

## Install for local pi use

Build the package first:

```bash
npm install
npm run build
```

Install this checkout with an absolute path:

```bash
pi install /home/reese/projects/hotplate
```

Then reload pi:

```text
/reload
```

Do not use a global npm install for this version.
A local path install lets pi load the package manifest from this checkout.

## Database path

Hotplate writes to this path by default:

```text
~/.local/share/hotplate/analytics.sqlite
```

If `XDG_DATA_HOME` is set, Hotplate uses this path instead:

```text
$XDG_DATA_HOME/hotplate/analytics.sqlite
```

Set `HOTPLATE_DB` to override the database path:

```bash
HOTPLATE_DB=/absolute/path/to/analytics.sqlite pi
```

Hotplate creates new directories with restricted permissions.
It does not change the permissions of existing parent directories.
SQLite uses WAL mode for the writer connection.

## Start the dashboard

Start the read-only dashboard:

```bash
npm run build
node dist/src/cli.js serve
```

Use a specific database path when needed:

```bash
node dist/src/cli.js serve --db /absolute/path/to/analytics.sqlite
```

The server binds to `127.0.0.1:7345` by default.
It rejects non-loopback hosts and unexpected origins.
It does not enable CORS.

Create a demo database at a new, explicit path:

```bash
node dist/src/cli.js demo --db /tmp/hotplate-demo.sqlite
node dist/src/cli.js serve --db /tmp/hotplate-demo.sqlite
```

The demo command refuses to overwrite an existing file.
`--force` deletes the selected database and its SQLite sidecars.

## Disable Hotplate

Use pi package configuration to disable or remove the package.
You can also start pi without this package installed.

Pause capture for one process, including an installed package:

```bash
HOTPLATE_DISABLED=1 pi
```

To remove the local path package:

```bash
pi remove /home/reese/projects/hotplate
```

Run `/reload` after a package change.

## What Hotplate records

Hotplate records observations.
An observation is a metadata-only fact from a live pi session.

Hotplate records these facts:

- A `/skill:name` command intent and its pi input source.
- A skill wrapper in a delivered user message, including queued input.
- A `SKILL.md` read result from the model tool call.
- A catalog snapshot from pi skill commands.
- A capture gap when Hotplate knows that it dropped observations.

Hotplate does not persist raw prompts, full tool outputs, credentials, or error bodies.

## Observations are not compliance proof

A command intent is not proof that pi loaded a skill.
An observed wrapper is not proof that a human requested it.
A successful `SKILL.md` read is an observed successful tool result.
The result can contain only part of the file, and another extension can change it.
It is not proof that the model obeyed the skill.

RPC source is not human proof.
Queued wrappers and matched command plus wrapper pairs are not upgraded to proven user loads.
Repeated reads and unique activations have separate counts.

## Limitations

Hotplate captures live pi sessions only.
It does not import old transcripts.
It does not observe bash reads, custom tool reads, unloaded external agents, or child processes without the extension.
A process crash can lose queued observations.

Chains split by session, segment, and run.
Reads from one model turn appear in one group, regardless of completion order.
Filtered-out intermediate observations create gap markers instead of invented adjacency.
Chain order does not prove dependency or causation.
Content versions remain unknown in this release. Hotplate does not reopen skill files to hash them.

Capture queues are bounded. Prolonged database errors or overflow can lose observations.
A status message and a metadata-only stderr diagnostic report capture failures.
Gap counts are best effort, not proof of complete coverage.
SQLite waits at most 25 ms per attempt, with three retries and asynchronous delays between write attempts.
Shutdown cancels retries after a 500 ms drain budget. A synchronous SQLite call can finish after that deadline.
