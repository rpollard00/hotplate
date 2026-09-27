# Configuration examples

`aggregate.json` is closed to new managed registrations by default (`openEnrollment: false`). An operator may explicitly set it to true on a trusted network. Any reachable client can then register metadata; this is not trusted membership. HTTP reveals tokens and metadata to network observers. Never use the placeholder credentials in production or commit real credentials.

Once enabled, users run `/hotplate connect 192.0.2.12` (or a DNS/HTTP/HTTPS origin), `/hotplate status`, and `/hotplate disconnect` in Pi. Each account privately retains a stable identity and capture database per origin. Running Pi sessions own their automatic relays; the last session's exit pauses delivery. Disconnect retains backlog and does not kill independent manual relays. Peer reconciliation is eventual and already-started sends can commit. No history is imported.

`account.json` is for the existing explicit/manual workflow: `HOTPLATE_CONFIG` disables managed mutations and never falls back on invalid configuration. Manual capture needs a separately launched relay CLI. `HOTPLATE_DISABLED=1` starts no resources; `HOTPLATE_DB` changes only local-only storage. Managed commands do not install a process manager or edit global Pi settings.

`credentials.json` contains static source bindings and a separate dashboard policy. Managed registration never overwrites it; dynamic token digests live in the aggregate's existing `/data` SQLite database. Closing enrollment preserves existing ingest and authenticated exact retries after restart.

Follow [the README](../README.md#lan-aggregation) and [the Unraid guide](../docs/unraid.md) for file permissions, immutable deployment identities and safe replacement. Changing open-enrollment policy does not authorize changes to existing static ingest credentials.
