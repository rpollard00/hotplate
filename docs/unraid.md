# Unraid deployment

This pipeline builds on the workstation and controls Docker through one SSH session. It does not require a registry or Compose.

The sample target is `root@unraid.example.invalid`, network `br0`, address `192.0.2.12`, and origin `http://192.0.2.12` (port 80). These are documentation placeholders. Replace the SSH target, `hostName`, address, and origin with your own values in your private `deploy.json` before deployment.
The dashboard is public to devices that can reach this LAN address. It requires no dashboard username or password.
Ingestion still requires account-specific bearer tokens. HTTP sends tokens and metadata without TLS. Do not expose this address to an untrusted network.

Only the operator creates static credentials, accepts host keys, and runs remote commands. Deployment does not enroll a user account or start account relays. With explicitly enabled open enrollment, each account can use `/hotplate connect 192.0.2.12` from Pi.

## Prerequisites

- Workstation: Node 24.19.0 or later, installed checkout dependencies, `jj`, Docker, and OpenSSH.
- Server: Root SSH, Bash, Docker, `jq`, GNU `tar`, `sha256sum`, `flock`, `realpath`, `stat`, `df`, `du`, `head`, `base64`, and `timeout`.
- Server: Linux x86_64, an existing macvlan `br0`, and a reserved, unused LAN address. The sample `192.0.2.12` is not a usable LAN address.
- Storage: Space for each image archive, a cold backup, and loaded image layers. Old releases remain until manual cleanup.

Verify the server host key through a trusted channel before deployment. The script uses `StrictHostKeyChecking=yes` and `BatchMode=yes`.
It does not modify SSH configuration, accept new keys, or request a password. The `hostName` value must equal the server's `hostname` output.

The appdata parent must exist. The appdata path itself must be absent for bootstrap.
Existing unmarked directories are refused, even when empty. Canonical paths must not contain symlinks.
Do not pre-create `/mnt/user/appdata/hotplate` or change ownership recursively.
The appdata basename is the stable Docker container name (`hotplate` for this target).
It must start with a letter or digit and contain only letters, digits, underscores, periods, or hyphens.
A name occupied by anything except the exact journal-bound current container blocks deployment before mutation.

## Create private configuration once

Run this on the workstation from the checkout. Choose a stable machine identity before enrolling an account.
This example uses `workstation` and creates one source UUID. Keep that identity for later enrollment.

```sh
umask 077
export HOTPLATE_PRIVATE="$HOME/.config/hotplate-unraid"
mkdir -m 700 "$HOTPLATE_PRIVATE"
node --input-type=module <<'NODE'
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.HOTPLATE_PRIVATE;
const deploy = JSON.parse(readFileSync("examples/unraid-deploy.json", "utf8"));
deploy.installation = randomUUID();
deploy.aggregateFile = join(directory, "aggregate.json");
deploy.credentialsFile = join(directory, "credentials.json");
deploy.releaseDirectory = join(directory, "releases");
const credentials = {
  ingest: [{ sourceId: randomUUID(), machineId: "workstation", token: randomBytes(32).toString("hex") }],
  dashboard: { kind: "public" },
};
const aggregate = {
  databasePath: "/data/aggregate.sqlite", host: "0.0.0.0", port: Number(new URL(deploy.origin).port || 80),
  publicOrigin: deploy.origin, credentialsFile: "/run/secrets/hotplate-credentials.json", trustedHttp: true, openEnrollment: false,
};
for (const [name, value] of [["deploy.json", deploy], ["aggregate.json", aggregate], ["credentials.json", credentials]]) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
NODE
```

The command prints no credentials and refuses to overwrite files. Keep the directory outside the checkout. Edit the generated private `deploy.json` to set your real SSH target, host name, LAN address, and matching HTTP origin before running a deployment.
The controller requires mode `0600` or stricter and current-user ownership for local private files. Symlinked private files are refused.
Retain ingest tokens privately. Do not put credentials in command arguments or logs.
Other deployments can retain the legacy `dashboard: {username, password}` policy. Omitted or invalid dashboard policies refuse startup.

The installation UUID, canonical path, host, network identity, and address become fixed at bootstrap.
Ordinary updates can change the dashboard policy and switch between canonical `http://ADDRESS` (80) and `http://ADDRESS:7345`.
The aggregate `port` must match the origin. The optional boolean `openEnrollment` can also change during a reviewed replacement; omission means false. All other aggregate configuration and the entire static ingest credential list must remain unchanged.
Ingest token rotation and immutable target changes require a separate, reviewed maintenance operation.

For an existing Basic/7345 installation, preserve private copies of the old configuration, then change only:
- Deployment `origin` to `http://YOUR_LAN_ADDRESS` (replace `YOUR_LAN_ADDRESS` with the deployed address).
- Aggregate `publicOrigin` to the same origin and `port` to `80`.
- Credentials `dashboard` to `{"kind":"public"}`.

Keep the installation UUID, every ingest token/source/machine identity, and remaining configuration intact. Do not rerun bootstrap credential generation.
Build, plan, and apply normally. Do not edit the server marker or old operation files. Existing account enrollment is not changed by deployment.

## Deploy with one command

After the one-time setup, run this command from the checkout:

```sh
npm run deploy:unraid
```

The command reads `~/.config/hotplate-unraid/deploy.json` by default. No environment variable is required.
A nonempty `HOTPLATE_PRIVATE` overrides the private directory. An explicit `--config` path takes precedence over both:

```sh
npm run deploy:unraid -- --config /absolute/path/deploy.json
```

An invalid override stops deployment. The command does not fall back to the default configuration.

This command runs `build`, `plan`, `apply`, and `status` in order. It passes the exact new release path between steps automatically.
Run `npm run check` before deployment. The release build compiles TypeScript; deployment checks, backups, and application probes remain in effect.
The command stops at the first failure and exits nonzero. It does not retry, restore the database, or remove retained releases.
If deployment fails, run the separate `status` command and review the recovery instructions.

CAUTION: This command applies the release without a confirmation prompt. It can stop and replace the running container.
For a separate plan review before apply, use the manual commands in the next section.

## Manual build, plan, apply, status

```sh
npm run check
scripts/deploy-unraid build --config "$HOTPLATE_PRIVATE/deploy.json"
```

Expected output ends with `Built /absolute/path/releases/<UUID>/release.json`.
`build` first runs `npm run build`. Then Docker builds `linux/amd64` with the existing Dockerfile and its locked `npm ci`.
It does not reinstall dependencies in the checkout.

Set `RELEASE` to that exact path. Do not select a mutable tag or copy a manifest without its sibling `image.tar`.

```sh
export RELEASE=/absolute/path/releases/UUID/release.json
scripts/deploy-unraid plan --config "$HOTPLATE_PRIVATE/deploy.json" --release "$RELEASE"
```

Review the plan before running apply:

```sh
scripts/deploy-unraid apply --config "$HOTPLATE_PRIVATE/deploy.json" --release "$RELEASE"
scripts/deploy-unraid status --config "$HOTPLATE_PRIVATE/deploy.json"
```

`plan` and `status` are read-only. First preflight returns `{"kind":"Result","state":"Ready",...}`.
Successful apply returns `{"kind":"Result","state":"Healthy",...}` with an operation UUID.
Status includes the journal state and observed container IDs, running state, health, and restart policy. It never prints credentials.
Status is a snapshot, not a lock or authorization to recover.

Apply validates again under a host-local exclusive lock. It streams the archive into a private operation directory and verifies its size and checksum.
It validates the archive's single release tag and configuration digest before load. It verifies the loaded image identity and platform before replacement.
Docker image stores can report either a manifest ID or a configuration ID for the same transferred image.
The controller accepts only the release's source ID or the verified configuration digest from the checksum-verified archive.
It records the accepted runtime ID in the journal. Containers run by that immutable ID, not by tag.
The release manifest also records the source revision and controller checksum. Changing the controller requires a new build.

Apply disables the old restart policy, stops the old container, and refuses other writers.
It archives the entire cold data directory, including SQLite sidecars, before disconnecting the old network attachment.
After the durable `StartIntent` journal replacement, it removes the exact predecessor and verified stopped historical containers by immutable ID.
Each removal uses nonforced `docker rm`, without volume removal. The replacement uses the stable appdata basename.
The candidate starts with `restart=no`. Docker health checks `/api/readiness` with a three-second deadline.
The workstation checks `/health` and `/api/readiness` with a ten-second deadline per request, including the response body.
Both readiness checks require HTTP 200 and a JSON response with `ok: true`. Each response must be at most 4096 bytes.
`/api/readiness` checks database queryability and schema compatibility without dashboard analytics. Analytics size and query time do not control deployment readiness.
The requests use the configured dashboard policy. Public dashboards send no Authorization header. Basic dashboards send their configured credentials.
Workstation probe errors report the endpoint and failure type without response bodies or credentials.
Only an acknowledgment with the exact operation UUID and candidate ID enables `unless-stopped`.
The controller holds the lock during this exchange. A missing acknowledgment times out after 30 seconds.

The container has no published host ports, Docker socket, or writable root filesystem.
It runs as UID1000 with all capabilities dropped and `no-new-privileges`. The namespaced sysctl
`net.ipv4.ip_unprivileged_port_start=0` permits port 80 without root or added capabilities.
It mounts the UID1000-owned data directory at `/data` and mounts two individual read-only secret files.
Unraid itself need not reach its macvlan peer. The workstation must reach the dedicated address.

For updates, run `npm run deploy:unraid` with the existing private configuration, or use the manual commands.
Even reapplying the same image creates a new operation, cold backup, and container. There is no implicit no-op shortcut.
Capture enrollment remains explicit. For managed use, enable `openEnrollment` as described below and let the user issue the Pi command; do not enroll the user's real account as a deployment test. Existing manual accounts keep their source UUID, token and immutable database binding. If the deployment origin changes, configure a separate capture database for the new origin; never retarget the old enrolled database or import its history.

## Open enrollment and Pi account connections

The default is closed. To enable the approved trusted-LAN workflow, preserve all existing private configuration and static credentials, change only aggregate `openEnrollment` to `true`, then build/plan/apply normally. Do not regenerate bootstrap secrets. This policy permits **any client that can reach the instance** to register metadata; it is not trusted membership. Plain HTTP exposes tokens and metadata on the network. Do not expose open enrollment to an untrusted network.

Users run `/hotplate connect 192.0.2.12`, `/hotplate status` and `/hotplate disconnect`. The client privately persists a stable per-origin identity and separate capture database. Automatic relay delivery exists only while Pi sessions operate; no daemon or OS process manager is installed. Last-session exit pauses delivery; reconnection resumes retained backlog. No historical observations are imported or old database bindings retargeted.

Each session owns its collector/relay. Disconnect changes account-wide selection immediately, waits for its own cutover and best-effort aborts owned sends. Other runnable sessions reconcile approximately every second; in-flight requests can commit and suspended peers can retain their former capture destination until reconciliation. Status reports desired and this session's applied revisions, not completion across all peers.

`HOTPLATE_CONFIG` keeps the previous explicit/manual behavior and refuses managed mutations. Invalid explicit configuration does not fall back. `HOTPLATE_DISABLED=1` starts no resources; `HOTPLATE_DB` controls local-only capture, not managed per-origin databases. The standalone relay CLI remains independent and is not stopped by managed disconnect.

Dynamic registrations store SHA-256 token digests and assigned `managed-<source UUID>` identities in the existing owned `/data/aggregate.sqlite`, with no extra writable mount or modification of mounted static credentials. They survive container restart/replacement and normal consistent backups. Closing enrollment refuses new registrations but preserves authenticated exact retries and ingest for existing registrations. Requests/replies are at most 4 KiB with ten-second deadlines; capacity is 10,000 dynamic registrations and rate admission is 30 new registrations per rolling minute per server process. Exact retries do not consume either bound. See [connection details](connection.md).

## Retained evidence

The root-owned `installation.json` binds the installation to its canonical path and network ID.
New version-2 markers hash the immutable target without the origin.
The controller accepts existing version-1 markers only when all fields match.
Their hash must match the full legacy target reconstructed with `http://ADDRESS:7345`. The controller does not rewrite existing markers.
The appdata layout is:

```text
/mnt/user/appdata/hotplate/
  installation.json
  journal.json
  data/
  operations/<operation UUID>/
    before.json
    release.json
    aggregate.json
    credentials.json
    previous.json             # Updates only: complete old Docker specification
    image.tar
    data.tar
    data.tar.sha256
    retirement.json           # Full stopped specifications and ownership evidence, hashed in the journal
    failure.json              # Caught failures only
```

The journal uses `Ready`, `Prepared`, `StopIntent`, `BackupReady`, `StartIntent`, `Healthy`, or `RecoveryRequired`.
Each state requires evidence for its stage. Intent records precede consequential operations.
Incomplete journals block apply after the lock disappears. Malformed journals, changed ownership, missing evidence, and checksum mismatches also block apply.
A partial upload remains private and cannot load.

Successful updates leave one running container with the stable name. They retain images, operation journals, specification snapshots, private configuration, and cold backups.
Existing UUID-named deployments and version-1 markers remain valid. Their next successful replacement removes verified stopped predecessors.

Historical removal requires a private prior `Healthy` record in a successor operation's `before.json` and a matching `previous.json` specification.
The controller verifies the installation, immutable ID, name, operation, runtime image, release, acknowledgment, secrets, and backup evidence.
It checks historical eligibility before stopping the current service. Missing evidence, changed specifications, running containers, or uncertain restart policies block deployment.
Labels or names alone never authorize removal.

The controller snapshots retirement evidence and rechecks the full specification immediately before each removal.
Retirement requires stopped, exited, disconnected containers with `restart=no`. Enumeration and removal failures stop deployment.
The pipeline never force-removes containers, removes volumes, prunes Docker, or deletes a release.
Monitor appdata and Docker storage. Review exact ownership before manual retention cleanup.

The image sets `SQLITE_TMPDIR=/data` so SQLite can create temporary files with a read-only container root. The data mount remains the writable location for migrations and large queries.

## Failure and manual recovery

CAUTION: Do not delete the journal to bypass a refusal. A candidate can already have written new observations.
CAUTION: Restoring a backup loses all post-backup observations. Preserve current data before an approved restore.

A caught failure before `StartIntent` can restart the unchanged old container only after exact specification and ownership checks.
The controller restores its dedicated network address and restart policy, then waits for Docker health.
The command still exits nonzero. Its result can report `Healthy` when the old release recovered.

At or after `StartIntent`, a caught failure attempts to stop the independently verified candidate, even if evidence writes fail.
If ownership cannot be verified or Docker operations fail, the candidate can remain running and requires manual inspection.
The predecessor can already be removed at this stage. A removal failure leaves `RecoveryRequired`, even when the predecessor still exists.
It never starts the old image or restores the database automatically.
SIGKILL, machine loss, or an interrupted Docker operation can leave a candidate running. A journal does not prove that it stopped.

There is deliberately no public recovery command. An operator must review the evidence and authorize a specific recovery:

1. Stop deployment automation and run `status`.
2. Obtain the same lock, `/run/hotplate-deploy/<SHA256 of the canonical appdata path>`, before maintenance.
3. Verify `installation.json`, the journal, operation files, container labels, exact mounts, image IDs, and network attachments.
4. Observe every container that can write the data path, including containers not listed in the journal.
5. Disable restart and stop each verified writer before copying data.
6. Archive the current entire data directory to a new private path and record its checksum.
7. Choose candidate repair or an explicitly approved restore. Record the decision and the observations that restoration loses.
8. For restoration, verify `data.tar.sha256` and inspect archive members before extraction into a new empty directory.
9. Preserve the old data directory. Restore UID1000 permissions only within the new, verified directory.
10. Use the retained `previous.json`, image ID, and private files to review the exact old container specification.
11. Restore the selected network attachment and start only the approved image with `restart=no`.
12. Repeat Docker health and the workstation probes for the configured dashboard policy before enabling `unless-stopped`.
13. Reconcile the journal only after independent review of the restored container and all required evidence.

Journal reconciliation is a manual engineering task in this version. Do not invent a `Healthy` record or reuse evidence from a different operation.
Bootstrap failures without a previous container also require this review. The pipeline will not delete or adopt the partial installation.
An existing `RecoveryRequired` journal still blocks `plan` and `apply` after this probe repair, even when an operator restarted a healthy candidate.
The probe repair does not reconcile that journal or authorize another deployment. Reconciliation requires the same evidence review and lock described here.

Atomic journal replacement and checksums do not establish power-loss durability. Filesystem, Docker, and storage synchronization remain operational limits.
A host administrator or process outside this controller can bypass its lock. Do not use the Unraid UI to modify these containers during deployment.

## Local verification

```sh
npm run check
npm run test:deploy
npm run smoke:unraid
```

The smoke requires a local Unix Docker socket and permission to build images. It does not use SSH or real credentials.
It builds a separate root controller fixture with Docker CLI, `jq`, and `flock`. Package downloads require network access.
The unchanged controller runs against real Docker images, private bind mounts, and a uniquely named bridge network.
The fixture hides only its own controller containers from writer enumeration because they represent the host-side controller.
The application container never receives the Docker socket.

The smoke covers bootstrap and a legacy version-1 marker with Basic/7345 and no explicit sysctl upgrading to public/80.
Run-namespaced appdata basenames prevent collisions with other installations.
Repeated updates must leave one stable-name container. Legacy stopped cleanup must retain snapshots, images, configuration, and backups.
Name collisions, label-only containers, unowned mounts, running historical containers, changed specifications, and refused removals must fail closed.
It verifies UID1000, Docker health, production probes without Authorization, anonymous dashboard reads, and denied anonymous ingestion.
It also verifies Host/Origin and read-only guards, retained SQLite observations, cold backups, and unchanged old configuration.
Open-enrollment coverage registers a temporary managed source, ingests metadata, restarts the UID1000/read-only container, verifies durable authorization/deduplication/data, then replaces it with closed enrollment and verifies exact retry while refusing new sources. Invalid enrollment policies cannot mutate a healthy service.
Other checks cover ownership refusals, competing controllers, and corrupt uploads.
It covers backup/disconnect failures, exact restart-policy restoration, actual unhealthy Docker health, failed acknowledgments, and acknowledgment timeout.
It kills the controller at stop/start intent and verifies that later apply is refused.
Regression checks cover ownership rejection, failed writer enumeration, and candidate shutdown when evidence writes fail.
Fault wrappers inject backup/disconnect errors. The successful lifecycle and unhealthy-image checks use real Docker operations.
Cleanup selects only the run's exact installation labels, helper label, network, image tags, and temporary directory. Build cache can remain.

Rootless bridge probes do not prove workstation access to Unraid macvlan.
Parent-owned verification must still prove remote preflight, public dashboard access and authenticated ingestion, persistent mounts, restart policy, and live enrolled-account relay delivery.
An empty dashboard proves server availability, not live account capture.
