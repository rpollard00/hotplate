# Managed Pi connections

On a collector, set `openEnrollment: true` in the aggregate configuration to allow new registrations. It defaults to false. Existing static credential files are not changed. Closing enrollment preserves ingest authorization and authenticated exact registration retries.

In Pi:

```
/hotplate connect 192.168.88.12
/hotplate status
/hotplate disconnect
```

DNS names and optional ports work; explicit HTTP/HTTPS origins work. Bare authorities use HTTP. Paths, credentials, queries and fragments are not accepted. HTTP exposes the credential and captured metadata to the network: use only a trusted LAN. Open enrollment is not trusted membership.

The account selection and private per-origin identities live under `$XDG_DATA_HOME/hotplate` (default `~/.local/share/hotplate`). Each origin has its own capture database. Connecting does not import historical observations or retarget an old database. Disconnect keeps credentials and backlog; reconnect resumes that origin's backlog.

Each running Pi session owns its capture writer and relay. Other runnable sessions reconcile approximately every second and check selection before sending. An already-started request can commit after disconnect. Suspended sessions can retain their old capture destination until reconciliation. Delivery pauses when the last session exits. Status describes this session's applied revision, not completion across every peer. Delivery state distinguishes idle, sending, backoff, paused and stopped; counts describe retained observations, not delivery promises.

`HOTPLATE_DISABLED=1` starts no resources. `HOTPLATE_CONFIG` retains manual capture semantics and refuses managed mutations; invalid explicit configuration never falls back. `HOTPLATE_DB` selects only local-only capture storage. No global Pi settings or detached services are installed.

## Enrollment bounds

Enrollment requests and responses are limited to 4 KiB and ten seconds, without redirects or compression. The aggregate retains at most 10,000 dynamic registrations and admits at most 30 new registrations per rolling minute per server process. Restart resets this rate window, not capacity or identities. Exact authenticated retries do not consume these limits. Existing active-request, connection, Host/Origin and JSON-content restrictions also apply.

Registration digests are stored in the owned aggregate SQLite database, requiring no extra container mount. Machine identity is `managed-<source UUID>`, scoped to this enrollment rather than hardware attestation.

## Private publication boundary

Complete, fsynced, nonempty bundles are atomically published for cooperating sessions; concurrent losers validate and reuse the winner. Observed symlinks, foreign ownership, unsafe modes and incomplete/corrupt published bundles fail closed. The account parent is canonical and private. A malicious same-UID actor racing an empty destination directory is outside this guarantee: it already controls the account's private files. No native rename-noreplace dependency is installed.

Control SQLite is initialized completely in a private staging directory and published with an exclusive hard link, then the staging link is removed. Existing invalid control schema or a missing singleton is refused without reinitialization. An open session fences sends when the published control inode is replaced or becomes inaccessible. A crash between control hard-link publication and staging-link removal leaves a multiply-linked file that fails closed; preserve the private state for reviewed recovery rather than deleting or regenerating it.

Shutdown aborts enrollment and owned HTTP requests, cancels polling, and drains the bounded local writer. SQLite busy waits/retries and transport deadlines are finite. Loss under a writer drain deadline is reported as capture-incomplete rather than transferred to another origin. These bounds cannot force progress while the JavaScript event loop or storage system itself is stalled.
