# Skill dashboard

The dashboard shows recorded skill activity, model read counts, and paths within sessions. It does not score skill quality.

- Overview shows per-skill trends, ranked skills, read patterns, and an exploration selection.
- Agents compares skill use across Pi, Claude Code, Codex, OpenCode, and untagged records.
- Models shows read counts by skill and model. Zero means no matching recorded reads, not a missed opportunity.
- Session paths shows recorded activity within each run, including requests, wrappers, read groups, and gaps.

The Skill trends chart starts with five skills in one stacked area chart. Each colored area shows successful reads in its UTC interval. Repeated successful reads count separately. The stack height is the total for the displayed skills. Intervals with no recorded successful reads have zero area.

Select a skill in the ranking or chart legend to inspect its paths. A newly selected skill outside the chart adds an area without replacing another skill. The values beside each name follow the date under the pointer or keyboard cursor.

Open Skills to search for exact skill names. Select or clear a checkbox to add or remove a skill in the same list. These actions preserve the exploration skill and dates. Custom displayed names survive refreshes and filter changes without substitution, even when a skill has no reads in the filtered report. Each skill keeps its color while the page remains open.

Drag across the chart to select dates. One band follows the pointer continuously. New selections use complete UTC hours in hourly views, or complete UTC days in longer views. Drag the band to move the interval without changing its duration, including partial custom periods. Drag either handle to resize it. Press Escape during a drag to cancel it. The ranking, model counts, and matching paths update on release.

With the chart focused, Left and Right inspect intervals. Enter selects one, and Shift+Enter extends the selection. With a handle focused, Left and Right change that edge by one hour in hourly views, or one day in longer views. With the band focused, these keys move the whole interval. Shift multiplies the step by seven. The activity data table shows the displayed skills, date-selection buttons, and exact counts, with 24 intervals per page. Clear either selection chip to widen the view.

The exploration panel lists matching paths and model counts for successful reads that match the selected skill and UTC dates. Select a model to see paths where that model made a matching read. Open a path to inspect all its recorded steps, then return to the selection. Full-report model details opens the Models matrix for the current report filters, not the selected interval. Skill names combine across source variants in the main views. Expand Files and requests in Models to inspect the original paths and machines.

An interval compares with the immediately preceding interval of equal duration. With only a skill selected, the comparison uses the latest available elapsed period of up to seven days. An equal preceding period stays inside the loaded scope. Comparison totals show recorded paths with successful reads and raw read counts. A skill share is the number of read-bearing paths containing that skill divided by all read-bearing paths in the period. Repeated reads count once in the share and every time in the raw read count. If the previous interval is outside the current report scope, Hotplate does not treat it as zero.

## Agents

Hosts record different evidence. Pi, Claude Code, and OpenCode record reads of `SKILL.md` files. Claude Code and OpenCode also record native skill invocations. Codex records read attempts without an outcome. Successful reads alone cannot compare these hosts, so the Agents tab uses skill use.

A skill use is a successful read, a successful native skill invocation, or a read attempt. Read attempts show as unconfirmed. Failed reads and failed invocations are failures, not uses. Requests and wrappers are not uses. Skill use does not change the successful-read counts in other tabs.

The unit of comparison is the agent session: one host session in one machine and account source. A run means different things in different hosts, so the Agents tab does not compare runs. Records without a host show as Unknown host.

Some limits apply to these comparisons:

- Claude Code subagents share the session of their parent. OpenCode subagents run in child sessions, so each OpenCode subagent counts as one more agent session.
- Skills are grouped by name. A plugin prefix, for example `superpowers:`, is not part of the name.
- Only reads have model attribution. A model filter removes native invocations and read attempts, so Codex and most Claude Code uses disappear from the Agents tab.

- The summary shows the skill uses, sessions with skill use, distinct skills, failures, and last use for each host.
- The chart stacks skill uses per UTC interval by host. Move the pointer over the chart, or focus it and press Left or Right, to read the values for one interval. The activity data table gives exact counts.
- The matrix shows skills by host. Agent share is the number of sessions of a host that used the skill, divided by the sessions of that host with skill use. Select the Skill uses measure to show raw counts. An asterisk marks a cell that has only read attempts.

Select a matrix cell to open the session paths of that host that contain the skill. Select Show only this agent to apply the Agent host filter to all tabs. Select Show all agents to remove it.

Each host keeps one color. Labels and the data table repeat each value, so color is not the only identification.

## Filters

The Filters panel changes the report scope. Exploration selects paths within that scope without altering the overview totals or the Models matrix. Last 7 days is the default. Refresh recalculates relative periods but keeps custom UTC dates fixed. Reset restores Last 7 days and the top five trends. Select All time to recover older records. The filter summary appears only for applied restrictions. Windows up to seven days use UTC hours. Longer windows use daily or adaptive bins without truncation.
Skill catalog is separate from About this data, a disclosure available on every tab. The disclosure defines counts, grouping, model attribution, paths, gaps, and capture coverage.

## Local preview

Start an isolated preview without a production image:

```bash
npm run dashboard:preview
```

Open the printed URL, normally `http://127.0.0.1:7346/?preview=1`.
The preview uses synthetic data in a new temporary database. It does not use `HOTPLATE_DB` or change the default database.
The fixture contains 21 days of activity, 174 sessions, three projects, three named models, unknown model reads, failures, and capture gaps. Its sessions come from Pi, Claude Code, Codex, OpenCode v2, and untagged records.
Model counts in this fixture are examples, not measured comparisons.

Press Ctrl+C to stop the server and remove its temporary database.
If the process stops without cleanup, its data remains in the printed temporary directory.

Select a port or an empty state:

```bash
npm run dashboard:preview -- --port 7347
npm run dashboard:preview -- --scenario empty
npm run dashboard:preview -- --scenario missing
npm run test:dashboard-preview
```

The existing `dashboard:demo` command remains available. Its small fixture is separate from this preview.

## Browser verification

Run the repeatable Chromium checks:

```bash
npm run smoke:dashboard
```

The script starts disposable previews and a private headless browser. It removes the browser profile and preview databases after the checks.
It prints the retained screenshot directory and response-size measurements.
Set `CHROMIUM` to select a browser executable. Set `HOTPLATE_SCREENSHOT_DIR` to choose an artifact directory.

The checks freeze browser time for weekly defaults and retain historical All time scenarios. They cover desktop, mobile, 320px layouts, editable rows, hourly edges, missing periods, and repeated reads. Mouse, touch, and keyboard checks cover continuous selection, resize, move, cancellation, and path navigation. They also cover comparison counts, linked rankings and models, applied filters, hostile text, empty states, failed refreshes, and retry.
A larger controlled response checks bounded rendering. It is not a production storage-load benchmark.

## What the evidence means

- A successful read means a tool read `SKILL.md` successfully. It does not prove that the model followed the instructions.
- A request means a skill command was recorded. It does not prove a successful load.
- A wrapper means skill content appeared in the input. It has no model attribution.
- A failed read is a read error, not a missed opportunity.
- A catalog entry with no matching use is not proof that the model needed the skill.
- A path shows recorded order within one run. Skills in the same turn have no proven order between them.
- A gap interrupts the path. It represents filtered or lost records.

Hotplate does not capture task outcomes, expected skill choices, causal parent-skill links, or agent identities. Miss rates and usefulness scores require those signals.
Model comparisons use read results only. Unknown models remain separate from named models.

The dashboard is read-only. Its filters are not access controls. The server still materializes the full filtered dataset before browser pagination.
