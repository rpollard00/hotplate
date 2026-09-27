# Hotplate

Hotplate records metadata about skill use in live Pi sessions.
By default, each OS account writes SQLite locally and serves a read-only dashboard on loopback.
Managed Pi connections automatically relay newly captured observations to an authenticated Docker aggregate server while Pi sessions run. Explicit manual capture and relay configuration remains available.
There is no transcript import or automatic discovery.

Node.js 24.19.0 or later is required.
See [LAN aggregation](#lan-aggregation) for explicit network enrollment.

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

Set `HOTPLATE_DB` to override the local-only database path (managed connections always use separate per-origin databases):

```bash
HOTPLATE_DB=/absolute/path/to/analytics.sqlite pi
```

Hotplate creates new directories with restricted permissions.
It does not change the permissions of existing parent directories.
SQLite uses WAL mode for the writer connection.

## Start the dashboard

For a disposable local preview with realistic synthetic sessions, run `npm run dashboard:preview`.
It uses port 7346 and a temporary database, without a production deployment.
See [the dashboard guide](docs/dashboard.md) for preview options and evidence definitions.

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

Chains split by machine, account source, session, segment, and run.
Reads from one model turn appear in one group, regardless of completion order.
Filtered-out intermediate observations create gap markers instead of invented adjacency.
Chain order does not prove dependency or causation.
Content versions remain unknown in this release. Hotplate does not reopen skill files to hash them.

Capture queues are bounded. Prolonged database errors or overflow can lose observations.
A status message and a metadata-only stderr diagnostic report capture failures.
Gap counts are best effort, not proof of complete coverage.
SQLite waits at most 25 ms per attempt, with three retries and asynchronous delays between write attempts.
Shutdown cancels retries after a 500 ms drain budget. A synchronous SQLite call can finish after that deadline.

## LAN aggregation

### Connect from Pi

Ask the collector operator to explicitly enable `"openEnrollment": true` (the default is false). Then run:

```text
/hotplate connect 192.168.88.12
/hotplate status
/hotplate disconnect
```

Bare IPv4/DNS names and optional ports default to HTTP; explicit HTTP/HTTPS origins work. Do not include paths, credentials, queries or fragments.
HTTP exposes credentials and metadata on the network: use a trusted LAN. Open enrollment permits **any reachable client** to register metadata; it is not trusted membership. Prefer TLS across untrusted networks.

Connect privately persists a stable per-origin identity, registers it, and waits for this session's live capture cutover. Failed registration keeps the previous selection and reusable pending identity. Future Pi sessions reuse the account-wide selection automatically. No old observations or session histories are imported; old databases are never retargeted.

Each Pi session owns an automatic relay; there is no daemon, process-manager installation or leader election. Delivery pauses after the last session exits. Parallel senders are permitted and ingestion deduplicates them. Permanent authorization failures pause delivery until reconnect; outages use bounded exponential backoff. Backlogs have no automatic eviction or size limit.

Disconnect persists local-only selection and waits for this session's cutover. Runnable peers reconcile approximately every second and check selection before HTTP sends. Already-started requests can commit, and suspended peers can retain old-origin local capture until reconciliation. Disconnect deletes neither history, credentials nor backlog; reconnect resumes that origin's backlog. Independent manual relays are not stopped.

Status is secret-free. `mode`, `origin`, and backlog counts describe this session's applied destination. `desiredMode` and `desiredOrigin` describe the requested destination. Desired/applied revisions and transition state show pending changes. It does not promise that all peers have switched. An unavailable private control store is reported as unavailable, never as a successful local fallback.

Private account state is under `$XDG_DATA_HOME/hotplate` (default `~/.local/share/hotplate`): `control.sqlite` and `connections/<origin hash>/` containing configuration, token and capture SQLite. Keep directories 0700, files 0600, and consistent backups including SQLite sidecars. Do not edit or delete these bindings to switch servers.

`HOTPLATE_DISABLED=1` starts no resources. `HOTPLATE_CONFIG` remains an authoritative manual override: managed connect/disconnect refuse to mutate selection, and invalid explicit configuration fails closed. Unset the override and reload Pi to use managed selection. `HOTPLATE_DB` controls only local-only capture. No global Pi settings are edited by these commands.

See [connection policy and bounds](docs/connection.md). Enrollment requests/replies are limited to 4 KiB and ten seconds. The collector permits at most 10,000 dynamic registrations and 30 new registrations per rolling minute per server process; exact retries do not consume these limits. Dynamic SHA-256 token digests persist in the existing aggregate SQLite `/data` volume, not mounted secrets. Closing enrollment refuses new registrations but accepts authenticated exact retries and existing ingest after restart. Managed machine IDs are `managed-<source UUID>`, not hardware attestations.

### Prepare the server

The container runs only the aggregate server. It cannot discover Pi processes or read remote session files.
All ingest routes require bearer credentials. By default, the credentials file must supply a separate read-only Basic dashboard credential.
For a trusted LAN, explicitly set `"dashboard": {"kind":"public"}` to allow anonymous dashboard pages, assets, queries, and health.
Omitted or invalid dashboard policies fail closed. Both policies retain exact Host/Origin checks and read-only dashboard methods.
Dashboard access exposes all aggregate metadata. Machine filters are not access controls.
The [Unraid deployment](docs/unraid.md) uses public access at `http://192.168.88.12` on port 80.

1. Copy `examples/aggregate.json` and `examples/credentials.json` into a private directory outside this checkout.
2. Set the directory mode to `0700`.
3. Replace every placeholder in the credentials file.
4. Generate a persistent source UUID for each participating OS account:

   ```bash
   node -e 'process.stdout.write(require("node:crypto").randomUUID()+"\n")'
   ```

5. Generate a random ingest token directly into a new private file, without printing it:

   ```bash
   umask 077
   node -e 'require("node:fs").writeFileSync("/private/hotplate/source.token", require("node:crypto").randomBytes(32).toString("hex"), {mode:0o600,flag:"wx"})'
   ```

6. Generate a separate dashboard password into a different private file, or explicitly choose the public dashboard policy above. Populate the credentials file privately; never paste secrets into command arguments, logs or model conversations.
7. Register each source UUID and token against a server-assigned `machineId` in the credentials file.
8. Set `publicOrigin` to the exact browser and relay origin, such as `https://hotplate.lan`.

Several account sources can share one machine identity. Senders cannot select their machine identity.
Source UUIDs must remain stable. Machine IDs use letters, digits, periods, underscores, or hyphens. `local` is reserved.

The Docker image pins Node 24.19.0 and installs build dependencies from `package-lock.json`.
The runtime uses UID 1000, a read-only filesystem, and a persistent named volume at `/data`.
Compose publishes only `127.0.0.1:7345` by default. It refuses startup without explicit secret-file paths.

Mount secret files read-only. The container's UID 1000 must be able to read them.
For rootless Docker, file modes `0444` inside a host directory with mode `0700` permit individual secret mounts without exposing host paths.
Do not make the enclosing directory public. Local Compose file secrets retain host file permissions, rather than enforcing a requested secret `uid`.
Keep account token files private with mode `0600`. Never commit credentials or put them in command arguments, URLs, or browser storage.

Set the two host paths, then start Compose:

```bash
export HOTPLATE_AGGREGATE_CONFIG=/private/hotplate/aggregate.json
export HOTPLATE_CREDENTIALS_FILE=/private/hotplate/credentials.json
docker compose up --build -d
```

The aggregate configuration must use `/run/secrets/hotplate-credentials.json` for `credentialsFile`.
The image healthcheck reads the mounted dashboard policy. It sends Basic credentials only for the Basic policy and no Authorization for public access. It never prints credentials.

### Protect the network

The aggregate listener speaks HTTP behind an operator-controlled TLS reverse proxy. It does not terminate TLS itself.
Keep the backend private. Configure the proxy to preserve the exact public `Host` header, including a nondefault port.
The configured public origin, not proxy headers, controls Host and Origin checks. The server enables no CORS access.
Use a certificate that the relay and browser trust. The relay has no insecure certificate override.

For an isolated trusted HTTP network, set `"trustedHttp": true` in both server and account configurations.
Also set matching `http://host:port` origins and explicitly change the Compose published address to the chosen LAN interface.
Plain HTTP exposes tokens, dashboard passwords, and metadata to network observers. Authentication does not provide confidentiality.
Do not publish the listener on an untrusted interface without TLS.

### Manual enrollment override

1. Install and build Hotplate on every participating machine, as described in the local installation instructions.
2. Install the Pi package in every participating account, including accounts that run child sessions.
3. Copy `examples/account.json` to a private account directory.
4. Set its persistent `sourceId` to the UUID registered by the server operator.
5. Set `endpoint` to the exact canonical server origin. Do not include a path, query, fragment, or credentials.
6. Write the registered ingest token to `tokenFile`.
7. Set an explicit `databasePath`, or retain the local `HOTPLATE_DB` and XDG defaults.
8. Start Pi with explicit enrollment:

   ```bash
   HOTPLATE_CONFIG=/private/account/hotplate.json pi
   ```

Relative file paths resolve against the configuration directory. An explicit `databasePath` takes precedence over `HOTPLATE_DB`.
The first enrolled capture open binds the account database to one source UUID and collector origin.
A different source or origin requires a separate database. Token rotation does not change this binding.
Invalid explicit configuration disables capture for that open, reports a redacted diagnostic, and never falls back to another destination.

Under `HOTPLATE_CONFIG`, Pi performs no HTTP delivery and does not read the ingest token. It writes local observations and immutable delivery entries in one transaction.
Existing observations never enter the delivery backlog. Migration and relay startup do not enroll capture or import historical rows.
Replay after an outage delivers only live observations captured after enrollment.

Child processes require the extension, `HOTPLATE_CONFIG`, and access to the same account database and configuration.
An isolated child environment does not automatically inherit capture. Install and configure those accounts explicitly.
To keep a managed account local-only, unset `HOTPLATE_CONFIG` and use `/hotplate disconnect`. An account without a managed selection or manual configuration is local-only. `HOTPLATE_DISABLED=1` still disables capture entirely.

### Run and monitor a manual account relay

Run one relay under the account that owns the capture database:

```bash
node /path/to/hotplate/dist/src/cli.js relay --config /private/account/hotplate.json
```

This explicit CLI is independent of managed session relays and is not installed or supervised by the extension. Start it after the first manually enrolled Pi capture creates the database.
The relay does not create a missing capture database. It exits on missing enrollment or permanent configuration/authentication errors.
SIGINT and SIGTERM cancel delivery safely. Committed capture remains available after Pi exits.

Inspect status without delivery or an available server:

```bash
node /path/to/hotplate/dist/src/cli.js relay --config /private/account/hotplate.json --status
```

Status is JSON on stdout. The `kind` is `missing`, `not-enrolled`, or `ready`.
A ready status includes `delivery.pendingCount`, `pendingBytes`, `oldestPendingAt`, and `blockedCount`.
Pending totals include blocked entries. Bytes measure retained serialized payloads, not database size or SQLite overhead.
The oldest time is the local outbox capture time. Status does not read the token file or send requests.

**Disk-growth warning:** The backlog has no size limit or automatic eviction. Monitor status and disk space.
Timeouts, outages, throttling, and lost acknowledgments retain pending observations. Identical replay does not duplicate aggregate analytics.
Requests use a 10-second deadline and jittered retries capped at 60 seconds. Redirects are forbidden.

Invalid, conflicting, or oversized observations remain blocked locally. Valid observations in the same batch can still arrive.
There is no automatic unblock command or retention policy in this version. Keep the database for investigation instead of deleting blocked entries silently.
Ingestion limits include 100 observations and 1 MiB per request, 8,192 bytes per string, and 2,000 catalog members.
An oversized catalog snapshot remains intact locally. The relay does not split it into synthetic observations.
These network limits do not restrict local capture acceptance.

### Deploy to Unraid over SSH

Use the [Unraid deployment guide](docs/unraid.md) for a dedicated `br0` address without published host ports.
After the one-time private configuration, run `npm run deploy:unraid` to build, plan, apply, and check status automatically.
The command defaults to `~/.config/hotplate-unraid/deploy.json`. Set `HOTPLATE_PRIVATE` to override the directory, or use `-- --config /absolute/path/deploy.json` for the highest-priority override.
It applies without a confirmation prompt.
The guide also documents separate `scripts/deploy-unraid build`, `plan`, `apply`, and `status` commands for manual plan review.
Updates retain cold backups and previous release evidence. Interrupted deployments fail closed without automatic database restoration.
The Unraid pipeline keeps static ingest credentials fixed across updates; only the requested open-enrollment policy can change alongside the existing dashboard/port policy changes. Credential rotation requires separate reviewed maintenance.

### Rotate static/manual credentials

1. Add a new random token for the same source UUID and machine identity to the server credentials.
2. Restart the aggregate server to load the credentials.
3. Replace the account token file atomically.
4. Restart that account's relay.
5. Remove the old server token after the new relay succeeds.
6. Restart the aggregate server again.

Static credentials can accept overlapping tokens for one source during rotation. Managed source/token registrations are immutable; do not attempt this procedure on managed bundles.
The relay reads its token once per run. Rotation preserves the pending backlog and source/origin binding.
The read credential is separate. Changing it also requires a server restart and a new browser login.

### Backup and upgrade

Use a SQLite-consistent backup, such as the SQLite backup command, or stop all writers before copying database files.
Copying only a live database's main file is not a valid backup. WAL sidecars can contain committed data.
For a stopped backup, retain the main file and any remaining `-wal` and `-shm` files together.
Back up the capture database, including enrollment and backlog, separately from the aggregate volume and secret files. For managed accounts, also preserve the private control database and every complete per-origin bundle, including its token and configuration. Never regenerate a corrupt or incomplete published identity as a recovery shortcut.
Protect backups as sensitive metadata. Restore file ownership for the writer account or container UID 1000.
Do not use `docker compose down -v` unless you intend to delete the aggregate database.

Writer opens migrate version 1/2 databases transactionally to version 3. The version-2 migration creates an empty backlog; version 3 adds the dynamic registry without replacing observations or existing bindings.
A read-only version 1 dashboard reports an upgrade error without changing the file.
Back up first, then open the database with the current local Pi collector or `openHotplateStore` to migrate it.
Aggregate databases start empty or reopen existing aggregate databases. A populated local database cannot become an aggregate.

### Delivery and scale limits

Capture can lose observations before the SQLite transaction commits. Local WAL NORMAL also permits loss after power failure.
The aggregate uses WAL FULL before acknowledgment. Storage hardware must honor synchronization for that durability guarantee.
Gap reporting remains best effort. Hotplate does not promise complete coverage or compliance proof.

Dashboard queries currently materialize unbounded results. Browser pagination does not limit server-side query size.
Request bounds do not establish a production throughput or query-scale limit. Measure contention, backlog growth, and dashboard latency for your workload.
Skill names, project paths, and session paths remain sensitive even without prompt or tool-output storage.

### Reproduce integration checks

```bash
npm run check
npm run pack:dry
node scripts/container-smoke.mjs --browser
```

The smoke script requires Docker and Node 24.19.0 or later. `--browser` also requires Chromium, or a `CHROMIUM` executable path.
It generates synthetic credentials and observations, builds an isolated image, and creates a temporary container and volume.
It checks authorization, two machines, duplicates, rendered machine filters, graceful shutdown, and restart persistence.
It removes only its own container, volume, image tag, and temporary files. It does not start a lasting service.
Set `HOTPLATE_SMOKE_REPORT` to save a secret-free JSON evidence report.
