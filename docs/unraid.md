# Unraid deployment

This pipeline builds on the workstation and controls Docker through one SSH session. It does not require a registry or Compose.

The target is `root@media.media`, network `br0`, address `192.168.88.12`, and origin `http://192.168.88.12:7345`.
HTTP is explicitly trusted on this LAN. It sends credentials and metadata without TLS. Do not expose this address to an untrusted network.

Only the operator creates real credentials, accepts host keys, and runs remote commands. Deployment does not enroll Pi capture or start account relays.

## Prerequisites

- Workstation: Node 24.19.0 or later, installed checkout dependencies, `jj`, Docker, and OpenSSH.
- Server: Root SSH, Bash, Docker, `jq`, GNU `tar`, `sha256sum`, `flock`, `realpath`, `stat`, `df`, `du`, `head`, `base64`, and `timeout`.
- Server: Linux x86_64, an existing macvlan `br0`, and a reserved, unused `192.168.88.12` address.
- Storage: Space for each image archive, a cold backup, and loaded image layers. Old releases remain until manual cleanup.

Verify the server host key through a trusted channel before deployment. The script uses `StrictHostKeyChecking=yes` and `BatchMode=yes`.
It does not modify SSH configuration, accept new keys, or request a password. The `hostName` value must equal the server's `hostname` output.

The appdata parent must exist. The appdata path itself must be absent for bootstrap.
Existing unmarked directories are refused, even when empty. Canonical paths must not contain symlinks.
Do not pre-create `/mnt/user/appdata/hotplate` or change ownership recursively.

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
  dashboard: { username: "hotplate-reader", password: randomBytes(32).toString("hex") },
};
const aggregate = {
  databasePath: "/data/aggregate.sqlite", host: "0.0.0.0", port: 7345,
  publicOrigin: deploy.origin, credentialsFile: "/run/secrets/hotplate-credentials.json", trustedHttp: true,
};
for (const [name, value] of [["deploy.json", deploy], ["aggregate.json", aggregate], ["credentials.json", credentials]]) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
NODE
```

The command prints no credentials and refuses to overwrite files. Keep the directory outside the checkout.
The controller requires mode `0600` or stricter and current-user ownership for local private files. Symlinked private files are refused.
Use a password manager to retain the dashboard credential. Do not put credentials in command arguments or logs.

The installation UUID, canonical path, host, network identity, address, and origin become fixed at bootstrap.
Updates reuse the same aggregate configuration and credentials. This deployment interface refuses credential rotation and target changes.
Those changes require a separate, reviewed maintenance operation.

## Build, plan, apply, status

```sh
scripts/deploy-unraid build --config "$HOTPLATE_PRIVATE/deploy.json"
```

Expected output ends with `Built /absolute/path/releases/<UUID>/release.json`.
`build` first runs `npm run check`. Then Docker builds `linux/amd64` with the existing Dockerfile and its locked `npm ci`.
It does not reinstall dependencies in the checkout.

Set `RELEASE` to that exact path. Do not select a mutable tag or copy a manifest without its sibling `image.tar`.

```sh
export RELEASE=/absolute/path/releases/UUID/release.json
scripts/deploy-unraid plan --config "$HOTPLATE_PRIVATE/deploy.json" --release "$RELEASE"
scripts/deploy-unraid apply --config "$HOTPLATE_PRIVATE/deploy.json" --release "$RELEASE"
scripts/deploy-unraid status --config "$HOTPLATE_PRIVATE/deploy.json"
```

`plan` and `status` are read-only. First preflight returns `{"kind":"Result","state":"Ready",...}`.
Successful apply returns `{"kind":"Result","state":"Healthy",...}` with an operation UUID.
Status includes the journal state and observed container IDs, running state, health, and restart policy. It never prints credentials.
Status is a snapshot, not a lock or authorization to recover.

Apply validates again under a host-local exclusive lock. It streams the archive into a private operation directory and verifies its size and checksum.
It validates the archive's single release tag before load. It verifies the loaded image ID and platform before replacement.
The release manifest also records the source revision and controller checksum. Changing the controller requires a new build.
Containers run by image ID, not tag.

Apply disables the old restart policy, stops the old container, and refuses other writers.
It archives the entire cold data directory, including SQLite sidecars, before disconnecting the old network attachment.
The candidate starts with `restart=no`. Docker health and authenticated workstation requests to `/health` and `/api/dashboard` must both succeed.
Only an acknowledgment with the exact operation UUID and candidate ID enables `unless-stopped`.
The controller holds the lock during this exchange. A missing acknowledgment times out after 30 seconds.

The container has no published host ports, Docker socket, or writable root filesystem.
It mounts the UID1000-owned data directory at `/data` and mounts two individual read-only secret files.
Unraid itself need not reach its macvlan peer. The workstation must reach the dedicated address.

For updates, run the same build, plan, and apply commands with the unchanged private configuration.
Even reapplying the same image creates a new operation, cold backup, and container. There is no implicit no-op shortcut.
Capture enrollment remains explicit. Follow the README account-enrollment procedure with the existing source UUID and token.
Do not generate a second source identity merely to verify delivery.

## Retained evidence

The root-owned `installation.json` binds the installation to its canonical path and network ID.
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
    failure.json              # Caught failures only
```

The journal uses `Ready`, `Prepared`, `StopIntent`, `BackupReady`, `StartIntent`, `Healthy`, or `RecoveryRequired`.
Each state requires evidence for its stage. Intent records precede consequential operations.
Incomplete journals block apply after the lock disappears. Malformed journals, changed ownership, missing evidence, and checksum mismatches also block apply.
A partial upload remains private and cannot load.

Successful updates retain the previous container, image, private configuration, and cold backup.
Old containers remain stopped, disconnected, and set to `restart=no`. The pipeline never prunes Docker or deletes a release.
Monitor appdata and Docker storage. Review exact ownership before manual retention cleanup.

## Failure and manual recovery

CAUTION: Do not delete the journal to bypass a refusal. A candidate can already have written new observations.
CAUTION: Restoring a backup loses all post-backup observations. Preserve current data before an approved restore.

A caught failure before `StartIntent` can restart the unchanged old container only after exact specification and ownership checks.
The controller restores its dedicated network address and restart policy, then waits for Docker health.
The command still exits nonzero. Its result can report `Healthy` when the old release recovered.

At or after `StartIntent`, a caught failure attempts to stop the independently verified candidate, even if evidence writes fail.
If ownership cannot be verified or Docker operations fail, the candidate can remain running and requires manual inspection.
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
12. Repeat Docker health and the authenticated workstation probes before enabling `unless-stopped`.
13. Reconcile the journal only after independent review of the restored container and all required evidence.

Journal reconciliation is a manual engineering task in this version. Do not invent a `Healthy` record or reuse evidence from a different operation.
Bootstrap failures without a previous container also require this review. The pipeline will not delete or adopt the partial installation.

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

The smoke covers bootstrap, persistent updates, checked cold backups, ownership refusals, competing controllers, and corrupt uploads.
It covers backup/disconnect failures, exact restart-policy restoration, actual unhealthy Docker health, failed acknowledgments, and acknowledgment timeout.
It kills the controller at stop/start intent and verifies that later apply is refused.
Regression checks cover ownership rejection, failed writer enumeration, and candidate shutdown when evidence writes fail.
Fault wrappers inject backup/disconnect errors. The successful lifecycle and unhealthy-image checks use real Docker operations.
Cleanup selects only the run's exact installation labels, helper label, network, image tags, and temporary directory. Build cache can remain.

Rootless bridge probes do not prove workstation access to Unraid macvlan.
Parent-owned verification must still prove remote preflight, HTTP authentication, persistent mounts, restart policy, and live enrolled-account relay delivery.
An empty authenticated dashboard proves server availability, not live account capture.
