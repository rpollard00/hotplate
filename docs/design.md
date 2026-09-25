# Hotplate design

Hotplate uses direct SQLite writes from each pi process.
This keeps version 1 small and avoids a foreground collector that users must remember to start.

## Components

Hotplate has three components:

- Core storage and queries in `src/domain.ts` and `src/store.ts`.
- The pi event collector in `src/extension.ts` and `src/collector/`.
- The read-only dashboard in `src/server.ts`, `src/cli.ts`, and `src/dashboard/`.

The collector converts pi events to typed observations.
The core store receives only observations.
The dashboard reads query views from the database.

## Observation contract

The store boundary accepts metadata only.
Raw prompts, complete tool outputs, credentials, and error bodies must not cross this boundary.

The observation evidence types are:

- `command-intent`
- `wrapper-observed`
- `read-result`
- `catalog-snapshot`
- `capture-gap`

These evidence types stay separate.
A command intent is not a successful load.
A wrapper is not proof of a user command.
A failed read is not a successful model load.

## Identity and lifecycle

Each producer has a UUID and a monotonic sequence.
Each observation also stores project, session, segment, run, turn, and leaf identity when pi exposes it.

Segments split on startup, reload, new session, resume, fork, branch, or an unknown boundary.
Chains group observations by project, session, segment, and run.
Filtered observations create explicit chain gaps.

Model attribution comes from the assistant message that created a tool call.
Hotplate does not use the model value at tool-result time for attribution.

## SQLite behavior

The default database path is:

```text
~/.local/share/hotplate/analytics.sqlite
```

`XDG_DATA_HOME` changes the base directory.
`HOTPLATE_DB` overrides the full path.

Writer connections use WAL and schema version 1.
Queries use parameterized SQL.
Observation IDs are unique, so retries do not duplicate rows.
Busy handling uses short bounded waits.
Persistent lock contention drops observations and reports capture gaps when possible.

A read-only dashboard open does not migrate or create a missing database.
The missing database state is separate from a database with zero observations.

## Dashboard behavior

The dashboard is read-only HTTP on loopback.
It rejects unsafe `Host` and `Origin` values.
It sends no CORS headers.
It sends a restrictive content security policy.
The browser code writes text with DOM text nodes, not HTML injection.

The dashboard shows:

- Overview counts.
- Skill rows, including cataloged skills with zero observed loads.
- Source and evidence splits.
- Provider and model read counts.
- Capture health.
- Skill chains with gap markers.

## Security and privacy boundary

Hotplate protects data for one OS account.
It is not a privileged system-wide collector.
Other processes in the same OS account can access files that the account can read.
Use a separate OS account when this boundary is not sufficient.

Hotplate makes a best effort to restrict database and directory permissions.
The OS and filesystem decide the final permission behavior.

## Known limits

Hotplate is live-capture only.
It does not scan historical transcripts.
It cannot prove model compliance.
It cannot observe bash reads, custom tool reads, external agents, or pi sessions without the extension.
A crash can lose observations that remain in memory.
