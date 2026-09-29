# Agent integration plan

Planning status: proposed, 2026-09-28. No integration is implemented by this document.

Hotplate will capture live skill-use evidence from Codex, Claude Code, OpenCode v1, and OpenCode v2 through native adapters. The adapters will share durable capture and delivery code with Pi.

The initial design uses a Node capture command and the existing explicit relay. A resident account collector remains an alternative if measured latency or delivery requirements justify it.

1. Ground the existing capture flow: complete.
2. Compare two independent designs: complete.
3. Specify the proposed interface and verification gates: complete.
4. Implement: excluded from this planning request.
5. Revisit the design: required if capability probes invalidate its assumptions.

Current working-copy baseline: change `xszymokt`, commit `6cadbaa1`. Existing dashboard edits are outside this plan.

**Current flow**

`src/extension.ts` registers Pi events. `SessionConnection` owns selection changes, collector replacement, and session-owned delivery. `HotplateCollector` translates Pi events and maintains scope, model attribution, queues, and observation identities.

`src/store.ts` already commits enrolled observations and immutable delivery entries together. `src/relay.ts` handles retries and acknowledgments. These modules remain the storage and delivery foundation.

The current collector and skill catalog import Pi types. Native command hooks cannot reuse their process-local lifecycle state across separate invocations.

**Host integration choices**

| Host | Proposed adapter | Required capability probe |
| --- | --- | --- |
| Claude Code | Command hooks for lifecycle, tool success/failure, and direct skill commands | Compare `Skill` calls, direct `/skill` expansion, file reads, and child sessions |
| Codex | Command hooks for lifecycle and completed local tools | Verify shell completion, nested tool calls, native skill expansion, and child attribution |
| OpenCode v1 | `@opencode-ai/plugin` adapter returning named hooks, calling a Node bridge | Verify `tool.execute.after`, session events, failures, and Bun-to-Node execution |
| OpenCode v2 | `@opencode/plugin` adapter with `Plugin.define` and `setup(ctx)`, calling the shared Node bridge | Verify `ctx.tool.hook("execute.after", ...)`, event subscriptions, outcome status, and cleanup |

Claude documents separate tool-failure events. Direct slash expansion has its own event and bypasses the `Skill` tool prehook. Expansion is not sufficient proof of a completed load. [Claude hooks](https://code.claude.com/docs/en/hooks)

Codex documents tool hooks with call and turn IDs. Unified execution can complete through a later `write_stdin` poll. Some tool paths are excluded, and transcript format is unstable. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

OpenCode v1 exposes plugin tool and session events. Its plugin environment uses Bun facilities, so the plugin must not assume Hotplate's `node:sqlite` implementation runs there. [OpenCode v1 plugins](https://opencode.ai/docs/plugins/)

OpenCode v2 changes plugin and server contracts. Both versions use the `opencode` command, so executable name alone cannot select an adapter. [OpenCode migration](https://opencode.ai/v2/docs/migrate-v1)

V1 implementations do not run unchanged in v2. V2 uses `@opencode/plugin`, `setup(ctx)`, domain hooks, and event subscriptions. Configuration changes from `plugin` to `plugins`. [Plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)

V2 exposes completed and failed tool outcomes through `execute.after`. Its adapter must observe these events without changing their mutable result fields. [OpenCode v2 plugins](https://opencode.ai/v2/docs/build/plugins)

OpenCode v1 loads skills through its native `skill` tool. A completed native invocation needs distinct evidence rather than a fabricated file read. V2 skill evidence requires its own capability probe. [OpenCode v1 skills](https://opencode.ai/docs/skills/)

V1 remains an active release target: its changelog lists `1.18.33` on September 28, 2026. [OpenCode v1 changelog](https://opencode.ai/changelog)

Installed versions inspected: Codex `0.158.0`, Claude Code `2.1.283`, OpenCode v2 `2.0.15`. V1 was not inspected locally. These are probe targets, not verified minimum versions.

**OpenCode compatibility strategy**

`opencode-v1` and `opencode-v2` are separate installation targets, adapters, and test suites. They share normalized evidence, the Node bridge, and durable capture. Each reports its integration ID and detected host version.

The installer inspects the selected executable's version and verifies the requested major before editing configuration. Unknown majors produce an actionable error. It never upgrades OpenCode. An optional automatic `opencode` target can select a verified adapter later.

The initial package design uses separate adapter entrypoints. Upstream also supports one package exporting v1 `server()` and v2 `setup()`. That option requires v1 `1.18.29` or newer and still contains two implementations. Packaging can converge after both adapters pass independently. [Dual-version packaging](https://opencode.ai/v2/docs/build/plugins/migrate-v1)

V2 extraction uses the session or event location for project attribution. The plugin instance location does not necessarily identify the observed session's project. Subscriptions must stop on unload. The v1 Bun helper is not part of the v2 context. [Context migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)

The first plan incorrectly paired v1 plugin documentation with the installed v2 binary. The separate rows and compatibility gates replace that assumption.

**Proposed usage**

These commands are design sketches and do not exist yet:

```sh
hotplate integration install claude-code
hotplate integration install codex
hotplate integration install opencode-v1
hotplate integration install opencode-v2
hotplate integration status
hotplate integration remove claude-code
```

Installation manages only Hotplate-owned configuration entries. Repeated installation does not add duplicate hooks. Removal preserves other entries and retained observations. Status reports adapter version, runtime availability, evidence coverage, and capture failures.

Initial delivery uses explicit account configuration and the existing `hotplate relay --config ...` command. New adapters start with local-only capture unless explicitly enrolled. Pi retains its managed connection behavior. Shared managed enrollment is a separate follow-up after its lifecycle rules are extracted from Pi.

**Capture interface**

```text
Native hooks / OpenCode plugin
    → Node capture command
    → transactional capture in SQLite
    → existing outbox and relay
    → aggregate and dashboard
```

Illustrative internal call sites:

```ts
await captureNativeHook({ host: "claude-code", input: process.stdin });
await captureNativeHook({ host: "codex", input: process.stdin });
await sendOpenCodeFact(extractOpenCodeV1Fact(input, output));
await sendOpenCodeFact(extractOpenCodeV2Fact(event));
```

The first two calls parse host payloads before persistence. Each OpenCode adapter removes raw content before sending metadata through the Node bridge.

Proposed internal interface:

```ts
type CaptureResult =
  | { kind: "committed"; accepted: number; duplicate: number }
  | { kind: "ignored" }
  | { kind: "unavailable"; reason: CaptureFailure };

interface NativeCaptureStore {
  capture(facts: readonly CaptureFact[]): Promise<CaptureResult>;
  close(): Promise<void>;
}
```

`CaptureFact` is a parsed metadata union for lifecycle transitions and evidence. It carries host, native session/actor identity, available run/turn identity, and occurrence identity. Stable native occurrences and locally generated delivery identities are separate variants.

The transaction owns duplicate receipts, correlation state, producer sequence allocation, observations, and outbox writes. A receipt is committed with its observations. Retries reuse the same identity and original metadata. Events without stable native IDs have explicitly limited deduplication.

Receipt identity includes account source, host, session, actor, native occurrence, and fact kind. The capture operation resolves one destination before acceptance. A retry remains bound to that destination. Later selection changes never move accepted observations or backlog.

The proposed modules are:

| Module | Responsibility |
| --- | --- |
| `src/integrations/{codex,claude-code}.ts` | Native hook parsing and evidence extraction |
| `src/integrations/opencode/{v1,v2}.ts` | Separate OpenCode entrypoints, native parsing, and lifecycle handling |
| `src/integrations/opencode/bridge.ts` | Shared metadata delivery to the Node capture command |
| `src/capture.ts` | Shared metadata contract and capture entry point |
| `src/store.ts` | Transactional receipts, scope state, observations, and delivery entries |
| `src/integrations/install.ts` | Owned configuration entries and diagnostics |
| Existing Pi extension and collector | Pi event semantics, with shared capture introduced after regression verification |

Adapters do not construct fake Pi contexts or coordinate storage tables. Hook execution never performs HTTP delivery. Capture failures produce redacted diagnostics and never emit host control decisions or modify tool output.

Handled capture errors return exit status zero and empty stdout to command-hook hosts. An internal deadline ends capture before the host deadline. Real-session tests must verify behavior after forced timeout and missing bridge execution. OpenCode catches bridge failures without throwing into its tool hook.

**Evidence and compatibility**

The proposed host field is separate from account source and model provider. OpenCode host identity distinguishes `opencode-v1` from `opencode-v2`; product-level views can group them as OpenCode. Native IDs are namespaced by host and actor. Missing model, parent, run, or turn information stays unknown. Arrival order does not establish execution order.

`read-result` keeps its existing meaning. New `skill-invocation` evidence records native tool invocation outcome separately. Its skill identity can be name-only when the host supplies no path. It does not contribute to successful-read counts or read-based skill share.

Shell text mentioning `SKILL.md` is not read evidence. General shell parsing is excluded from the initial release. A narrowly supported shell-read form requires a separate capability test before it can produce successful-read evidence.

Catalog snapshots require the effective host catalog. Filesystem discovery alone cannot establish catalog visibility. Unsupported coverage is distinct from a known capture gap. Unresolved runs must not merge into one synthetic path.

The migration must cover observation serialization, receipt state, catalog keys, query grouping, filters, and aggregate digests. Old native Pi observations can migrate as Pi. Untagged library-created observations require an explicit unknown/legacy policy.

The current network protocol rejects extra fields. Introduce version 2 with a receiver-first rollout. Keep version-1 parsing, canonical digests, and queued payloads intact. Never rewrite retained outbox payloads to add host identity. Unsupported receivers leave deliveries pending with an actionable status.

**Implementation sequence and acceptance gates**

1. Capture temporary, synthetic host fixtures. Verify native events, identities, outcome semantics, ordering, and hook deadlines on each installed version. Define a numerical capture deadline and startup-plus-commit p95 budget before accepting this architecture. Measure both under concurrent hook traffic.
2. Implement schema and protocol compatibility. Verify old databases, mixed outboxes, duplicate delivery, and receiver-first upgrades.
3. Implement durable native capture. Verify concurrent hook processes, repeated events, crash-before-commit, lost acknowledgments, and locked SQLite.
4. Add Claude Code capture, then both OpenCode adapters, then Codex. Each adapter must pass a real-session read/invocation test before release.
5. Add installation and capability diagnostics. Verify install/remove idempotency, disabled capture, configuration preservation, and missing Node behavior.
6. Add host-aware dashboard queries and evidence labels. Verify host isolation, unknown attribution, and unchanged Pi read statistics.
7. Exercise local and aggregate delivery end to end. Verify relay restart, network outage, retained backlog, and conflicting identity handling.

Every adapter test includes a successful read, a failed read, an unrelated tool call, repeated reads, resume, and child activity where supported. Prompt, output, credential, and error canaries must remain absent from SQLite, diagnostics, and delivery payloads.

OpenCode bridge tests also exclude raw canaries from arguments, stdin metadata, and process-launch diagnostics. Host command-hook stdin is transient raw input. It must never be logged or retained.

OpenCode tests run against pinned v1 and v2 binaries with isolated configuration and data directories. They cover the oldest supported release and a current release in each major. Installation tests verify wrong-major rejection, owned-entry removal, and no duplicate capture after migration. V2 tests also verify subscription cleanup and event-specific project attribution. Both majors must pass the same normalized-evidence fixtures. No test installs over the user's existing binary.

The final implementation runs `npm run check` and `npm run pack:dry`, plus the new host smoke tests. Unsupported host scenarios remain documented gaps rather than passing tests.

**Design comparison**

Candidate A uses native adapters and transactional direct capture. Candidate B uses private IPC and a resident account collector that owns capture and delivery.

Candidate A is the proposed base because it reuses existing storage and explicit relay operation without introducing service installation or IPC availability. Candidate B contributes durable acceptance receipts, strict occurrence identity, and explicit destination ownership.

An independent reviewer scored A at 22/25 and B at 21/25 across evidence, identity, repository fit, operations, and verification. Both candidates completed. The review favored A and identified unknown-run grouping and real host identities as mandatory verification gates.

A resident collector becomes justified if measured process startup or SQLite contention violates the capture budget, or continuous managed delivery becomes required. Transcript collection is excluded because it changes the live-capture scope and depends on unstable formats. Agent-invoked telemetry tools cannot provide passive coverage.

This plan verifies repository fit and documented integration options. Live capture, host coverage, latency, and minimum supported versions remain implementation gates.
