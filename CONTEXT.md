# Hotplate glossary

Hotplate describes skill-use evidence from live coding-agent sessions. Local accounts can share that evidence through an explicitly configured aggregate.

## Language

**Observation**:
A metadata-only fact from a live coding-agent session, filesystem observer, or inventory scan. It contains no raw prompt, full tool output, credential, or error body.

**Host**:
The coding-agent integration that produced an observation. OpenCode v1 and OpenCode v2 are separate hosts, distinct from machine, account source, and model provider.

**Evidence**:
The recorded basis for a skill-use claim, content availability, or capture coverage. Evidence types retain their distinct meaning and strength.

**Resource**:
A file location in selected installed or project skill content, including support files without a skill owner. Its identity includes the account source, filesystem namespace, and canonical path.

**Installation authority**:
The basis for selecting an exact content boundary: an installed collection, a project convention, a host advertisement, or an explicit content declaration.

**Installation alias**:
A logical installation path that selects an exact physical content subtree. Multiple aliases can name the same resource locations.

**Project boundary**:
The reported project or nearest repository or worktree boundary that limits a host's project skill discovery.

**Resource access**:
Evidence of a structured read, an inferred command read, a read attempt, or a filesystem open or access. It does not prove model consumption.

**Tool activity**:
Recorded confirmed reads, inferred reads, read attempts, read failures, and native skill invocations with their outcomes. It excludes filesystem events, catalog discovery, command intents, and wrappers.

**Recorded activity**:
Evidence occurrences across selected content, including tool activity, filesystem events, requests, and wrappers. Mirrored skill and resource facts represent one occurrence, not unique content consumption.

**Tool coverage**:
A record of an observed operation, its known outcome, and whether its file targets can be resolved. It does not establish complete capture.

**Opaque operation**:
An observed tool operation whose file access remains unresolved. It is not evidence of a read of a particular skill or reference.

**Owning skill**:
The physical skill entrypoint associated with a supporting file, identified by machine, account source, filesystem namespace, and canonical path. Equal skill names do not establish shared ownership.

**Inventory snapshot**:
A metadata-only enumeration of files available in a root. A completed scan can establish presence or absence. An incomplete scan cannot establish absence. Session scope comes from host-advertised roots when available; conventional roots provide inferred scope. Roots learned from other sessions remain unassigned and establish global presence only.

**Observer coverage**:
The recorded operating state of an observation mechanism for a root and filesystem namespace. Heartbeats bound observed intervals. Missing or stale coverage is unknown, not zero use.

**Process binding**:
An association between a harness and a process identified by boot identity, PID, and start time. Descendant readers can inherit that association through wrappers. A shared process does not identify one conversation.

**No observed access**:
An inventoried file with no attributed access during a confirmed observation interval. It is not proof that a skill was ignored or never entered a model's context.

**Skill path**:
The recorded sequence of skill requests, wrappers, and reads within one run. A skill path does not prove a dependency or a causal relationship.

**Exploration selection**:
A skill name, a UTC interval, or both within the selected dashboard scope. It identifies skill paths with a matching successful read but retains their other recorded steps.

**Read-bearing path**:
A skill path with at least one recorded successful read in the selected interval. Repeated reads of one skill in that path count as one path when comparing skill shares.

**Skill share**:
The fraction of recorded read-bearing paths in an interval that contain a successful read of a given skill. It is unavailable without read-bearing paths and is not a fraction of all coding-agent sessions.

**Model in selection**:
A model attributed to a successful read that matches the selected skill and UTC interval. Its read count includes repeats; its path count counts each run once. Unknown models remain separate.

**Unused catalog entry**:
A catalog entry with no matching successful read or wrapper in the selected view. It is not proof of a missed opportunity.
_Avoid_: Missed skill, ignored skill

**Missed opportunity**:
A required skill use that did not occur. Skill-use evidence alone cannot establish the requirement.

**Skill usefulness**:
The effect of a skill on a task outcome. Read frequency alone does not establish usefulness.

**Command intent**:
A slash command request for a skill. It is not proof that Pi loaded the skill.
_Avoid_: Proven load, human load

**Observed wrapper**:
A skill wrapper found after Pi input handling. It can come from slash expansion, pasted text, or another transform.

**Read result**:
A `SKILL.md` read by a tool call. Successful and failed reads are separate facts.

**Confirmed read**:
A successful result from a structured file-read tool. It does not prove that the model followed the file's instructions.

**Inferred read**:
A recognized literal read command with a successful tool outcome. Its returned content can remain unknown.

**Read attempt**:
A tool call with a known file target but an unconfirmed read outcome. It does not contribute to confirmed or inferred reads.

**Requested portion**:
The whole file or line range requested by a tool call. It does not establish what the tool returned.

**Returned portion**:
The whole file or line range reported by a successful tool result, with its reported truncation state. Missing delivery information remains unknown.

**Native skill invocation**:
A host's native skill tool invocation with its observed outcome. It is distinct from a file read and does not contribute to successful-read counts.

**Skill use**:
A successful read, a successful native skill invocation, or a read attempt. It is the measure that compares hosts, because each host records different evidence. Read attempts stay separate as unconfirmed uses. Skill use does not change successful-read counts.

**Agent session**:
One host session in one machine and account source. It is the unit for agent comparisons, because a run means different things in different hosts. A Pi session can contain several runs. A Claude Code subagent shares the session of its parent. An OpenCode subagent has its own session.

**Agent share**:
The fraction of the agent sessions with skill use in one host that contain a use of a given skill. It is not a fraction of all sessions of that host.

**Catalog snapshot**:
The skill catalog visible to one live coding-agent session at a capture point. Catalog membership is not proof of skill use.

**Capture gap**:
A known loss of observations, with a count and reason when available.

**Segment**:
A contiguous part of a Pi session, split by startup, reload, new session, resume, fork, branch, or an unknown transition.

**Activation**:
One observed skill in one machine, account source, project, session, segment, and run. Activation counts differ from read occurrence counts.

**Machine**:
A scoped identity grouping account sources. Static credentials use an operator-registered host identity; managed enrollment assigns a distinct identity to its source. Neither is hardware attestation.
_Avoid_: Source, producer

**Account source**:
A persistent identity for one participating account at one collector origin. Several static account sources can belong to one machine.
_Avoid_: Machine, command source

**Command source**:
The Pi input category of a command intent: interactive, RPC, or extension. It is not an account identity or proof of human action.

**Enrollment**:
An explicit account-source association with one collector origin for newly captured live observations. It excludes observations captured before enrollment.

**Collector origin**:
The fixed network origin of the aggregate selected by an enrolled account source.

**Delivery backlog**:
Live-captured observations that await acknowledgment from the aggregate, including blocked deliveries.
_Avoid_: Historical import, transcript archive

**Blocked delivery**:
A retained observation that normal delivery excludes because it is oversized, invalid, or in conflict with an accepted identity.

**Aggregate**:
The combined metadata view from enrolled account sources, with machine and source identities intact.

**Dashboard policy**:
An explicit aggregate read-access choice: a separate Basic credential or `dashboard: {kind:"public"}` for anonymous reads.
Public access does not remove ingest token identity/authentication, Host/Origin checks, or read-only dashboard methods.
The dedicated trusted-LAN Unraid deployment serves the public dashboard at `http://192.168.88.12` on port 80.

**Managed selection**:
The account-wide choice of local-only capture or one collector origin. Each running session applies that choice independently.

**Applied revision**:
The selection revision a particular session has applied to its live capture and delivery. It does not certify that other sessions have switched.

**Open enrollment**:
Permission for reachable clients to register new account sources. It is not trusted membership and does not replace source-bound ingest authorization.

**Managed connection**:
A user-selected live enrollment whose delivery operates while participating Pi sessions run. Disconnect selects local-only capture without deleting that enrollment's retained backlog.

**Manual override**:
Explicit account configuration that takes precedence over managed selection and refuses managed mutations. Delivery is operated independently rather than owned by participating Pi sessions.
