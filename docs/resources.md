# Resource capture and inventory

Hotplate inventories and observes selected installed or project skill content without Skills Explorer or an index. References, principles, scripts, hidden artifacts, and files without a `SKILL.md` owner are eligible. Labels come from paths and nearby skill markers. Inventory reads filenames and metadata, without document bodies.

Agent tool capture is the primary source for skill and reference activity. It operates without a filesystem watcher.
Structured reads and recognized literal commands can identify supporting files even when the agent does not read their `SKILL.md`.
The [integration guide](integrations.md#supported-tool-reads) lists the supported syntax and host limits.

Filesystem observation remains a separate diagnostic source. Catalog polling and background loaders can open files without an agent tool read.
Neither a filesystem event nor frontmatter in context establishes that the agent used the instructions.

## Configure roots

Hotplate discovers installed account collections, exact host advertisements, and explicitly configured content roots. The watcher does not infer project scope from its working directory or home directory. A session supplies its host and project boundary for project discovery.

Project conventions depend on the host:

| Host | Project directories |
| --- | --- |
| Codex | `.agents/skills` |
| Claude Code | `.claude/skills` |
| OpenCode v1 | `.opencode/skills` |
| OpenCode v2 | `.opencode/skills`, `.claude/skills`, `.agents/skills` |
| Pi | `.pi/skills` in the current directory, plus `.agents/skills` in bounded ancestors |

Ancestor discovery stops at the reported project boundary or the nearest repository or worktree marker. Without a marker, discovery checks only the current directory and reports the uncertain boundary. Generic `.skills` directories require explicit configuration or a host advertisement.

An installation alias grants access to its exact physical target subtree. For example, `~/.agents/skills/reese -> checkout/skills` selects `checkout/skills`, without selecting the rest of the checkout. Multiple aliases retain their logical paths but share physical file identity. A nested symlink cannot expand the installation boundary. An explicitly installed npm package can have `node_modules` ancestors.

Exclusions apply within each selected root. Hotplate prunes `.git`, `.jj`, and `node_modules` components, plus Claude retirement `.trash` subtrees. It preserves `.artifacts` and other legitimate hidden content. These rules apply to inventory and file-backed read evidence, including legacy `SKILL.md` reads.

A host can advertise a selected package or an exact collection. A catalog can also select one regular file without selecting its parent directory. Conventional discovery establishes inferred availability. It does not prove that a host advertised every file.

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

Use `--root <directory>` for an exact content declaration. Use `--project <directory> --host <host>` for manual project discovery. `--project` requires `--host`. Without these flags, commands select installed account roots and registered session roots.

`add-root` validates each declaration before saving it. Filesystem roots, home directories, broad plugin caches, and direct checkout roots are rejected. Direct skill packages and independently installed exact targets remain eligible. Other explicit content directories remain compatible with version-1 configuration, including temporarily missing roots. Preview labels these roots `legacy-declaration`. An unmarked source directory cannot be distinguished from a custom content declaration.

Plugin skills require an exact configured or host-advertised content directory, such as `cache/<publisher>/<package>/<version>/skills`. Hotplate does not scan a plugin cache or guess its selected version. Enabled-plugin configuration alone does not supply that mapping. Preview reports this discovery limitation.

Use `--db <path>` for an explicit local database. Without `--db`, capture uses the account configuration selected by setup, including its existing relay. Explicit `HOTPLATE_CONFIG` takes precedence.

## Preview selection without capture

```sh
hotplate resources preview
hotplate resources preview --project /absolute/path/to/project --host codex
hotplate resources preview --root /absolute/path/to/exact/content --max-entries 100000
```

Preview uses the ordinary discovery and inventory rules. Its JSON output includes logical and canonical roots, installation authority, exclusions, counts, rejected paths, and incomplete or truncated scans. Rejected checkout roots include known installed aliases. Counts describe inventory memberships, so distinct overlapping root snapshots can contain the same file.

Preview does not open a database, recorder, or lease. It does not start a service or helper, remove expired registrations, or write configuration. `--max-entries` bounds traversal. A limit produces an incomplete scan, never a claim that omitted files are absent.

Scans record filenames and metadata, including incomplete scans. They do not count as reads. Periodic scans detect additions and deletions; incomplete scans do not assert that missing files were deleted. Symlink aliases retain the physical location identity. Copies at different locations remain separate resources.

## Optional filesystem diagnostics on Linux

From this checkout, activate a watcher for your account:

```sh
scripts/activate-watcher
```

The script requires Node 24.19 or newer, installed project dependencies, a C compiler, `sudo`, `setcap`, and a systemd user session. Run it as your normal user. Conventional installed roots need no positional arguments. Optional exact custom roots are relative to your current directory. The script validates them before privileged commands or persistent writes, then saves them in your resource configuration.

The script builds Hotplate and the helper. Only helper installation and capability assignment use `sudo`. The installed helper is root-owned at `/usr/local/libexec/hotplate/<uid>/hotplate-fanotify`. Node, the database, and `hotplate-resources.service` run under your account. Each activation restarts the service to load the updated helper.

The service retains the current account selection and resource overrides, including `HOTPLATE_CONFIG`, `HOTPLATE_DB`, and `HOTPLATE_INTEGRATION_SETTINGS`. Path overrides must be absolute. The script refuses disabled capture or an unrelated service with the same name. Its final output includes service and coverage state. Active fanotify coverage confirms observation. A running service alone does not.

For service errors, use `journalctl --user -u hotplate-resources.service`. Rerun `hotplate resources status` after the initial inventory finishes.
To stop this service, use the [deactivation script](#deactivate-the-filesystem-watcher).

For a foreground watcher, build the optional native helper with a C compiler:

```sh
npm run build
npm run build:observer
hotplate resources watch
```

The watcher starts with an inventory and reconciles it every 30 seconds. It persists changed snapshots and scan-failure transitions. Unchanged scans publish no additional snapshot at every supported size, including inventories above 8 MiB. Temporary SQLite staging bounds memory while retaining complete snapshots for publication. A failed publication requires a complete retry.

`--interval-ms` changes the reconciliation interval. It rediscovers configured, conventional, and registered roots on each reconciliation. `--helper <absolute-path>` or `HOTPLATE_FANOTIFY_HELPER` selects another helper executable.

Linux fanotify needs `CAP_SYS_ADMIN` for the process-attributed notification mode used here. An administrator must provision that capability for an administrator-managed helper or service. The Node process and SQLite database stay under the capturing account. Building the helper does not grant capabilities or install a privileged service. Without the capability, inventory continues and coverage reports `permission-denied`.

The helper uses filesystem-wide `FAN_MARK_FILESYSTEM` subscriptions. Inventory detects nested filesystems within admitted content and supplies their paths for additional marks. These paths retain the original content boundary and inventory membership. The helper filters selected roots and exclusions before process attribution and IPC. TypeScript checks each received path against the same admission policy. The helper does not intercept permission decisions or read file contents.

The private helper protocol requires a complete version-1 scope policy on stdin and a `scopeVersion: 1` readiness acknowledgement. Invalid, oversized, or incomplete policies fail before subscriptions start. Older helpers cannot establish active coverage.
To retain filesystem diagnostics with an older helper, reinstall it with `scripts/activate-watcher`.

Hotplate records filesystem `open` and `access` evidence separately from successful host-tool reads. Filesystem notifications can coalesce, and memory-mapped or cached content can produce no access event. Hotplate does not claim to observe all model consumption.

Run the watcher under a process supervisor for continuous collection. It retries a failed helper on the next reconciliation. Stopping it with SIGINT or SIGTERM drains received notifications and records a graceful stop. Confirmed coverage ends at the last active heartbeat, not the later stop record. Abrupt termination becomes stale after the heartbeat window; Hotplate cannot count every event lost during a crash.

## Deactivate the filesystem watcher

Run the script from this checkout as the capturing Linux account, without `sudo`:

```sh
scripts/deactivate-watcher
```

The script requires a systemd user manager. It verifies the unit path and ownership marker installed by `scripts/activate-watcher`.
It stops and disables `hotplate-resources.service`, then verifies both states.
An already disabled managed service or an absent inactive service permits another run.
An unrelated or symlinked unit produces a refusal.

The script preserves the service unit, installed helper, resource configuration, saved roots, and captured history.
It leaves `hotplate-relay.service` and native agent integrations running.
Foreground watchers and custom services remain outside its scope.
Stopping this service also stops its periodic inventory scans. Manual `resources scan` remains available.

Historical filesystem events remain in the database. The default **Tool activity** measure excludes them.
After deactivation, filesystem coverage ends. Missing tool reads still do not establish that a file is unused.

## Attribution through T3 and wrappers

Process identity includes the boot ID, PID, and process start time. The observer follows the reader's ancestor chain to a registered harness. Intermediate shells and wrappers do not need to be the harness's direct child. T3 itself is not registered as one conversation, so sibling harnesses do not inherit each other's session.

In-process integrations register their own process. Native hooks locate the nearest matching harness ancestor. Recognized harness executables can provide host attribution before registration. If ancestry disappears after account verification, an access can remain unattributed. If the helper cannot verify a short-lived reader's account and identity, it discards the file event and reports a coverage loss. This can affect short-lived commands such as `cat`.

Codex and OpenCode can share a runtime across conversations. Their filesystem observations therefore retain harness attribution with an unknown session. Host-tool events can still carry an exact session. Dedicated Pi and Claude registrations may identify a session; conflicting registrations remain ambiguous. None of these events proves that a model used the content in its answer.

## Read the results

The default Metrics view shows **Both** skills and resources with **Tool activity**.
It includes confirmed reads, inferred command reads, attempts, read failures, and native invocations.
The Resources workspace and `resources list` also retain filesystem diagnostics and inventory.
Resource identity includes the account source and filesystem namespace. Names, content hashes, and Explorer metadata do not merge locations.

File details separate requested portions from reported returned portions and truncation.
Unreported delivery and content revision remain unknown. Hotplate does not reopen a file to infer either value.
**Tool coverage** reports recognized and opaque operations separately from file counts.
An opaque operation has unresolved file access and creates no invented resource row.
Coverage counts describe observed operations. They do not establish that every agent read was captured.

"No observed access" requires an inventoried file and a confirmed filesystem observation interval. The result includes that interval. Missing, stale, failed, or ambiguous coverage remains unknown. A file with zero recorded reads is not automatically unused.

Upgrade the aggregate before enabling updated producers.
New tool-read metadata, inferred reads, and tool coverage use protocol version 4.
Schema version 7 adds storage for tool coverage.
Existing version-1, version-2, and version-3 payloads and their canonical digests remain unchanged.
An older receiver cannot accept the new evidence. Pending deliveries remain in the backlog until a compatible receiver is available.

Skills Explorer is not required for any of these operations. A future annotation importer can add its relationships without changing the capture or inventory contract.
