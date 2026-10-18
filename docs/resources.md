# Resource capture and inventory

Hotplate can inventory and observe files in skill directories without Skills Explorer, Git, or an index. References, principles, scripts, hidden files, and files without a `SKILL.md` owner are eligible. Labels come from paths and nearby skill markers. Hotplate does not read document bodies to classify or inventory them.

## Configure roots

Hotplate discovers conventional account and project skill directories, including hidden directories in project ancestors. Host-advertised skill directories add session scope when an integration supplies them. Conventional directory discovery is an inference about availability, not proof that a harness advertised every file.

Integrations publish their project and advertised roots to a private account registry. The watcher discovers these roots even when it starts in another project. Registrations include the filesystem namespace and harness process identity, expire, and reject stale processes. Pi and OpenCode v2 supply advertised roots. Native hooks and OpenCode v2 also publish locally discovered conventional account and project roots, including OpenCode skill directories under a harness-specific configuration directory. They do not republish roots learned only from another session. OpenCode v1 relies on conventional and configured roots.

Roots learned from another session remain unassigned in inventory. They can establish global file presence and qualify actual reads, but do not establish availability or zero access for a different project or session. Each harness's own inventory supplies its scoped availability.

Register other content directories once:

```sh
hotplate resources add-root /absolute/path/to/skills
hotplate resources scan
hotplate resources list
hotplate resources status
```

Saved roots live in `~/.config/hotplate/resources.json`. Like native account selection, this path stays shared when a harness changes `XDG_CONFIG_HOME`. `HOTPLATE_RESOURCES_CONFIG` selects another configuration file. `HOTPLATE_RESOURCE_ROOTS` adds paths separated by the platform path delimiter. `resources remove-root <directory>` removes a saved root without deleting historical evidence.

Root advertisements live in `~/.local/state/hotplate/advertised-roots`; process registrations live in `~/.local/state/hotplate/processes`. These account paths do not follow harness-specific `XDG_STATE_HOME` values. `HOTPLATE_RESOURCE_REGISTRY` and `HOTPLATE_PROCESS_REGISTRY` select separate registry directories when isolation is needed. Use the same overrides for the integrations and watcher that should share evidence.

Use `--root <directory>` for a command-specific root, `--project <directory>` for project discovery, and `--db <path>` for an explicit local database. Without `--db`, capture uses the account configuration selected by setup, including its existing relay. Explicit `HOTPLATE_CONFIG` takes precedence.

Scans record filenames and metadata, including incomplete scans. They do not count as reads. Periodic scans detect additions and deletions; incomplete scans do not assert that missing files were deleted. Symlink aliases retain the physical location identity. Copies at different locations remain separate resources.

## Observe filesystem access on Linux

From this checkout, activate a watcher for your account:

```sh
scripts/activate-watcher /absolute/path/to/skills
```

The script requires Node 24.19 or newer, installed project dependencies, a C compiler, `sudo`, `setcap`, and a systemd user session. Run it as your normal user. Optional root arguments are relative to your current directory and are saved in your resource configuration.

The script builds Hotplate and the helper. Only helper installation and capability assignment use `sudo`. The installed helper is root-owned at `/usr/local/libexec/hotplate/<uid>/hotplate-fanotify`. Node, the database, and `hotplate-resources.service` run under your account. Each activation restarts the service to load the updated helper.

The service retains the current account selection and resource overrides, including `HOTPLATE_CONFIG`, `HOTPLATE_DB`, and `HOTPLATE_INTEGRATION_SETTINGS`. Path overrides must be absolute. The script refuses disabled capture or an unrelated service with the same name. Its final output includes service and coverage state. Active fanotify coverage confirms observation. A running service alone does not.

For service errors, use `journalctl --user -u hotplate-resources.service`. Rerun `hotplate resources status` after the initial inventory finishes. To stop collection, use `systemctl --user disable --now hotplate-resources.service`.

For a foreground watcher, build the optional native helper with a C compiler:

```sh
npm run build
npm run build:observer
hotplate resources watch --project /absolute/path/to/project
```

The watcher starts with an inventory and reconciles it every 30 seconds. It persists changed snapshots and scan-failure transitions, so unchanged directories do not add another full file list each time. `--interval-ms` changes that interval. It rediscovers configured, conventional, and registered roots on each reconciliation. `--helper <absolute-path>` or `HOTPLATE_FANOTIFY_HELPER` selects another helper executable.

Linux fanotify needs `CAP_SYS_ADMIN` for the process-attributed notification mode used here. An administrator must provision that capability for an administrator-managed helper or service. The Node process and SQLite database should stay under the capturing account. Building the helper does not grant capabilities or install a privileged service. Without the capability, inventory continues and coverage reports `permission-denied`.

The helper uses notifications only. It does not intercept permission decisions or read file contents. Its output is restricted to the configured roots and account. Hotplate records filesystem `open` and `access` evidence separately from successful host-tool reads. Filesystem notifications can coalesce, and memory-mapped or cached content may produce no access event.

Run the watcher under a process supervisor for continuous collection. It retries a failed helper on the next reconciliation. Stopping it with SIGINT or SIGTERM drains received notifications and records a graceful stop. Confirmed coverage ends at the last active heartbeat, not the later stop record. Abrupt termination becomes stale after the heartbeat window; Hotplate cannot count every event lost during a crash.

## Attribution through T3 and wrappers

Process identity includes the boot ID, PID, and process start time. The observer follows the reader's ancestor chain to a registered harness. Intermediate shells and wrappers do not need to be the harness's direct child. T3 itself is not registered as one conversation, so sibling harnesses do not inherit each other's session.

In-process integrations register their own process. Native hooks locate the nearest matching harness ancestor. Recognized harness executables can provide host attribution before registration. If ancestry disappears after account verification, an access can remain unattributed. If the helper cannot verify a short-lived reader's account and identity, it discards the file event and reports a coverage loss. This can affect short-lived commands such as `cat`.

Codex and OpenCode can share a runtime across conversations. Their filesystem observations therefore retain harness attribution with an unknown session. Host-tool events can still carry an exact session. Dedicated Pi and Claude registrations may identify a session; conflicting registrations remain ambiguous. None of these events proves that a model used the content in its answer.

## Read the results

The Resources dashboard and `resources list` separate attempts, successful or failed tool reads, filesystem opens and accesses, and attribution. Resource identity includes the account source and filesystem namespace. Names, content hashes, and Explorer metadata do not merge locations.

“No observed access” requires an inventoried file and a confirmed filesystem observation interval. The result includes that interval. Missing, stale, failed, or ambiguous coverage remains unknown. A file with zero recorded reads is not automatically unused.

Resource events, inventory, and coverage use protocol version 3. Upgrade the aggregate before enabling new producers. Existing version-1 and version-2 payloads remain unchanged. An older receiver cannot accept the new evidence; pending deliveries remain in the existing backlog until a compatible receiver is available.

Skills Explorer is not required for any of these operations. A future annotation importer can add its relationships without changing the capture or inventory contract.
