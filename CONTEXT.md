# Hotplate glossary

Hotplate stores local pi skill analytics for one OS account.

## Terms

- **Observation**: A metadata-only fact from a live pi session. An observation never contains a raw prompt, a full tool output, a credential, or an error body.
- **Evidence**: The reason that Hotplate records an observation. Evidence can be a command intent, an observed skill wrapper, a skill file read result, a catalog snapshot, or a capture gap.
- **Command intent**: A slash command request for a skill. It is not proof that pi loaded the skill.
- **Observed wrapper**: A skill wrapper found after pi input handling. It can come from slash expansion, pasted text, or another transform.
- **Read result**: A `SKILL.md` read by a tool call. Successful and failed reads are separate facts.
- **Capture gap**: A known loss of observations. Hotplate records the count and reason when it can.
- **Segment**: A contiguous part of a pi session, split by startup, reload, new session, resume, fork, branch, or an unknown boundary.
- **Activation**: One observed skill in one session, segment, and run. Activation counts are different from read occurrence counts.
