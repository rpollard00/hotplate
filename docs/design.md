# Hotplate design

Hotplate captures live coding-agent events into account-local SQLite. An optional account relay delivers new observations to an authenticated aggregate server.
Local-only capture and loopback dashboard operation remain the default. No module scans historical transcripts.

Native integrations use a bounded Node capture command. `setup` stores an explicit account-wide relay selection and starts the existing relay under a systemd user service. Capture workers read that selection without changing host-wide environment variables. Explicit account configuration takes precedence, and an explicit local database bypasses the saved selection. Codex and Claude Code supply command hooks; OpenCode v1 and v2 use separate plugin adapters. See [integration operation and coverage](integrations.md).

Schema version 4 adds host identity, native occurrence receipts, read attempts, and native skill invocations. New host evidence uses protocol version 2. The receiver still accepts version 1 without changing its canonical payload or acknowledgment format. Retained version-1 outbox entries remain byte-for-byte unchanged.

Native receipt checks and observation/outbox writes share one transaction. A retry retains the original timestamp. A changed fact under an existing receipt identity fails capture. Capture does not infer successful reads from unstructured shell output, and unknown native runs do not contribute to run-based metrics.

## Modules and interfaces

- `src/domain.ts` defines observations, evidence, identities, and dashboard views.
- `src/observation.ts` validates domain values and constructs allowlisted metadata payloads.
- `src/store.ts` owns SQLite writes, migrations, delivery state, aggregate ingestion, and scoped queries.
- `src/extension.ts` and `src/collector/` convert live Pi events to observations.
- `src/network-config.ts` validates explicit account and aggregate configuration.
- `src/relay.ts` owns delivery, retry, cancellation, rejection isolation, and status.
- `src/network-protocol.ts` owns the private versioned envelope and wire limits.
- `src/aggregation.ts` authenticates network requests and binds credentials to identities.
- `src/server.ts` shares one dashboard responder behind listener-specific authorization.
- `src/cli.ts` owns command parsing and process signals.
- `src/dashboard/assets.ts` renders dashboard views through safe DOM text insertion.

`openHotplateStore` remains local-only. `openCaptureStore` adds explicit enrollment and atomic outbox writes.
Neither demo writes nor ordinary library writes create deliveries. Transport operations are internal module exports, not methods of `HotplateStore`.

`openRelayStore` returns `missing`, `not-enrolled`, or a bound store with selection, exact-ID settlement, and status operations.
`openAggregateStore` commits a whole ingestion batch or none of it. It returns committed counts, conflicts, or storage unavailability.
`queryFilterOptions` reads the same snapshot as the dashboard queries. Network modules contain no query SQL.

## Observation contract

Observations contain metadata only. Raw prompts, complete tool outputs, credentials, and error bodies must not enter storage or transport payloads.
The serializer constructs allowed fields instead of copying arbitrary object properties.

Evidence kinds remain distinct:

- `command-intent`
- `wrapper-observed`
- `read-result`
- `catalog-snapshot`
- `capture-gap`

A command intent is not a successful load. An observed wrapper is not proof of a user command or slash expansion.
The collector finds wrappers in delivered user messages, including queued messages. A failed read is not a successful model load.
Model attribution comes from the assistant message that created the tool call, not the model at tool-result time.
Content versions remain unknown when Pi supplies no version. Hotplate does not reopen skill files to compute hashes.

## Identity and enrollment

Each producer has a UUID and a monotonic sequence. Observations also contain project, session, segment, run, turn, and leaf identity when available.
Segments split on startup, reload, new session, resume, fork, branch, or an unknown transition.

A machine identifies one operator-registered host. A source identifies one participating account installation.
Several sources can belong to a machine. Ingest credentials bind each source to its server-assigned machine. The sender cannot select its machine.
Reserved local identities preserve existing local rows. Network enrollment cannot use those identities.

`HOTPLATE_CONFIG` opts Pi capture into delivery. Without it, the extension uses the existing local store.
The first enrolled capture open persists the source UUID and collector origin in the account database.
Subsequent opens must match. A different source or origin requires another database. Token rotation does not change the binding.

Capture commits the local observation, catalog effects, and complete immutable delivery payload in one transaction.
An existing local observation cannot create a delivery on a later retry. Migration and relay startup never enroll existing rows.
The relay does not create a missing capture database. Pi does not send HTTP requests or read ingest token contents.

## SQLite and delivery

Schema version 2 scopes aggregate observation uniqueness by machine, source, and observation ID.
Aggregate producer/sequence reuse with changed identity is also a conflict. Legacy local callers can retain arbitrary IDs and reused sequences.
Canonical digests cover complete allowlisted content, including catalog members. Identical retries are duplicates. Changed content is a conflict.
Legacy catalog observations do not acquire invented snapshot digests during migration.

Local writers use WAL NORMAL. Aggregate writers use WAL FULL before acknowledgment.
A transaction migrates version 1 observations and catalog rows under reserved local identities, adds empty delivery state, and advances the schema version.
Only writer opens migrate. Read-only version 1 opens return an actionable upgrade error without mutation.
An aggregate open cannot silently adopt a populated local database.

Busy handling uses a 25 ms timeout and bounded retries with asynchronous delays. Cancellation stops retries.
The collector retains its 1,000-entry queue and 500 ms shutdown drain budget. A synchronous SQLite call can exceed that budget.
The existing local dropped-position assumption is not used for network settlement.

The relay selects bounded payloads without a transaction across HTTP. Oversized entries return their identity and size without loading their payload.
Only a validated acknowledgment for the complete submitted batch permits exact-ID deletion.
Lost acknowledgments, concurrent relays, and failed settlement cause safe replay. They do not duplicate aggregate analytics.

Timeouts, disconnects, 429, and 5xx retain pending deliveries. Retries use jittered exponential backoff capped at 60 seconds.
Requests have a 10-second deadline. Cancellation interrupts HTTP and backoff. Redirects are forbidden.
Authentication failures stop delivery with a redacted diagnostic. Configuration correction and process restart resume pending delivery.

Permanent rejections trigger bounded binary subdivision. Successful siblings settle independently.
Invalid, conflicting, and oversized singletons remain blocked in the account database. Catalog snapshots are never fragmented.
The backlog has no eviction or capacity limit. Status reports pending count, payload bytes, oldest capture time, and blocked count.

## Catalog and query scope

Observation filters, activation identities, chains, and catalog keys include machine/source scope.
Structured tuple keys prevent delimiter collisions. Skill and model rows remain distinct across machines.
Chains also expose their account source. Filtered intermediate observations produce gaps instead of invented adjacency.

Catalog storage remains project-scoped. Machine-level catalog counts consolidate duplicate account entries by machine, project, skill name, and path.
This preserves separate catalog entries across projects. Catalog times update monotonically.
Older delivery cannot replace a newer catalog version. Equal timestamps use a deterministic binary ordering of the version tuple.

The dashboard has machine, project, source-of-command, model, and time filters.
Project and model choices respect machine scope. Machine choices remain unfiltered so the browser can switch machines.
Changing machines clears project and model selections before fetching new data.

Activity bins derive evidence counts and distinct read-bearing run sets from exact observation timestamps. Windows up to seven elapsed days use UTC hours. Resolution is chosen before boundary alignment, so a rolling week can span 169 bins. Longer windows retain bounded daily or adaptive bins. Report filters include their end timestamp; chart and exploration intervals have exclusive ends. Per-skill bins retain distinct read-bearing run counts and additive successful-read counts. Repeated reads and exact-name variants add to the successful-read count. The browser plots selected skills as stacked step areas across actual UTC bin edges, including shorter final bins. A bin without successful reads has zero area.

The chart brush owns an in-progress create, move, or resize gesture. Its band follows pointer coordinates continuously. Release commits UTC hour boundaries in hourly views and UTC day boundaries in longer views. Cancellation restores the previous selection. Keyboard and table controls use the same selection state.

Displayed trends use a separate top-count or ordered, unique custom-name selection. One searchable checkbox list adds and removes displayed skills without changing the exploration cohort or interval. Skill colors remain stable for the page session. Custom names survive report reloads without substitution. Reset restores the top five trends, Content Both, Tool activity, and Last 4 hours. The activity table is lazy and paginates intervals.

Overview exploration derives read-bearing path selections and comparisons from the current filtered report in browser memory. It does not persist the selection or request new data. A chosen skill and UTC interval select complete run paths; linked model counts include only matching successful reads, and model path navigation requires a matching read by that model. Comparison shares count each read-bearing path once per skill. A prior interval outside the loaded scope is unavailable, not a recorded zero.

## Indexed analytics

Schema version 8 adds an analytics read model without changing the observation protocol or deleting raw evidence.
`src/analytics-read-model.ts` owns indexed access facts, filesystem activity buckets, and observer coverage identities.
`src/inventory-read-model.ts` owns compact inventory scans and location history.
Migration backfills these projections once. New observations update them in the same capture or aggregate transaction.
Duplicate delivery changes no projection. A conflict rolls back observations, projections, receipts, and outbox changes together.
HTTP readers do not migrate or backfill the database.

Content queries reuse one materialized input across their ownership, facet, and count passes.
Repeated filesystem events contribute weighted counts instead of repeated JSON decoding.
Partial UTC hours use raw facts to preserve exact date boundaries and ambiguous resource scope.
Each affected hour expands once, so overlapping scope groups cannot count a raw event twice.
Inventory selectors retain first and last evidence, completed membership, member order, and incomplete-scan uncertainty.
Historical coverage can still use a later heartbeat to confirm an earlier interval.

Skills projects visible mini timelines from its existing report. Resources and Both request visible row and cohort projections from `/api/content-timelines`.
The endpoint accepts at most 24 row keys and six cohort keys. Timelines use at most 256 UTC bins. A rolling week can contain 169 hourly bins.
The displayed axis stays fixed during local selection. Undated evidence contributes to counts without a bar.
JSON responses negotiate gzip and preserve identity and HEAD behavior.
`/api/readiness` checks database queryability and schema compatibility without building an analytics report.

After building, run `node scripts/analytics-benchmark.mjs --db /path/to/snapshot.sqlite --output /tmp/analytics-benchmark.json` against a consistent snapshot with the current schema.
The read-only runner records endpoint latency, response sizes, query plans, hydrated row counts, and compiled source hashes across agent, model, project, and time filters.
Its samples use first connections and a warmed operating-system cache; they do not measure cold-disk latency.

## Authorization and deployment

The local listener remains loopback-only with Host/Origin checks and no network credentials.
The aggregate listener requires bearer authorization for ingestion and separate read-only Basic authorization for every dashboard route.
Tokens cannot read analytics. Read credentials cannot ingest. The read credential grants access to all machines, not a machine-specific subset.

Authentication precedes body parsing. The wire parser rejects unknown fields, invalid timestamps, unsafe counters, and compressed bodies.
Initial limits are 100 observations, 1 MiB per envelope, 8,192 bytes per string, and 2,000 catalog members.
The listener bounds headers, body duration, active requests, and connections. Local capture acceptance does not inherit network size limits.

The listener requires an exact configured authority and canonical same-origin checks. Proxy headers cannot change the origin.
It enables no CORS and sends a restrictive content security policy. Credentials never enter URLs or browser storage.
HTTPS terminates at an operator-controlled proxy. Plain HTTP requires explicit trusted-network consent in both configurations and provides no confidentiality.

Docker runs as UID 1000 with a named database volume and read-only secret mounts.
Compose defaults to a loopback-published backend. The image healthcheck authenticates with the mounted read credential.
SIGTERM closes active work and database handles. The operator must install and configure each Pi account, including isolated child-session accounts.

## Limits and verification

Capture can lose observations before commit. Local WAL NORMAL does not promise zero loss after power failure.
Aggregate FULL durability depends on the filesystem and hardware honoring synchronization. Gap reporting is best effort.
Metadata names and paths remain sensitive. Same-account processes can access files available to that account.

The compatible count and session-path responses still contain their complete matching rows. Visible timeline projections are bounded separately.
Indexed projections reduce query work. They do not add a data-retention policy.
Production contention and backlog growth still require workload measurements.
A backup requires a SQLite-consistent snapshot or stopped writers. Copying only a live main database file is insufficient.

Tests cover local SDK behavior, migration, source isolation, HTTP replay, authorization, bounded requests, and CLI lifecycle.
`scripts/container-smoke.mjs --browser` checks a disposable synthetic deployment and the rendered dashboard in Chromium.
It includes two identities, duplicate delivery, container replacement on the same volume, and authenticated health.
The smoke test does not certify an external TLS proxy or remote LAN routing.
