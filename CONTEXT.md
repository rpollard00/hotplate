# Hotplate glossary

Hotplate describes skill-use evidence from live Pi sessions. Local accounts can share that evidence through an explicitly configured aggregate.

## Language

**Observation**:
A metadata-only fact from a live Pi session. It contains no raw prompt, full tool output, credential, or error body.

**Evidence**:
The reason for an observation: command intent, observed wrapper, read result, catalog snapshot, or capture gap.

**Command intent**:
A slash command request for a skill. It is not proof that Pi loaded the skill.
_Avoid_: Proven load, human load

**Observed wrapper**:
A skill wrapper found after Pi input handling. It can come from slash expansion, pasted text, or another transform.

**Read result**:
A `SKILL.md` read by a tool call. Successful and failed reads are separate facts.

**Catalog snapshot**:
The skill catalog visible to one live Pi session at a capture point. Catalog membership is not proof of skill use.

**Capture gap**:
A known loss of observations, with a count and reason when available.

**Segment**:
A contiguous part of a Pi session, split by startup, reload, new session, resume, fork, branch, or an unknown transition.

**Activation**:
One observed skill in one machine, account source, project, session, segment, and run. Activation counts differ from read occurrence counts.

**Machine**:
An operator-registered host identity shared by its participating account sources.
_Avoid_: Source, producer

**Account source**:
A persistent identity for one participating account installation. Several account sources can belong to one machine.
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
