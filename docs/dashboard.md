# Skill dashboard

The dashboard shows recorded skill activity, model read counts, and paths within sessions. It does not score skill quality.

- Overview shows activity over time, ranked skills, and read patterns within or between consecutive read groups.
- Models shows read counts by skill and model. Zero means no matching recorded reads, not a missed opportunity.
- Session paths shows recorded activity within each run, including requests, wrappers, read groups, and gaps.

Select a skill name, then View session paths, to find runs that contain that skill. Other recorded steps remain visible.
Skill names combine across source variants in the main views. Expand Files and requests to inspect the original paths and machines.
The Filters panel changes the report scope. Skill and relationship selections change path details only, not the overview totals.
All time is the default. The filter summary appears only for applied restrictions. Activity buckets use UTC and adapt to cover long intervals without truncation.
Skill catalog is separate from About this data, a disclosure available on every tab. The disclosure defines counts, grouping, model attribution, paths, gaps, and capture coverage.

## Local preview

Start an isolated preview without a production image:

```bash
npm run dashboard:preview
```

Open the printed URL, normally `http://127.0.0.1:7346/?preview=1`.
The preview uses synthetic data in a new temporary database. It does not use `HOTPLATE_DB` or change the default database.
The fixture contains 21 days of activity, 111 sessions, three projects, three named models, unknown model reads, failures, and capture gaps.
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

The checks cover desktop and mobile layouts, keyboard navigation and help, exact counts, applied-filter summaries, path selection, hostile text, empty states, failed refreshes, and retry.
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
