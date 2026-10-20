# Activity dashboard

The dashboard shows recorded skill and file evidence, plus session paths. It does not score skill quality.

- Metrics has one trend and one comparison for Skills, Resources, or Both. The same controls apply to both views.
- Session paths shows requests, wrappers, read groups, invocations, attempts, and gaps within recorded runs.
- Resources shows file inventory, access evidence, attribution, and observation coverage.

## Metrics

Both is the default Content, with Recorded activity as its measure. Select Skills to show successful reads, skill uses, read failures, native invocations, invocation failures, read attempts, requests, or wrappers. Native invocations counts successful invocations. Read attempts remain unconfirmed.

Split by selects Skill / total ranking, Agent, Model, or Agent + model. The trend stacks counts for the selected measure. The comparison shows a total ranking or a matrix. Matrix columns contain observed cohorts, including Unknown model and No model attribution where applicable. It never constructs all possible agent/model combinations.

For Skill uses, Display can show Count or Session share in the comparison. The trend continues to show counts. Session share divides sessions with the skill use by sessions with any skill use in that cohort. A model cohort has its own denominator. Sessions that span models can contribute to several columns. A missing denominator displays a dash, not zero.

A skill use is a successful read, a successful native skill invocation, or a read attempt. Failed reads and failed invocations are excluded. Requests and wrappers are excluded. Hosts capture different evidence: Codex read attempts have no known outcome.

Skill names retain their exact recorded form, including plugin prefixes. This changes the former Agents view, which removed prefixes such as `superpowers:`. Files with the same exact name remain grouped. Select a count to inspect matching evidence and session paths. Expand Files and requests in the skill detail to inspect original paths and machines. The catalog follows machine, project, and date filters only.

The unit for session share is one host session on one machine and account source. Records without a session use their segment identity. Claude Code subagents share their parent session. OpenCode subagents use child sessions.

In Skills, the default trend shows successful reads for five skills. Open Skills to search exact names and add or remove layers. Custom names survive refreshes and filter changes without substitution. Each name keeps its color while the page remains open. Agent, Model, and Agent + model show all observed series. Exact counts follow in View activity data, with 24 intervals per page. Undated evidence stays in the comparison and is omitted from the trend.

Legend counts total the displayed range, or the selected dates after a selection. Pointer hover and keyboard inspection temporarily show one interval. Leaving inspection restores range totals. The readout names the scope for these counts.

## Resources and Both

Select Resources to compare activity on all tracked files, including `SKILL.md`. Select Both to combine skill evidence and file activity. Supporting files appear under their physical owning skill. Expand an owner to see its entrypoint and supporting files. Associated legacy records appear as Skill evidence with their agent name. File metadata absent from those records remains unrecorded. Parent totals include children once. Unowned files and unresolved skill locations remain visible.

Both counts a mirrored native skill read and resource read once. Independent filesystem opens and accesses remain separate evidence. Resources retains the original file observations. Equal file or skill names do not merge physical locations.

Recorded activity is the default measure in these views. It includes failures, attempts, and filesystem events. Specific measures separate successful reads, read failures, read attempts, filesystem opens, and filesystem accesses. Both also offers the skill evidence measures. Session share remains available only in Skills. Each content mode remembers its measure.

Search matches file paths and owner names. A matching supporting file appears under its owner. Pagination keeps parents with their children. Select a count to see that cell's evidence breakdown, physical location, attribution, and first/latest evidence timestamps. These details do not invent a skill session path for filesystem activity.

Only files with matching activity enter the main comparison. The Resources workspace retains inventory-only files and observation coverage. Zero recorded events do not establish that a file was unused.

Agent, model, machine, project, and date filters also apply to resource activity. Resource-only agent/model pairs appear in these views. Unknown and non-agent evidence retain separate attribution. A known model slice cannot claim activity with an unknown model.

Resource and combined views request compact aggregates from the server when content, measures, splits, or selected dates change. The full trend remains in place during a date-selection request. Selected counts show a loading state or a retry action until the requested counts arrive. Hover and keyboard inspection remain local. Returning to Skills restores its measure, split, and display.

## Selection and paths

Select a skill in the successful-read ranking or legend to explore its successful reads. A skill outside the default five adds a trend layer. Drag across the chart to select UTC dates. The comparison follows these dates. In Skills, changing Measure, Split by, or Display preserves the interval and does not fetch another report.

The Successful-read exploration panel remains specific to successful reads, including when the trend shows another measure. Its model counts, period comparison, and matching paths use successful reads in the selected interval. Skill details opens the shared detail region in Metrics. Model and path drilldowns preserve the selected read, model, and dates. The local path Model filter also supports native invocations and read attempts. It matches the same skill and measure as the selected count.

Drag the selection band to move it without changing its duration. Drag either handle to resize it. Press Escape during a drag to cancel it. With the chart focused, Left and Right inspect intervals. Enter selects one. Shift+Enter extends the selection. With a handle focused, Left and Right change one edge. With the band focused, these keys move the interval. Shift multiplies the step by seven. Hourly views use hour steps. Longer views use day steps.

An interval compares with the immediately preceding interval of equal duration. With only a skill selected, the comparison uses the latest period of up to seven days. Comparison shares count read-bearing paths that contain each skill. Repeated reads count once in the share and every time in the read count. A previous interval outside the loaded scope remains unavailable.

Read patterns is a collapsed disclosure. It shows same-group and consecutive successful-read relationships, with their original path evidence. Capture gaps represent lost records. Filtered gaps represent hidden records. Neither gap creates a relationship across the missing evidence.

## Filters

Agent, Model, and Period remain visible in every workspace. Select All agents or All models to broaden the scope. Models are atomic provider/id pairs. Unknown model selects model-bearing evidence without attribution. Requests and wrappers have no model dimension and are excluded by an explicit model selection.

The slicers allow observed agent/model combinations in the current machine, project, source, and date context. Incompatible options are disabled. A selection that becomes unavailable stays visible until you clear it or broaden the scope. Changing an agent or model preserves the project.

More filters contains machine, project, command source, and custom UTC dates. Source applies to requests only. The summary shows applied restrictions.

Last 4 hours is the default Period. The presets also include Last 30 minutes, Last 1 hour, Last 24 hours, and the existing day ranges. Refresh recalculates relative periods and keeps custom UTC dates fixed. Reset restores Last 4 hours, Both, Recorded activity, Count, the total ranking, and the top five trends. Reset also restores each content mode's default measure. Select All time to recover older records.

Windows up to seven days use UTC hours. Longer windows use daily or adaptive bins without truncation. About this data remains available from every workspace.

## Local preview

Start an isolated preview without a production image:

```bash
npm run dashboard:preview
```

Open the printed URL, normally `http://127.0.0.1:7346/?preview=1`.
The preview uses synthetic data in a new temporary database. It does not use `HOTPLATE_DB` or change the default database.
The fixture contains 21 days of skill activity, three projects, three named models, unknown model reads, failures, and capture gaps. Its latest hour includes Claude file activity, a mirrored entrypoint, supporting files, unowned files, and unknown attribution. Its sessions come from Pi, Claude Code, Codex, OpenCode v2, and untagged records.
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

The checks freeze browser time for recent defaults and retain weekly Skills and historical All time scenarios. They verify exact preset bounds on both analytics paths, Refresh, custom dates, Reset, and remembered content measures. They cover desktop, mobile, 320px layouts, editable rows, hourly edges, missing periods, and repeated reads. Mouse, touch, and keyboard checks cover continuous selection, resize, move, cancellation, and path navigation. They also cover comparison counts, linked rankings and models, applied filters, hostile text, empty states, failed refreshes, and retry.
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
Model comparisons use attributed read results, native invocations, and read attempts. Unknown models remain separate from records without model attribution.

The dashboard is read-only. Its filters are not access controls. Skills retains its filtered report for local exploration. Resource and combined analytics send aggregate bins, rows, and cohort counts; raw resource history stays on the server.
