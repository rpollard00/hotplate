export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hotplate · Skill activity</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <a class="skip-link" href="#workspace">Skip to workspace</a>
  <header class="app-header">
    <div class="identity"><span class="brand-mark" aria-hidden="true">h</span><strong>hotplate</strong><span class="identity-note">Skill activity</span><span id="preview-label" class="preview" hidden>Synthetic preview</span></div>
    <div class="header-actions"><span id="status-text" role="status">Loading</span><button id="refresh-data" class="quiet" type="button">Refresh</button></div>
  </header>
  <div class="shell">
    <nav class="workspace-nav" aria-label="Workspaces">
      <button type="button" data-workspace="overview" aria-current="page">Overview</button>
      <button type="button" data-workspace="models">Models</button>
      <button type="button" data-workspace="paths">Session paths</button>
    </nav>
    <div class="scope-bar">
      <p id="scope-summary" hidden></p>
      <div class="scope-actions"><label class="inline-label">Period<select id="time-preset"><option value="all">All time</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label><button type="button" id="toggle-filters" class="quiet" aria-expanded="false" aria-controls="scope-panel">Filters</button><button type="button" id="reset-filters" class="quiet">Reset</button></div>
    </div>
    <section id="scope-panel" class="panel" hidden aria-label="Filters">
      <form id="filter-form" class="filter-grid">
        <label>Agent host<select id="host-filter" name="host"><option value="">All agent hosts</option></select></label>
        <label>Machine<select id="machine-filter" name="machineId"><option value="">All machines</option></select></label>
        <label>Project<select id="project-filter" name="projectCwd"><option value="">All projects</option></select></label>
        <label>Command source <span>Requests only</span><select id="source-filter" name="source"><option value="">All command sources</option><option value="interactive">Interactive</option><option value="rpc">RPC</option><option value="extension">Extension</option></select></label>
        <label>Model provider <span>Reads only</span><select id="model-provider-filter" name="modelProvider"><option value="">All providers</option></select></label>
        <label>Model <span>Reads only</span><select id="model-id-filter" name="modelId"><option value="">All models</option></select></label>
        <label>From (UTC)<input id="from-filter" name="fromObservedAt" type="datetime-local" step="0.001"></label>
        <label>To (UTC)<input id="to-filter" name="toObservedAt" type="datetime-local" step="0.001"></label>
        <div class="filter-actions"><button type="submit">Apply filters</button></div>
      </form>
      <p class="footnote">Filters apply to all tabs.</p>
    </section>
    <section id="message-panel" class="message panel" role="status" hidden></section>
    <main id="workspace" tabindex="-1" aria-busy="true">
      <div id="dashboard-content" hidden>
        <section id="overview-workspace" aria-labelledby="overview-heading">
          <div class="page-heading"><div><h1 id="overview-heading">Skill activity</h1></div></div>
          <div id="overview-cards" class="metrics-grid" aria-label="Filtered totals"></div>
          <div id="evidence-context" class="evidence-context"></div>
          <div class="overview-grid">
            <section class="panel activity-panel" aria-labelledby="activity-heading"><div class="section-heading"><div><h2 id="activity-heading">Skill trends</h2></div><div class="activity-actions"><span class="small muted">UTC</span><button id="view-explorer" class="quiet" type="button" hidden>View selection</button></div></div><div id="activity-chart"></div></section>
            <section class="panel" aria-labelledby="skills-heading"><div class="section-heading"><div><h2 id="skills-heading">Most-read skills</h2></div><span class="small muted">Successful reads</span></div><label class="search-label"><span class="sr-only">Find a skill</span><input id="skill-search" type="search" placeholder="Find a skill…"></label><div id="skill-table"></div></section>
          </div>
          <section id="explorer-panel" class="panel explorer-panel" aria-labelledby="explorer-heading" tabindex="-1" hidden>
            <div class="section-heading"><div><p class="small muted">Within the current filters</p><h2 id="explorer-heading">Explore selection</h2></div><div class="explorer-actions"><button id="explore-models" class="quiet" type="button" hidden>Full-report model details</button><button id="clear-explorer" class="quiet" type="button">Clear selection</button></div></div>
            <div id="explore-chips" class="explore-chips"></div>
            <p id="explore-rule" class="small muted"></p>
            <div id="explore-totals" class="explore-totals"></div>
            <div class="explore-layout"><section id="explore-comparison" aria-label="Period comparison"></section><div class="explore-side"><section aria-labelledby="explore-path-heading"><div class="section-heading"><h3 id="explore-path-heading">Matching paths</h3><button id="explore-all-paths" class="link" type="button">View all</button></div><div id="explore-paths"></div></section><section aria-labelledby="explore-model-heading"><h3 id="explore-model-heading">Models in selection</h3><p class="footnote">Successful reads matching the selected skill and UTC dates.</p><div id="explore-model-list"></div></section></div></div>
            <p id="explore-announcement" class="sr-only" role="status" aria-live="polite"></p>
          </section>
          <section class="panel" aria-labelledby="relationships-heading"><div class="section-heading"><div><h2 id="relationships-heading">Read patterns</h2></div><button type="button" id="browse-paths" class="quiet">View session paths</button></div><div id="relationship-view"></div></section>
          <details class="panel" id="catalog-context"><summary>Skill catalog</summary><p class="footnote">The catalog follows machine, project, and date filters only.</p><label class="search-label">Find a catalog skill<input id="catalog-search" type="search" placeholder="Search names…"></label><div id="catalog-list"></div></details>
        </section>
        <section id="models-workspace" aria-labelledby="models-heading" hidden>
          <div class="page-heading"><div><h1 id="models-heading">Skills by model</h1></div></div>
          <section class="panel"><div class="section-heading"><label class="search-label">Find a skill<input id="model-search" type="search" placeholder="Search skill names…"></label><label class="inline-label">Measure<select id="model-measure"><option value="successfulReads">Successful reads</option><option value="failedReads">Read failures</option></select></label></div><div id="model-matrix" class="table-wrap" tabindex="0" role="region" aria-label="Skill by model counts"></div><p class="matrix-scroll-hint footnote">Scroll horizontally to compare models.</p><div id="model-pagination"></div><p class="footnote">Skills are grouped by name.</p></section>
          <section id="skill-detail" class="panel" aria-live="polite"></section>
        </section>
        <section id="paths-workspace" aria-labelledby="paths-heading" hidden>
          <div class="page-heading"><div><h1 id="paths-heading">Session paths</h1><p>Recorded activity by session and available run.</p></div></div>
          <div class="path-toolbar panel"><div><strong id="path-focus-label">All session paths</strong><p class="small">These controls filter paths only.</p><button id="back-to-explorer" type="button" class="link" hidden>Back to exploration</button></div><label class="search-label"><span class="sr-only">Search session paths</span><input id="route-search" type="search" placeholder="Find project or skill…"></label><label class="inline-label">Model<select id="route-model"><option value="">All models</option></select></label><button type="button" id="clear-path-focus" class="quiet">Reset path filters</button></div>
          <div id="relationship-detail" class="panel" hidden></div>
          <div class="path-layout"><section class="panel route-master" aria-label="Recent session paths"><div class="section-heading"><h2>Recent paths</h2><span class="small muted" id="route-count"></span></div><div id="route-list"></div><div id="route-pagination"></div></section><section id="chain-view" class="panel route-detail" aria-label="Selected session path" tabindex="-1"></section></div>
        </section>
      </div>
    </main>
    <details class="panel" id="data-help"><summary>About this data</summary><div class="data-definitions">
      <p>A read is a successful tool read of <code>SKILL.md</code>. A request records a skill command. A wrapper records skill text found in input.</p>
      <p>Skills are grouped by name, even when their file paths or contents differ.</p>
      <p>Only read results have model attribution.</p>
      <p>Each path represents one recorded run. A session can contain multiple runs. Order within a read group is unknown.</p>
      <p>Capture gaps represent lost records. Filtered gaps represent records hidden by filters.</p>
      <p>Capture requires the Hotplate extension in a live Pi session. Reads through the shell or external agents can be absent.</p>
    </div></details>
  </div>
  <script src="/assets/app.js"></script>
</body>
</html>`;

export const dashboardCss = `:root {
  color-scheme: light;
  --bg: #f5f5f0; --panel: #fff; --ink: #222d2b; --muted: #626c68; --line: #dfe3dc;
  --accent: #b44c2e; --teal: #267265; --soft: #edf3ef; --bad: #a63436;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; color: var(--ink); background: var(--bg); font-size: 14px; line-height: 1.5; }
button, input, select { font: inherit; }
button, select, summary { cursor: pointer; }
button { border: 1px solid var(--teal); border-radius: 6px; background: var(--teal); color: white; padding: 8px 13px; font-weight: 600; }
button:hover { filter: brightness(.95); }
button:disabled { cursor: default; opacity: .45; }
button.quiet { background: transparent; border-color: var(--line); color: var(--ink); }
button.link { border: 0; padding: 0; background: transparent; color: var(--teal); text-align: left; overflow-wrap: anywhere; }
:focus-visible { outline: 3px solid #bc5936; outline-offset: 3px; }
input, select { border: 1px solid var(--line); border-radius: 5px; padding: 8px 10px; background: white; color: var(--ink); min-width: 0; max-width: 100%; }
input { width: 100%; }
label { display: grid; gap: 5px; font-size: 12px; font-weight: 600; color: var(--muted); }
h1, h2, h3, p { margin: 0; overflow-wrap: anywhere; }
h1 { font-size: clamp(26px, 3vw, 36px); line-height: 1.18; font-weight: 620; letter-spacing: -.035em; margin: 4px 0 9px; }
h2 { font-size: 17px; font-weight: 650; letter-spacing: -.02em; }
h3 { font-size: 15px; }
p { color: var(--muted); }
.small, .footnote { font-size: 12px; }
.footnote { margin-top: 14px; }
.muted { color: var(--muted); }
.app-header { min-height: 64px; padding: 12px 3.2%; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); background: #fcfcf9; }
.identity, .header-actions { display: flex; gap: 14px; align-items: center; }
.identity strong { font-size: 22px; letter-spacing: -.06em; }
.brand-mark { display: grid; place-items: center; width: 29px; height: 29px; background: var(--accent); color: #fff; font-size: 24px; font-weight: 750; border-radius: 8px 8px 8px 2px; }
.identity-note { border-left: 1px solid var(--line); padding-left: 14px; color: var(--muted); font-size: 12px; }
.preview { font-size: 10px; padding: 3px 7px; color: #824220; background: #f8ebd9; border-radius: 4px; }
#status-text { color: var(--muted); font-size: 12px; }
#status-text::before { content: ''; display: inline-block; width: 6px; height: 6px; background: #9d8a4e; border-radius: 50%; margin-right: 7px; }
#status-text[data-kind=ready]::before { background: var(--teal); }
#status-text[data-kind=error]::before { background: var(--bad); }
.shell { width: min(1440px, 93.6%); margin: auto; }
.workspace-nav { display: flex; gap: 26px; padding-top: 8px; border-bottom: 1px solid var(--line); }
.workspace-nav button { padding: 14px 1px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); font-size: 13px; }
.workspace-nav button[aria-current] { border-bottom-color: var(--teal); color: var(--ink); }
.scope-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 15px 0; font-size: 12px; }
.scope-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.inline-label { display: flex; align-items: center; gap: 8px; }
.scope-actions button, .scope-actions select { padding: 5px 9px; font-size: 12px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 22px; min-width: 0; margin-bottom: 18px; }
.filter-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; align-items: end; }
.page-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.page-heading > div, .section-heading > div { min-width: 0; }
.section-heading > button { flex-shrink: 0; }
.page-heading { padding: 15px 0 25px; }
.section-heading { margin-bottom: 18px; }
.section-heading p { margin-top: 4px; font-size: 12px; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 9px; background: white; }
.metric-card { padding: 22px 26px; border-right: 1px solid var(--line); }
.metric-card:last-child { border: 0; }
.metric-label { font-size: 12px; color: var(--muted); font-weight: 600; }
.metric-value { display: block; font-size: 38px; line-height: 1.3; letter-spacing: -.04em; font-variant-numeric: tabular-nums; margin: 5px 0; }
.metric-note { font-size: 11px; color: var(--muted); }
.metric-card:last-child .metric-value { color: var(--accent); }
.evidence-context { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 12px; padding: 12px 2px 22px; color: var(--muted); }
.overview-grid { display: grid; grid-template-columns: minmax(0,1.55fr) minmax(330px,1fr); gap: 18px; }
.activity-actions { display: flex; align-items: center; gap: 12px; }
.activity-actions button { font-size: 11px; padding: 5px 8px; }
.trend-layout { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 0 10px; margin-top: 14px; }
.trend-controls { margin: 12px 0; }
.trend-chooser { width: min(100%, 360px); }
.trend-chooser summary { cursor: pointer; padding: 10px 0; font-size: 12px; }
.trend-chooser .search-label { margin: 8px 0; }
.trend-options { display: grid; max-height: 264px; overflow: auto; }
.trend-option { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; cursor: pointer; overflow-wrap: anywhere; }
.trend-option:hover { background: var(--soft); }
.trend-option input { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--teal); }
.trend-swatch { width: 10px; height: 10px; flex-shrink: 0; border-radius: 2px; background: var(--skill-color); }
.trend-labels { display: flex; flex-wrap: wrap; gap: 10px 18px; min-width: 0; max-height: 192px; overflow: auto; margin-top: 16px; }
.trend-label { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; max-width: 100%; padding: 6px 8px; border: 0; border-left: 4px solid var(--skill-color); border-radius: 0; background: transparent; text-align: left; color: var(--ink); font-size: 12px; line-height: 1.3; }
.trend-label > span { overflow-wrap: anywhere; }
.trend-label:hover, .trend-label[aria-pressed=true] { background: var(--soft); }
.trend-label small { font-size: 11px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.trend-scale { position: relative; text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.trend-scale > span { position: absolute; right: 0; }
.trend-plot { position: relative; height: 240px; min-width: 0; touch-action: pan-y; user-select: none; cursor: crosshair; }
.activity-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.activity-svg .gridline { stroke: #e9ece6; stroke-width: 1; vector-effect: non-scaling-stroke; }
.trend-area { stroke: var(--paper, #fff); stroke-width: 0.6; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.trend-cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: #9eaaa580; pointer-events: none; }
.brush-shade { position: absolute; top: 0; bottom: 0; background: #f6f7f2b3; pointer-events: none; }
.brush-shade.before { left: 0; }.brush-shade.after { right: 0; }
.brush-band { position: absolute; top: 0; bottom: 0; padding: 0; border: 0; border-left: 1px solid #26726599; border-right: 1px solid #26726599; border-radius: 5px; background: #26726514; cursor: grab; }
.brush-band:hover { background: #26726520; }
.trend-plot[data-dragging=true], .trend-plot[data-dragging=true] * { cursor: grabbing; }
.trend-plot[data-pointer=true]:focus { outline: none; }
.brush-handle { position: absolute; top: calc(50% - 22px); height: 44px; width: 24px; padding: 0; border: 0; border-radius: 0; background: transparent; transform: translateX(-50%); cursor: ew-resize; touch-action: pan-y; }
.brush-handle::after { content: ''; position: absolute; top: calc(50% - 15px); left: 8px; width: 8px; height: 30px; border: 2px solid white; border-radius: 6px; background: var(--teal); box-shadow: 0 1px 4px #233d3220; }
.brush-handle:hover { background: #2672650c; }
.chart-axis { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--muted); grid-column: 2; padding-top: 10px; }
.trend-readout, .brush-range { font-size: 11px; color: var(--muted); min-height: 1.5em; margin-top: 12px; font-variant-numeric: tabular-nums; }
.brush-range { color: var(--teal); margin-top: 4px; }
.activity-data { min-width: 640px; }
.activity-choice[aria-pressed=true] { background: var(--soft); }
details { margin-top: 15px; }
summary { color: var(--muted); font-size: 12px; font-weight: 600; }
details[open] > summary { margin-bottom: 15px; }
.search-label { max-width: 360px; margin-bottom: 12px; }
.rank-row { display: grid; grid-template-columns: 22px minmax(0,1fr) 38px; align-items: center; gap: 10px; padding: 8px 0; }
.rank-number { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.rank-row button { display: block; font-size: 12px; }
.rank-row strong { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.rank-row.selected { background: var(--soft); margin: 0 -9px; padding: 8px 9px; border-radius: 5px; }
.rank-track { background: #f0f3ee; height: 4px; margin-top: 7px; border-radius: 2px; }
.rank-fill { height: 100%; background: #73a294; border-radius: 2px; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; padding-top: 14px; }
.pagination-actions { display: flex; gap: 5px; }
.pagination button { padding: 4px 8px; font-size: 11px; }
.explorer-panel { border-color: #accbbd; }
.explorer-panel > .section-heading { align-items: start; }
.explorer-panel > .section-heading h2 { font-size: 22px; margin-top: 2px; }
.explorer-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.explore-chips, .explore-totals { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.explore-chips { margin: 12px 0 8px; }
#explore-rule { margin-bottom: 18px; }
.explore-chip { border: 1px solid #a8c8b8; border-radius: 20px; background: var(--soft); color: var(--ink); padding: 5px 11px; font-size: 12px; }
.explore-chip:hover { background: #dfebe3; }
.explore-totals { gap: 10px 26px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.explore-total strong { font-size: 22px; font-variant-numeric: tabular-nums; margin-right: 5px; }
.explore-total span { color: var(--muted); font-size: 12px; }
.explore-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, 1fr); gap: 24px; padding-top: 18px; }
.explore-layout > section, .explore-side { min-width: 0; }
.explore-side { display: grid; gap: 20px; align-content: start; }
.explore-side > section { min-width: 0; }
.explore-layout .section-heading { margin-bottom: 10px; }
.explore-model { display: flex; width: 100%; justify-content: space-between; align-items: baseline; gap: 10px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 9px 2px; background: transparent; text-align: left; color: var(--ink); }
.explore-model:hover { background: var(--soft); }
.explore-model > span { overflow-wrap: anywhere; min-width: 0; }
.explore-model strong, .explore-model small { display: block; text-align: right; white-space: nowrap; }
.explore-model strong { font-size: 12px; }
.explore-model small { color: var(--muted); font-size: 11px; }
.compare-summary { display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 12px 0; font-size: 12px; }
.compare-summary strong { display: block; font-size: 19px; font-variant-numeric: tabular-nums; color: var(--ink); }
.compare-row { display: grid; grid-template-columns: minmax(110px,1fr) 100px 100px; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid var(--line); font-size: 12px; }
.compare-row > span { text-align: right; font-variant-numeric: tabular-nums; }
.compare-row .compare-value small { display: block; font-size: 10px; color: var(--muted); }
.compare-row .link { font-size: 12px; }
.compare-row.selected { background: var(--soft); }
.explore-path { display: block; width: 100%; padding: 9px 2px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--ink); text-align: left; font-weight: 400; }
.explore-path:hover { background: var(--soft); }
.explore-path strong { display: block; font-size: 12px; }
.explore-path span { display: block; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.explore-layout .footnote { margin-top: 10px; }
.relationship-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.relationship { background: #f7f9f5; border: 1px solid #e2e8df; border-radius: 7px; padding: 15px; }
.relationship-flow { display: flex; align-items: center; gap: 10px; margin: 10px 0 12px; }
.skill-cluster { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
.skill-node { background: #fff; border: 1px solid #d8e1d7; border-radius: 5px; padding: 5px 8px; color: #38544b; font-size: 12px; overflow-wrap: anywhere; }
.flow-arrow { color: var(--teal); flex-shrink: 0; }
.relationship button { font-size: 11px; }
.table-wrap { overflow-x: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
caption { text-align: left; color: var(--muted); padding-bottom: 12px; }
th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; overflow-wrap: anywhere; }
th { font-size: 11px; color: var(--muted); font-weight: 600; }
.matrix { table-layout: fixed; min-width: 620px; }
.matrix th:first-child { width: 210px; position: sticky; left: 0; z-index: 1; background: var(--panel); }
.matrix-scroll-hint { display: none; }
.matrix td { text-align: center; font-variant-numeric: tabular-nums; padding: 5px; }
.matrix td button { width: 100%; min-height: 37px; border: 0; color: #284c43; font-weight: 600; }
.matrix .heat-0 { background: #f5f6f2; color: #737b72; font-weight: 400; }
.matrix .heat-1 { background: #e5eee6; }.matrix .heat-2 { background: #cadfce; }.matrix .heat-3 { background: #99c2ac; }.matrix .heat-4 { background: #477f6b; color: white; }
.model-provider { display: block; font-weight: 400; font-size: 10px; }
.detail-counts { display: flex; flex-wrap: wrap; gap: 12px 24px; padding: 15px 0; font-size: 12px; }
.identity-list { display: grid; gap: 10px; margin-top: 12px; }
.identity-item { padding: 12px; background: #f7f8f4; border-radius: 5px; overflow-wrap: anywhere; }
.identity-item p { font-size: 12px; }
.path-toolbar { display: flex; align-items: center; gap: 18px; padding: 15px 18px; }
.path-toolbar > div:first-child { margin-right: auto; min-width: 0; }
.path-toolbar .search-label { margin-bottom: 0; max-width: 210px; }
.path-toolbar select { max-width: 210px; }
.path-layout { display: grid; grid-template-columns: 310px minmax(0,1fr); gap: 18px; align-items: start; }
.route-master { padding: 18px 14px; }
.route-choice { display: block; text-align: left; width: 100%; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--ink); padding: 12px 10px; margin-bottom: 4px; font-weight: 400; }
.route-choice[aria-pressed=true] { background: #edf3ed; border-color: #b8cdbb; }
.route-choice strong { font-size: 13px; display: block; }
.route-choice p { font-size: 11px; margin-top: 4px; }
.route-choice .route-preview { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--teal); }
.route-detail { min-height: 410px; }
.route-scope { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: 100px minmax(0,1fr); gap: 5px 14px; font-size: 12px; }
dt { color: var(--muted); }dd { margin: 0; overflow-wrap: anywhere; }
.timeline { list-style: none; padding: 0; margin: 24px 0 0; }
.timeline-step { position: relative; padding: 0 0 22px 28px; margin-left: 8px; border-left: 1px solid #cdd8cc; }
.timeline-step:last-child { border-left-color: transparent; }
.timeline-step::before { content: ''; position: absolute; width: 9px; height: 9px; background: #729783; border: 3px solid white; box-sizing: content-box; border-radius: 50%; left: -8px; top: 2px; }
.step-heading { display: flex; gap: 12px; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 9px; }
.step-group { display: flex; flex-wrap: wrap; gap: 7px; }
.observation { background: #f2f6ef; border: 1px solid #dfe7d9; border-radius: 6px; padding: 9px 12px; min-width: 0; max-width: 100%; }
.observation strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
.observation p { font-size: 11px; overflow-wrap: anywhere; }
.observation.request { background: #f2f1f8; border-color: #e1deed; }
.observation.wrapper { background: #f9f3e8; border-color: #eae0cc; }
.observation.failure { background: #fbefeb; border-color: #e9d4cb; }
.timeline-step.gap { border-left: 1px dashed #b8b4a6; }
.timeline-step.gap::before { background: #b9ad8b; }
.gap-card { padding: 12px; background: #f7f5ee; border: 1px dashed #c9c0aa; border-radius: 6px; font-size: 12px; }
.timeline-step.supporting .step-group { outline: 2px solid #b66b39; outline-offset: 5px; border-radius: 3px; }
.observation.matching { outline: 2px solid var(--teal); outline-offset: 2px; }
.support-note { color: #985020; font-size: 11px; }
.data-definitions { display: grid; gap: 10px; font-size: 12px; }
.empty { padding: 30px 4px; color: var(--muted); }
.message { margin-top: 18px; border-left: 3px solid var(--accent); }
.message p { margin: 8px 0 16px; }
.sr-only, .skip-link:not(:focus) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip-link:focus { display: block; padding: 12px; color: var(--teal); }
@media (min-width: 1600px) { .shell { width: min(1440px,90%); } }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr 1fr; }.path-toolbar { flex-wrap: wrap; }.path-toolbar > div:first-child { width: 100%; }.path-layout { grid-template-columns: 260px minmax(0,1fr); }.filter-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }.metric-card { padding: 20px; } }
@media (max-width: 760px) {
  .explore-layout { grid-template-columns: 1fr; gap: 20px; }
  .compare-row { grid-template-columns: minmax(0,1fr) 68px 68px; }
  .shell { width: calc(100% - 28px); }.app-header { padding: 12px 14px; }.identity { gap: 9px; }.identity-note { display: none; }.header-actions { gap: 8px; }.preview { font-size: 9px; }.workspace-nav { gap: 24px; }.scope-bar { align-items: start; flex-direction: column; gap: 10px; }.scope-actions { width: 100%; }.scope-actions .inline-label { margin-right: auto; }.page-heading { align-items: start; gap: 12px; }.page-heading p { font-size: 12px; }.panel { padding: 17px; }.metrics-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.metric-card { padding: 17px; }.metric-card:nth-child(2) { border-right: 0; }.metric-card:nth-child(-n+2) { border-bottom: 1px solid var(--line); }.metric-value { font-size: 31px; }.overview-grid, .relationship-grid, .path-layout { grid-template-columns: 1fr; }.filter-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.trend-plot { height: 200px; }.section-heading { align-items: start; flex-wrap: wrap; }.section-heading > button { font-size: 11px; }.path-toolbar { gap: 12px; }.path-toolbar .search-label { max-width: none; flex: 1; min-width: 140px; }.path-toolbar .inline-label { max-width: 100%; }.path-toolbar select { max-width: 160px; }.route-master { margin-bottom: 0; }.route-detail { min-height: 0; }.step-heading { flex-wrap: wrap; gap: 4px; }.relationship-flow { gap: 6px; }.skill-node { font-size: 11px; }
}
@media (max-width: 760px) {
  .matrix th:first-child { width: 150px; }
  .matrix-scroll-hint { display: block; }
  #route-list { max-height: 320px; overflow-y: auto; }
}
@media (prefers-reduced-motion: no-preference) { button { transition: background-color .12s; } }
`;

export const dashboardJs = String.raw`'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  requestId: 0, controller: null, report: null, workspace: 'overview',
  focus: { kind: 'all' }, routeKey: null, skillSelection: null,
  explore: { skillName: null, interval: null },
  trends: { kind: 'top', count: 5 },
  pages: { activity: 0, skills: 0, models: 0, columns: 0, relationships: 0, routes: 0, steps: 0, catalog: 0, identities: 0, evidence: 0 },
};
let activityView = null;
const skillColors = new Map();
const number = (value) => value.toLocaleString('en-US');
const count = (value, singular, plural = singular + 's') => number(value) + ' ' + (value === 1 ? singular : plural);
const sessionLabels = { host: 'Agent host', machineId: 'Machine', sourceId: 'Account source', projectCwd: 'Project', sessionId: 'Session ID', segmentId: 'Segment ID', runId: 'Run ID' };
const gapLabels = { 'queue-overflow': 'Capture queue full', 'db-busy': 'Database busy', 'db-error': 'Database error', 'shutdown-deadline': 'Capture stopped before saving', 'invalid-observation': 'Invalid record' };
const wrapperLabels = { 'expanded-prompt': 'input after expansion', 'unknown-pasted-or-transformed': 'source unknown' };
const stepLabels = { 'read-attempt': 'Read attempt', 'skill-invocation': 'Native skill invocation', 'read-result': 'Read group', 'command-intent': 'Request', 'wrapper-observed': 'Wrapper' };
const commandLabels = { interactive: 'Interactive', rpc: 'RPC', extension: 'Extension' };
class DashboardFetchError extends Error {}
const pageLabels = { models: 'skill rows', columns: 'model columns' };
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function button(text, action, className = 'quiet') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function empty(text) { return node('p', text, 'empty'); }
function date(value, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'No usable timestamp';
  return new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : {}) }).format(new Date(value));
}
function project(path) { return path.split('/').filter(Boolean).at(-1) || path; }
function modelLabel(model) { return model ? model.provider + ' / ' + model.id : 'Unknown model'; }
function sameModel(left, right) { return left === null ? right === null : right !== null && left.provider === right.provider && left.id === right.id; }
function countsText(counts) { return [count(counts.successfulReads, 'read'), count(counts.failedReads, 'failure'), count(counts.requests, 'request'), count(counts.wrappers, 'wrapper'), ...(counts.readAttempts ? [count(counts.readAttempts, 'read attempt')] : []), ...(counts.invocations ? [count(counts.invocations, 'native invocation')] : [])].join(' · '); }
function hasFilters() { return Object.values(state.report.scope).some((value) => value !== undefined && value !== null && value !== ''); }
function noResults(subject, search = '') { return search ? 'No ' + subject + ' match this search.' : hasFilters() ? 'No ' + subject + ' match these filters.' : 'No ' + subject + ' recorded yet.'; }
function totalEvidence(counts) { return counts.successfulReads + counts.failedReads + counts.requests + counts.wrappers + (counts.readAttempts || 0) + (counts.invocations || 0); }
function disclosure(title, content) { const details = node('details'); details.append(node('summary', title), content); return details; }
function table(headers, caption) {
  const result = node('table');
  if (caption) result.append(node('caption', caption));
  const head = node('thead'); const row = node('tr');
  headers.forEach((text) => { const cell = node('th', text); cell.scope = 'col'; row.append(cell); });
  head.append(row); result.append(head, node('tbody')); return result;
}
function pagination(key, total, size, render) {
  const pages = Math.max(1, Math.ceil(total / size));
  state.pages[key] = Math.min(state.pages[key], pages - 1);
  const wrap = node('div', null, 'pagination');
  if (!total) { wrap.hidden = true; return wrap; }
  const first = state.pages[key] * size + 1;
  wrap.append(node('span', first + '–' + Math.min(total, (state.pages[key] + 1) * size) + ' of ' + number(total)));
  if (pages > 1) {
    const controls = node('div', null, 'pagination-actions');
    const previous = button('Previous', () => { state.pages[key]--; render(); restorePagerFocus(key, 'Previous'); });
    const next = button('Next', () => { state.pages[key]++; render(); restorePagerFocus(key, 'Next'); });
    previous.disabled = state.pages[key] === 0; next.disabled = state.pages[key] === pages - 1;
    previous.setAttribute('aria-label', 'Previous ' + (pageLabels[key] || key)); next.setAttribute('aria-label', 'Next ' + (pageLabels[key] || key));
    controls.append(previous, next); wrap.append(controls);
  }
  return wrap;
}
function restorePagerFocus(key, direction) {
  const label = pageLabels[key] || key;
  const target = document.querySelector('[aria-label="' + direction + ' ' + label + '"]:not(:disabled)') || document.querySelector('[aria-label$=" ' + label + '"]:not(:disabled)');
  target?.focus();
}
function pageItems(items, key, size) { state.pages[key] = Math.min(state.pages[key], Math.max(0, Math.ceil(items.length / size) - 1)); return items.slice(state.pages[key] * size, (state.pages[key] + 1) * size); }
function setOptions(select, label, options) {
  const current = select.value;
  const all = node('option', label); all.value = '';
  select.replaceChildren(all);
  for (const option of options) { const item = node('option', option.label); item.value = option.value; select.append(item); }
  select.value = options.some((option) => option.value === current) ? current : '';
}
function showWorkspace(name, focusHeading = false) {
  state.workspace = name;
  for (const workspace of ['overview', 'models', 'paths']) $(workspace + '-workspace').hidden = workspace !== name;
  document.querySelectorAll('[data-workspace]').forEach((item) => {
    if (item.dataset.workspace === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  if (focusHeading) { const heading = $(name === 'paths' ? 'paths-heading' : name + '-heading'); heading.tabIndex = -1; heading.focus(); }
}
function setStatus(kind, text) { $('status-text').dataset.kind = kind; $('status-text').textContent = text; }
function showMessage(title, text, retry = false) {
  $('message-panel').hidden = false;
  $('message-panel').replaceChildren(node('h2', title));
  if (text) $('message-panel').append(node('p', text));
  if (retry) $('message-panel').append(button('Retry', loadDashboard));
}
function filterParams() {
  const params = new URLSearchParams();
  for (const item of $('filter-form').elements) {
    if (!item.name || !item.value) continue;
    params.set(item.name, item.type === 'datetime-local' ? new Date(item.value + 'Z').toISOString() : item.value);
  }
  return params;
}
function resetSelections() {
  state.focus = { kind: 'all' }; state.routeKey = null; state.skillSelection = null;
  state.explore = { skillName: null, interval: null };
  for (const key of Object.keys(state.pages)) state.pages[key] = 0;
  for (const id of ['skill-search', 'model-search', 'route-search', 'catalog-search', 'route-model']) $(id).value = '';
}
function applyTimePreset() {
  const preset = $('time-preset').value;
  if (preset === 'custom') return;
  if (preset === 'all') { $('from-filter').value = ''; $('to-filter').value = ''; return; }
  const now = Date.now();
  $('to-filter').value = new Date(now).toISOString().slice(0, -1);
  $('from-filter').value = new Date(now - Number(preset) * 86400000).toISOString().slice(0, -1);
}
async function loadDashboard() {
  applyTimePreset();
  const requestId = ++state.requestId;
  state.controller?.abort(); state.controller = new AbortController();
  state.report = null;
  $('scope-summary').hidden = true; $('scope-summary').textContent = '';
  $('dashboard-content').hidden = true; $('workspace').setAttribute('aria-busy', 'true');
  setStatus('loading', 'Loading');
  showMessage('Loading activity…');
  try {
    const response = await fetch('/api/dashboard?' + filterParams(), { signal: state.controller.signal, headers: { Accept: 'application/json' } }).catch((error) => {
      if (error instanceof TypeError && ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'].includes(error.message)) throw new DashboardFetchError(error.message);
      throw error;
    });
    if (!response.ok) throw new Error('Dashboard request failed (HTTP ' + response.status + ').');
    const payload = await response.json();
    if (requestId !== state.requestId) return;
    if (!['ready', 'missing', 'error'].includes(payload.kind)) throw new Error('Unexpected dashboard response.');
    renderFilterOptions(payload.filterOptions);
    if (payload.kind === 'missing') {
      setStatus('missing', 'No database'); showMessage('No Hotplate database found', 'Check the database location and capture or collector configuration. Then refresh the dashboard.', true);
      $('message-panel').append(disclosure('Database location', node('p', payload.databasePath))); return;
    }
    if (payload.kind === 'error') throw new Error(payload.message);
    if (!payload.report || !Array.isArray(payload.report.skillGroups) || !Array.isArray(payload.report.routes)) throw new Error('The dashboard report is unavailable.');
    state.report = payload.report;
    resetSelections();
    renderScope(); renderOverview(); renderModels(); renderPaths();
    $('message-panel').hidden = true; $('dashboard-content').hidden = false;
    setStatus('ready', 'Ready');
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.report = null; $('dashboard-content').hidden = true;
    $('scope-summary').hidden = true;
    setStatus('error', 'Error'); showMessage('Cannot load dashboard', error instanceof DashboardFetchError ? 'Could not reach the dashboard server.' : undefined, true);
    $('message-panel').append(disclosure('Error details', node('p', error instanceof Error ? error.message : String(error))));
  } finally {
    if (requestId === state.requestId) $('workspace').setAttribute('aria-busy', 'false');
  }
}
function renderFilterOptions(options) {
  if (!options) return;
  for (const [id, label, values] of [
    ['host-filter', 'All agent hosts', options.hosts || []],
    ['machine-filter', 'All machines', options.machines], ['project-filter', 'All projects', options.projects],
    ['model-provider-filter', 'All providers', options.modelProviders], ['model-id-filter', 'All models', options.modelIds],
  ]) setOptions($(id), label, values.map((value) => ({ value, label: value })));
}
function renderScope() {
  const scope = state.report.scope;
  const parts = [];
  if (scope.fromObservedAt || scope.toObservedAt) parts.push((scope.fromObservedAt || 'First record') + ' to ' + (scope.toObservedAt || 'Latest record') + ' · UTC');
  if (scope.projectCwd) parts.push('Project: ' + scope.projectCwd);
  if (scope.host) parts.push('Agent host: ' + scope.host);
  if (scope.machineId) parts.push('Machine: ' + scope.machineId);
  if (scope.source) parts.push((commandLabels[scope.source] || scope.source) + ' requests');
  if (scope.modelProvider) parts.push('Model provider: ' + scope.modelProvider);
  if (scope.modelId) parts.push('Model: ' + scope.modelId);
  $('scope-summary').textContent = parts.join(' · ');
  $('scope-summary').hidden = parts.length === 0;
}
function renderOverview() {
  const report = state.report;
  const metrics = [
    ['Successful reads', report.counts.successfulReads],
    ['Skill names read', report.skillsRead],
    ['Session paths', report.routes.length, 'Known runs and unassigned events'],
    ['Read failures', report.counts.failedReads],
  ];
  $('overview-cards').replaceChildren(...metrics.map(([label, value, note]) => {
    const card = node('article', null, 'metric-card'); card.append(node('span', label, 'metric-label'), node('strong', number(value), 'metric-value'));
    if (note) card.append(node('span', note, 'metric-note')); return card;
  }));
  $('evidence-context').replaceChildren();
  if (report.counts.readAttempts) $('evidence-context').append(node('span', count(report.counts.readAttempts, 'read attempt') + ' · outcome unknown'));
  if (report.counts.invocations) $('evidence-context').append(node('span', count(report.counts.invocations, 'native skill invocation')));
  for (const [label, value] of [['request', report.counts.requests], ['wrapper', report.counts.wrappers]]) $('evidence-context').append(node('span', count(value, label)));
  renderActivity(); renderExplore(); renderRelationships(); renderCatalog();
  const coverage = report.coverage;
  $('evidence-context').append(node('span', count(coverage.captureGaps, 'capture gap') + ' · ' + count(coverage.droppedObservations, 'record') + ' lost · ' + count(coverage.filteredOmissions, 'record') + ' hidden by filters'));
}
function svgNode(tag, attrs) { const item = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value)); return item; }
function mountTimeBrush(plot, activity, readout, onChange, onInspect) {
  const stepMs = Math.min(activity.binWidthMs, 86400000); const start = Date.parse(activity.startAt);
  const steps = (Date.parse(activity.endAt) - start) / stepMs;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const at = (step) => new Date(start + step * stepMs).toISOString();
  const interval = (from, to) => ({ startAt: at(from), endAt: at(to) });
  const position = (event) => { const box = plot.getBoundingClientRect(); return clamp((event.clientX - box.left) / box.width * steps, 0, steps); };
  const before = node('div', null, 'brush-shade before'); const after = node('div', null, 'brush-shade after');
  const band = node('button', null, 'brush-band'); band.type = 'button'; band.dataset.mode = 'move';
  const handles = ['start', 'end'].map((mode) => {
    const handle = node('button', null, 'brush-handle'); handle.type = 'button'; handle.dataset.mode = mode;
    handle.setAttribute('role', 'slider'); handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', mode === 'start' ? 'Selection start time' : 'Selection end time (exclusive)');
    return handle;
  });
  plot.append(before, after, band, ...handles);
  plot.tabIndex = 0; plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', 'Skill trends. Drag to select dates. Arrow keys inspect intervals. Enter selects. Shift extends. Escape clears.');
  let selected = null; let gesture = null; let inspected = activity.bins.length - 1;
  function paint(range, preview = false) {
    for (const element of [before, after, band, ...handles]) element.hidden = range === null;
    plot.dataset.dragging = String(preview);
    if (range === null) { readout.textContent = 'Drag across the chart to explore dates.'; return; }
    const [from, to] = range;
    before.style.width = from / steps * 100 + '%'; after.style.width = (steps - to) / steps * 100 + '%';
    band.style.left = from / steps * 100 + '%'; band.style.width = (to - from) / steps * 100 + '%';
    handles[0].style.left = from / steps * 100 + '%'; handles[1].style.left = to / steps * 100 + '%';
    const first = preview ? clamp(Math.floor(from), 0, steps - 1) : from; const last = preview ? clamp(Math.ceil(to), first + 1, steps) : to;
    const label = intervalLabel(at(first), at(last)) + ' UTC';
    band.setAttribute('aria-label', 'Move ' + label + '. Use Left or Right arrow keys.');
    readout.textContent = label + (preview ? ' · release to select' : ' · drag the band to move it');
    const minimumWidth = Math.min(1, last - first);
    for (const [index, handle] of handles.entries()) {
      handle.setAttribute('aria-valuemin', String(index === 0 ? 0 : first + minimumWidth));
      handle.setAttribute('aria-valuemax', String(index === 0 ? last - minimumWidth : steps));
      handle.setAttribute('aria-valuenow', String(index === 0 ? first : last));
      handle.setAttribute('aria-valuetext', timeLabel(at(index === 0 ? first : last)) + ' UTC' + (index === 1 ? ' (exclusive)' : ''));
    }
  }
  function preview(step) {
    const { mode, anchor, range } = gesture;
    if (mode === 'create') return [Math.min(anchor, step), Math.max(anchor, step)];
    const [from, to] = range;
    const minimumWidth = Math.min(1, to - from);
    if (mode === 'start') return [clamp(from + (step - anchor), 0, to - minimumWidth), to];
    if (mode === 'end') return [from, clamp(to + (step - anchor), from + minimumWidth, steps)];
    const next = clamp(from + (step - anchor), 0, steps - (to - from));
    return [next, next + to - from];
  }
  function cancel() {
    if (gesture === null) return;
    const pointer = gesture.pointer; gesture = null;
    if (plot.hasPointerCapture(pointer)) plot.releasePointerCapture(pointer);
    paint(selected);
  }
  plot.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || gesture !== null) return;
    const anchor = position(event); let mode = event.target.dataset.mode || 'create';
    if (selected && (mode === 'start' || mode === 'end')) mode = Math.abs(anchor - selected[0]) < Math.abs(anchor - selected[1]) ? 'start' : 'end';
    gesture = { mode, anchor, range: selected, pointer: event.pointerId };
    plot.dataset.pointer = 'true'; plot.setPointerCapture(event.pointerId); plot.focus({ preventScroll: true });
    paint(mode === 'create' ? [anchor, anchor] : selected, true);
  });
  plot.addEventListener('pointermove', (event) => {
    if (gesture !== null && event.pointerId !== gesture.pointer) return;
    const step = position(event);
    inspected = Math.min(activity.bins.length - 1, Math.floor(step * stepMs / activity.binWidthMs)); onInspect(inspected);
    if (gesture !== null) paint(preview(step), true);
  });
  plot.addEventListener('pointerup', (event) => {
    if (gesture === null || event.pointerId !== gesture.pointer) return;
    const step = position(event); const movement = Math.round(step - gesture.anchor);
    const range = preview(step).map((value) => Math.round(value * stepMs) / stepMs); const mode = gesture.mode;
    gesture = null;
    if (plot.hasPointerCapture(event.pointerId)) plot.releasePointerCapture(event.pointerId);
    let from; let to;
    if (mode === 'move') {
      const width = selected[1] - selected[0];
      from = clamp(selected[0] + movement, 0, steps - width); to = from + width;
    }
    else { from = clamp(Math.floor(range[0]), 0, steps - 1); to = clamp(Math.ceil(range[1]), from + 1, steps); }
    onChange(interval(from, to), event.shiftKey && mode === 'create');
  });
  plot.addEventListener('pointercancel', cancel); plot.addEventListener('lostpointercapture', cancel);
  plot.addEventListener('blur', () => { delete plot.dataset.pointer; });
  plot.addEventListener('keydown', (event) => {
    delete plot.dataset.pointer;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (gesture !== null) cancel();
      else { onChange(null); plot.focus({ preventScroll: true }); }
      return;
    }
    if (gesture !== null) return;
    const mode = event.target.dataset.mode;
    if (mode && selected && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      let [from, to] = selected; const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1);
      const minimumWidth = Math.min(1, to - from);
      if (mode === 'start') from = event.key === 'Home' ? 0 : event.key === 'End' ? to - minimumWidth : clamp(from + delta, 0, to - minimumWidth);
      else if (mode === 'end') to = event.key === 'Home' ? from + minimumWidth : event.key === 'End' ? steps : clamp(to + delta, from + minimumWidth, steps);
      else {
        const width = to - from;
        from = event.key === 'Home' ? 0 : event.key === 'End' ? steps - width : clamp(from + delta, 0, steps - width); to = from + width;
      }
      onChange(interval(from, to)); return;
    }
    if (event.target !== plot) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      inspected = event.key === 'Home' ? 0 : event.key === 'End' ? activity.bins.length - 1 : clamp(inspected + (event.key === 'ArrowLeft' ? -1 : 1), 0, activity.bins.length - 1);
      onInspect(inspected, true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); const bin = activity.bins[inspected]; onChange({ startAt: bin.startAt, endAt: bin.endAt }, event.shiftKey);
    }
  });
  return (value) => {
    selected = value === null ? null : [(Date.parse(value.startAt) - start) / stepMs, (Date.parse(value.endAt) - start) / stepMs];
    paint(selected);
  };
}
function availableTrendNames() {
  const activity = state.report.activity;
  const dated = new Set(activity.kind === 'bucketed' ? activity.bins.flatMap(bin => bin.skills.map(entry => entry.name)) : []);
  return state.report.skillGroups.filter(group => dated.has(group.name)).map(group => group.name);
}
function displayedTrendNames() {
  return state.trends.kind === 'top' ? availableTrendNames().slice(0, state.trends.count) : state.trends.names;
}
function addTrend(name) {
  const names = displayedTrendNames();
  if (!names.includes(name)) state.trends = { kind: 'custom', names: [...names, name] };
}
function skillColor(name) {
  if (!skillColors.has(name)) {
    const palette = ['#267265', '#477aaf', '#c98332', '#9c5fa2', '#cf6260', '#80983b', '#4ca4ad', '#bd6d99', '#806342', '#6977c0', '#c4aa47', '#738b83'];
    const index = skillColors.size;
    skillColors.set(name, palette[index] || 'hsl(' + ((index * 137.508) % 360).toFixed(3) + ' 52% ' + (42 + index % 3 * 9) + '%)');
  }
  return skillColors.get(name);
}
function buildStack(activity, names) {
  const counts = activity.bins.map(bin => new Map(bin.skills.map(skill => [skill.name, skill.successfulReads])));
  let totals = activity.bins.map(() => 0);
  const layers = names.map(name => {
    const lower = totals;
    const values = counts.map(bin => bin.get(name) || 0);
    const upper = lower.map((value, index) => value + values[index]);
    totals = upper;
    return { name, values, lower, upper };
  });
  return { layers, maximum: Math.max(1, ...totals) };
}
function mountTrendControls(target) {
  const controls = node('div', null, 'trend-controls');
  const catalog = [...new Set([...state.report.skillGroups.map(group => group.name), ...displayedTrendNames()])].sort((a, b) => a.localeCompare(b));
  catalog.forEach(skillColor);
  controls.hidden = catalog.length === 0;
  const chooser = node('details', null, 'trend-chooser');
  const summary = node('summary');
  const searchLabel = node('label', 'Find a skill', 'search-label');
  const search = node('input'); search.type = 'search'; search.placeholder = 'Search skill names'; searchLabel.append(search);
  const results = node('div', null, 'trend-options');
  const status = node('p', null, 'sr-only'); status.setAttribute('role', 'status');
  let limit = 20;
  function choices() {
    const names = displayedTrendNames();
    const candidates = catalog.filter(name => name.toLowerCase().includes(search.value.toLowerCase()));
    results.replaceChildren();
    for (const name of candidates.slice(0, limit)) {
      const label = node('label', null, 'trend-option');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.skill = name; checkbox.checked = names.includes(name);
      const swatch = node('span', null, 'trend-swatch'); swatch.style.setProperty('--skill-color', skillColor(name));
      checkbox.addEventListener('change', () => {
        const current = displayedTrendNames();
        state.trends = { kind: 'custom', names: checkbox.checked ? [...new Set([...current, name])] : current.filter(value => value !== name) };
        updateActivitySelection();
        status.textContent = name + (checkbox.checked ? ' added to chart.' : ' removed from chart.');
      });
      label.append(checkbox, swatch, node('span', name)); results.append(label);
    }
    if (!candidates.length) results.append(empty('No skills match this search.'));
    if (candidates.length > limit) results.append(button('More results', () => {
      const firstNew = limit; limit += 20; choices();
      results.querySelectorAll('input')[firstNew]?.focus({ preventScroll: true });
    }));
  }
  search.addEventListener('input', () => { limit = 20; choices(); });
  chooser.append(summary, searchLabel, results, status);
  chooser.addEventListener('toggle', () => { if (chooser.open) { choices(); search.focus({ preventScroll: true }); } });
  chooser.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); chooser.open = false; summary.focus({ preventScroll: true }); } });
  controls.append(chooser); target.append(controls);
  return () => {
    const names = displayedTrendNames();
    summary.textContent = 'Skills (' + names.length + ')';
    results.querySelectorAll('input').forEach(checkbox => { checkbox.checked = names.includes(checkbox.dataset.skill); });
  };
}
function renderActivity() {
  const target = $('activity-chart'); target.replaceChildren(); activityView = null;
  const report = state.report; const activity = report.activity;
  const updateControls = mountTrendControls(target); updateControls();
  if (activity.kind === 'empty') {
    activityView = updateControls;
    target.append(empty(hasFilters() ? 'No dated activity matches these filters.' : totalEvidence(report.counts) === 0 && report.routes.length === 0 ? 'No activity recorded yet.' : 'No dated activity recorded.'));
  }
  else {
    const binSkills = activity.bins.map((bin) => new Map(bin.skills.map((entry) => [entry.name, entry.successfulReads])));
    const layout = node('div', null, 'trend-layout'); const labels = node('div', null, 'trend-labels');
    const plot = node('div', null, 'trend-plot');
    const svg = svgNode('svg', { role: 'img', 'aria-labelledby': 'activity-title activity-description', class: 'activity-svg', preserveAspectRatio: 'none' });
    const cursor = node('div', null, 'trend-cursor');
    plot.append(svg, cursor);
    const axis = node('div', null, 'chart-axis'); axis.append(node('span', date(activity.startAt, activity.binWidthMs < 86400000)), node('span', date(activity.binWidthMs < 86400000 ? activity.endAt : new Date(Date.parse(activity.endAt) - 1).toISOString(), activity.binWidthMs < 86400000)));
    const scale = node('div', null, 'trend-scale');
    layout.append(scale, plot, axis);
    const noTrends = empty('Select skills to show their reads.'); target.append(noTrends);
    const readout = node('p', null, 'trend-readout'); const rangeReadout = node('p', null, 'brush-range');
    const announcement = node('p', null, 'sr-only'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
    const explanation = node('p', 'Successful skill reads · Reads per interval', 'small muted');
    const noReads = node('p', 'No successful reads in this period.', 'footnote');
    target.append(explanation, layout, noReads, labels, readout, rangeReadout, announcement);
    const scroll = node('div', null, 'table-wrap'); const details = disclosure('View activity data', scroll); target.append(details);
    let shown = []; let inspected = activity.bins.length - 1;
    function inspect(index, announce = false) {
      inspected = index; const bin = activity.bins[index];
      cursor.style.left = ((Date.parse(bin.startAt) + Date.parse(bin.endAt)) / 2 - Date.parse(activity.startAt)) / (Date.parse(activity.endAt) - Date.parse(activity.startAt)) * 100 + '%';
      readout.textContent = intervalLabel(bin.startAt, bin.endAt) + ' · ' + count(shown.reduce((total, name) => total + (binSkills[index].get(name) || 0), 0), 'selected skill read');
      labels.querySelectorAll('.trend-label').forEach((label, row) => {
        const reads = binSkills[index].get(shown[row]) || 0;
        label.querySelector('small').textContent = count(reads, 'read');
        label.title = shown[row] + ': ' + count(reads, 'read') + ' · ' + intervalLabel(bin.startAt, bin.endAt);
      });
      if (announce) announcement.textContent = readout.textContent + '. ' + Array.from(labels.querySelectorAll('.trend-label'), (label) => label.title).join('. ');
    }
    function renderData() {
      const data = table(['UTC interval', 'Read-bearing runs', ...shown, 'Reads', 'Failures', 'Requests', 'Wrappers'], 'Successful reads by skill. Repeated successful reads count separately.'); data.className = 'activity-data';
      pageItems(activity.bins, 'activity', 24).forEach((bin, offset) => {
        const index = state.pages.activity * 24 + offset;
        const row = node('tr'); const cell = node('td');
        const action = button(intervalLabel(bin.startAt, bin.endAt), (event) => selectActivityBin(index, event.shiftKey), 'link activity-choice');
        action.dataset.bin = index; action.setAttribute('aria-pressed', String(state.explore.interval !== null && bin.startAt >= state.explore.interval.startAt && bin.endAt <= state.explore.interval.endAt));
        action.setAttribute('aria-label', 'Select ' + intervalLabel(bin.startAt, bin.endAt) + ' UTC'); cell.append(action); row.append(cell, node('td', bin.readRuns));
        for (const name of shown) {
          row.append(node('td', binSkills[index].get(name) || 0));
        }
        [bin.counts.successfulReads, bin.counts.failedReads, bin.counts.requests, bin.counts.wrappers].forEach((value) => row.append(node('td', value)));
        data.lastChild.append(row);
      });
      scroll.replaceChildren(data, pagination('activity', activity.bins.length, 24, renderData));
    }
    details.addEventListener('toggle', () => { if (details.open) renderData(); });
    const setRange = mountTimeBrush(plot, activity, rangeReadout, selectExploreInterval, inspect);
    activityView = (selection) => {
      updateControls();
      const names = displayedTrendNames();
      noTrends.hidden = names.length > 0;
      noReads.hidden = names.length === 0 || activity.bins.some((bin, index) => names.some(name => (binSkills[index].get(name) || 0) > 0));
      for (const element of [layout, labels, explanation, readout, rangeReadout]) element.hidden = names.length === 0;
      if (JSON.stringify(names) !== JSON.stringify(shown) || !svg.firstChild) {
        shown = names; labels.replaceChildren(); svg.replaceChildren();
        const stack = buildStack(activity, names);
        const height = 240; const width = 600;
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        const title = svgNode('title', { id: 'activity-title' }); title.textContent = 'Successful skill reads';
        const description = svgNode('desc', { id: 'activity-description' }); description.textContent = 'Stacked areas show successful reads for selected skills in each UTC interval. Repeated reads count separately. Exact counts follow in the data table.';
        svg.append(title, description);
        const ticks = [...new Set([stack.maximum, Math.floor(stack.maximum / 2), 0])];
        scale.replaceChildren(...ticks.map(value => {
          const tick = node('span', number(value));
          tick.style.top = (1 - value / stack.maximum) * 100 + '%';
          tick.style.transform = value === stack.maximum ? '' : value === 0 ? 'translateY(-100%)' : 'translateY(-50%)';
          return tick;
        }));
        for (const value of ticks) {
          const y = height - value / stack.maximum * height;
          svg.append(svgNode('line', { x1: 0, x2: width, y1: y, y2: y, class: 'gridline' }));
        }
        const start = Date.parse(activity.startAt); const duration = Date.parse(activity.endAt) - start;
        const x = at => Math.max(0, Math.min(width, (Date.parse(at) - start) / duration * width));
        const y = value => height - value / stack.maximum * height;
        for (const layer of stack.layers) {
          const color = skillColor(layer.name); const label = button('', () => selectExploreSkill(layer.name), 'trend-label');
          label.dataset.skill = layer.name; label.style.setProperty('--skill-color', color); label.append(node('span', layer.name), node('small')); labels.append(label);
          const upper = activity.bins.flatMap((bin, index) => [[x(bin.startAt), y(layer.upper[index])], [x(bin.endAt), y(layer.upper[index])]]);
          const lower = activity.bins.flatMap((bin, index) => [[x(bin.startAt), y(layer.lower[index])], [x(bin.endAt), y(layer.lower[index])]]).reverse();
          const path = [...upper, ...lower].map((point, index) => (index ? 'L ' : 'M ') + point.join(' ')).join(' ') + ' Z';
          svg.append(svgNode('path', { d: path, fill: color, class: 'trend-area', 'data-skill': layer.name }));
        }
        if (details.open) renderData();
        else scroll.replaceChildren();
      }
      labels.querySelectorAll('.trend-label').forEach((label) => label.setAttribute('aria-pressed', String(label.dataset.skill === selection.skillName)));
      inspect(inspected); setRange(selection.interval);
    };
  }
  if (report.coverage.undatedEvidence > 0) target.append(node('p', count(report.coverage.undatedEvidence, 'record') + ' without a usable timestamp. Not shown in the skill trends.', 'footnote'));
}
function timeLabel(value) {
  return value.replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, '');
}
function intervalLabel(startAt, endAt) {
  if (!startAt.endsWith('T00:00:00.000Z') || !endAt.endsWith('T00:00:00.000Z')) {
    return timeLabel(startAt) + ' – ' + timeLabel(endAt) + ' (end exclusive)';
  }
  const last = new Date(Date.parse(endAt) - 1).toISOString();
  return startAt.slice(0, 10) === last.slice(0, 10) ? date(startAt) : date(startAt) + ' – ' + date(last);
}
function selectExploreInterval(interval, extend = false) {
  const current = state.explore.interval;
  state.explore.interval = extend && interval && current ? {
    startAt: interval.startAt < current.startAt ? interval.startAt : current.startAt,
    endAt: interval.endAt > current.endAt ? interval.endAt : current.endAt,
  } : interval;
  renderExplore();
}
function selectActivityBin(index, extend = false) {
  const bin = state.report.activity.bins[index];
  selectExploreInterval({ startAt: bin.startAt, endAt: bin.endAt }, extend);
}
function focusExploration() {
  const panel = $('explorer-panel');
  const target = panel.hidden ? $('activity-heading') : panel;
  target.tabIndex = -1; target.focus();
  if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' });
}
function selectExploreSkill(name) {
  if (state.explore.skillName !== name) addTrend(name);
  state.explore.skillName = state.explore.skillName === name ? null : name;
  renderExplore(); focusExploration();
}
function updateActivitySelection() {
  const interval = state.explore.interval;
  $('view-explorer').hidden = !interval && !state.explore.skillName;
  activityView?.(state.explore);
  $('activity-chart').querySelectorAll('.activity-choice').forEach((action) => {
    const bin = state.report.activity.bins[Number(action.dataset.bin)];
    action.setAttribute('aria-pressed', String(interval !== null && bin.startAt >= interval.startAt && bin.endAt <= interval.endAt));
  });
}
function inInterval(at, interval) {
  if (interval === null) return true;
  const value = Date.parse(at);
  return Number.isFinite(value) && value >= Date.parse(interval.startAt) && value < Date.parse(interval.endAt);
}
function explorationSnapshot(interval, skillName) {
  const result = { paths: [], readRuns: 0, reads: 0, selectedReads: 0, bySkill: new Map(), matchingReadsBySkill: new Map(), byModel: new Map(), gaps: 0 };
  for (const route of state.report.routes) {
    const names = new Set(); const routeSkillReads = new Map(); const routeModels = new Map(); let routeReads = 0; let matchedReads = 0; let lastMatchAt = null;
    for (const step of route.steps) {
      if (step.kind !== 'observations') continue;
      for (const item of step.items) {
        const evidence = item.evidence;
        if (evidence.kind !== 'read-result' || evidence.outcome !== 'success' || !inInterval(item.observedAt, interval)) continue;
        routeReads += 1; names.add(evidence.skill.name);
        routeSkillReads.set(evidence.skill.name, (routeSkillReads.get(evidence.skill.name) || 0) + 1);
        if (skillName === null || evidence.skill.name === skillName) {
          matchedReads += 1; lastMatchAt = item.observedAt;
          const key = JSON.stringify(evidence.model === null ? null : [evidence.model.provider, evidence.model.id]);
          const cell = routeModels.get(key) || { model: evidence.model, reads: 0 };
          cell.reads += 1; routeModels.set(key, cell);
        }
      }
    }
    if (routeReads === 0) continue;
    const knownRun = route.scope.runId !== null || !route.scope.host || route.scope.host === 'unknown' || route.scope.host === 'pi';
    if (knownRun) {
      result.readRuns += 1;
      for (const name of names) result.bySkill.set(name, (result.bySkill.get(name) || 0) + 1);
    }
    result.reads += routeReads;
    if (matchedReads === 0) continue;
    for (const [name, count] of routeSkillReads) result.matchingReadsBySkill.set(name, (result.matchingReadsBySkill.get(name) || 0) + count);
    for (const [key, entry] of routeModels) {
      const cell = result.byModel.get(key) || { model: entry.model, reads: 0, paths: 0 };
      cell.reads += entry.reads; cell.paths += 1; result.byModel.set(key, cell);
    }
    result.selectedReads += matchedReads;
    result.paths.push({ route, at: lastMatchAt });
    if (route.steps.some((step) => step.kind === 'gap' && step.reason !== 'filtered-intermediates')) result.gaps += 1;
  }
  return result;
}
function explorePaths(routeKey = null, model = undefined) {
  const paths = explorationSnapshot(state.explore.interval, state.explore.skillName).paths;
  state.focus = { kind: 'explore' };
  state.pages.routes = routeKey === null ? 0 : Math.max(0, Math.floor(paths.findIndex((entry) => entry.route.key === routeKey) / 8));
  state.pages.steps = 0; state.routeKey = routeKey;
  $('route-search').value = '';
  $('route-model').value = model === undefined ? '' : String(state.report.models.findIndex((column) => sameModel(column.model, model)));
  renderPaths(); showWorkspace('paths', true);
  if (routeKey !== null) { $('chain-view').focus(); $('chain-view').scrollIntoView({ block: 'nearest' }); }
}
function renderComparison() {
  const target = $('explore-comparison'); target.replaceChildren();
  const activity = state.report.activity;
  let interval = state.explore.interval;
  const recent = interval === null;
  if (recent) {
    if (activity.kind !== 'bucketed') {
      target.append(node('h3', 'Period comparison'), empty('The report needs at least two time intervals to compare.'));
      return;
    }
    const first = Math.max(Date.parse(activity.startAt), Date.parse(state.report.scope.fromObservedAt ?? activity.startAt));
    const end = Math.min(Date.parse(activity.endAt), state.report.scope.toObservedAt ? Date.parse(state.report.scope.toObservedAt) + 1 : Date.parse(activity.endAt));
    const step = Math.min(activity.binWidthMs, 86400000);
    const size = Math.min(7 * 86400000, Math.floor((end - first) / 2 / step) * step || Math.floor((end - first) / 2));
    if (size < 1) { target.append(empty('The report needs two elapsed periods to compare.')); return; }
    interval = { startAt: new Date(end - size).toISOString(), endAt: new Date(end).toISOString() };
  }
  const duration = Date.parse(interval.endAt) - Date.parse(interval.startAt);
  const previousStart = new Date(Date.parse(interval.startAt) - duration).toISOString();
  const heading = node('div', null, 'section-heading');
  heading.append(node('h3', recent ? 'Recent period vs previous period' : 'Compared with previous period'));
  if (recent) heading.append(button('Explore these dates', () => { state.explore.interval = interval; renderExplore(); focusExploration(); }, 'link'));
  target.append(heading);
  const earliest = state.report.activity.startAt;
  if (Date.parse(previousStart) < Math.max(Date.parse(earliest), Date.parse(state.report.scope.fromObservedAt ?? earliest))) {
    target.append(empty('The previous period is outside the current report. Select a later interval or widen the Period filter.'));
    return;
  }
  const current = explorationSnapshot(interval, null);
  const previous = explorationSnapshot({ startAt: previousStart, endAt: interval.startAt }, null);
  const summary = node('div', null, 'compare-summary');
  for (const [label, snapshot, startAt, endAt] of [
    [recent ? 'Recent' : 'Selected', current, interval.startAt, interval.endAt], ['Previous', previous, previousStart, interval.startAt],
  ]) {
    const block = node('div'); block.append(node('span', label + ' · ' + intervalLabel(startAt, endAt)), node('strong', count(snapshot.readRuns, 'path') + ' · ' + count(snapshot.reads, 'read'))); summary.append(block);
  }
  target.append(summary);
  if (!current.readRuns || !previous.readRuns) { target.append(empty('A period has no recorded runs with successful reads. Skill shares are unavailable.')); return; }
  target.append(node('p', 'Share of paths with successful reads that contain each skill.', 'footnote'));
  const names = new Set([...current.bySkill.keys(), ...previous.bySkill.keys()]);
  if (state.explore.skillName !== null) names.add(state.explore.skillName);
  const ranked = [...names].sort((left, right) => {
    if (left === state.explore.skillName) return -1;
    if (right === state.explore.skillName) return 1;
    const change = (name) => Math.abs((current.bySkill.get(name) || 0) / current.readRuns - (previous.bySkill.get(name) || 0) / previous.readRuns);
    return change(right) - change(left) || left.localeCompare(right);
  });
  const labels = node('div', null, 'compare-row'); labels.append(node('span', 'Skill'), node('span', recent ? 'Recent' : 'Selected'), node('span', 'Previous')); target.append(labels);
  for (const name of ranked.slice(0, 5)) {
    const row = node('div', null, 'compare-row' + (name === state.explore.skillName ? ' selected' : ''));
    const action = button(name, () => selectExploreSkill(name), 'link'); action.setAttribute('aria-pressed', String(name === state.explore.skillName)); row.append(action);
    for (const snapshot of [current, previous]) {
      const paths = snapshot.bySkill.get(name) || 0;
      const value = node('span', null, 'compare-value');
      value.append(node('span', Math.round(paths / snapshot.readRuns * 100) + '%'), node('small', count(paths, 'path'))); row.append(value);
    }
    target.append(row);
  }
  target.append(node('p', 'Each percent uses the recorded read-bearing paths in that period. Select a skill to inspect its paths.', 'footnote'));
}
function renderExplore() {
  const selection = state.explore; const active = selection.skillName !== null || selection.interval !== null;
  const panel = $('explorer-panel'); panel.hidden = !active;
  state.pages.skills = 0; renderRanks(); updateActivitySelection();
  $('explore-models').hidden = selection.skillName === null;
  if (state.focus.kind === 'explore') {
    if (!active) { state.focus = { kind: 'all' }; state.routeKey = null; }
    state.pages.routes = 0; renderPaths();
  }
  if (!active) { $('explore-announcement').textContent = ''; return; }
  const chips = $('explore-chips'); chips.replaceChildren();
  if (selection.skillName !== null) {
    const action = button('Skill: ' + selection.skillName + ' ×', () => { selection.skillName = null; renderExplore(); focusExploration(); }, 'explore-chip');
    action.setAttribute('aria-label', 'Remove ' + selection.skillName + ' from exploration'); chips.append(action);
  }
  if (selection.interval !== null) {
    const action = button('UTC: ' + intervalLabel(selection.interval.startAt, selection.interval.endAt) + ' ×', () => { selection.interval = null; renderExplore(); focusExploration(); }, 'explore-chip');
    action.setAttribute('aria-label', 'Remove UTC interval from exploration'); chips.append(action);
  }
  $('explore-rule').textContent = 'A matching path contains a successful read' + (selection.skillName === null ? '' : ' of ' + selection.skillName) + (selection.interval === null ? '.' : ' in the selected UTC interval.');
  const snapshot = explorationSnapshot(selection.interval, selection.skillName);
  const totals = $('explore-totals'); totals.replaceChildren();
  for (const [value, label] of [[snapshot.paths.length, 'matching paths'], [snapshot.selectedReads, 'successful reads']]) {
    const item = node('div', null, 'explore-total'); item.append(node('strong', number(value)), node('span', label)); totals.append(item);
  }
  if (snapshot.gaps) totals.append(node('span', count(snapshot.gaps, 'matching path') + ' with a known capture gap', 'small muted'));
  if (selection.interval !== null && state.report.coverage.undatedEvidence) totals.append(node('span', count(state.report.coverage.undatedEvidence, 'undated record') + ' excluded from period selection', 'small muted'));
  const paths = $('explore-paths'); paths.replaceChildren();
  for (const { route, at } of snapshot.paths.slice(0, 4)) {
    const action = button('', () => explorePaths(route.key), 'explore-path');
    const when = date(at, true);
    action.append(node('strong', project(route.scope.projectCwd) + ' · ' + when + (when === 'No usable timestamp' ? '' : ' UTC')));
    const names = [...new Set(route.steps.flatMap((step) => step.kind === 'observations' ? step.items.filter((item) => item.evidence.kind === 'read-result' && item.evidence.outcome === 'success').map((item) => item.evidence.skill.name) : []))];
    action.append(node('span', names.slice(0, 4).join(' · ') + (names.length > 4 ? ' …' : ''))); paths.append(action);
  }
  if (!snapshot.paths.length) paths.append(empty('No successful reads match this selection.'));
  $('explore-all-paths').disabled = snapshot.paths.length === 0;
  const models = $('explore-model-list'); models.replaceChildren();
  const rankedModels = [...snapshot.byModel.values()].sort((left, right) => right.reads - left.reads || modelLabel(left.model).localeCompare(modelLabel(right.model)));
  const modelRow = (entry) => {
    const action = button('', () => explorePaths(null, entry.model), 'explore-model');
    action.setAttribute('aria-label', 'View ' + count(entry.paths, 'matching path') + ' for ' + modelLabel(entry.model) + ' (' + count(entry.reads, 'read') + ')');
    const counts = node('span'); counts.append(node('strong', count(entry.reads, 'read')), node('small', count(entry.paths, 'path')));
    action.append(node('span', modelLabel(entry.model)), counts); return action;
  };
  models.append(...rankedModels.slice(0, 5).map(modelRow));
  if (rankedModels.length > 5) {
    const more = node('div'); more.append(...rankedModels.slice(5).map(modelRow));
    models.append(disclosure('View ' + count(rankedModels.length - 5, 'more model'), more));
  }
  if (!rankedModels.length) models.append(empty('No models match this selection.'));
  renderComparison();
  $('explore-announcement').textContent = count(snapshot.paths.length, 'matching path') + ' in the exploration.';
}
function renderRanks() {
  const query = $('skill-search').value.toLowerCase();
  const active = state.explore.skillName !== null || state.explore.interval !== null;
  const counts = active ? explorationSnapshot(state.explore.interval, state.explore.skillName).matchingReadsBySkill : null;
  $('skills-heading').textContent = active ? 'Skills in selection' : 'Most-read skills';
  $('skills-heading').closest('.section-heading').querySelector('.small').textContent = active ? 'Reads in matching paths' : 'Successful reads';
  const groups = state.report.skillGroups.map((group) => ({ group, reads: counts === null ? group.counts.successfulReads : counts.get(group.name) || 0 }))
    .filter((entry) => entry.reads > 0 && entry.group.name.toLowerCase().includes(query))
    .sort((left, right) => right.reads - left.reads || left.group.name.localeCompare(right.group.name));
  const target = $('skill-table'); target.replaceChildren();
  const max = groups[0]?.reads || 1;
  pageItems(groups, 'skills', 8).forEach(({ group, reads }, index) => {
    const selected = state.explore.skillName === group.name;
    const row = node('div', null, 'rank-row' + (selected ? ' selected' : '')); row.append(node('span', String(state.pages.skills * 8 + index + 1).padStart(2, '0'), 'rank-number'));
    const name = node('div'); const action = button(group.name, () => selectExploreSkill(group.name), 'link'); action.setAttribute('aria-pressed', String(selected)); name.append(action);
    const track = node('div', null, 'rank-track'); const fill = node('div', null, 'rank-fill'); fill.style.width = reads / max * 100 + '%'; track.append(fill); name.append(track);
    row.append(name, node('strong', number(reads))); target.append(row);
  });
  if (!groups.length) {
    target.append(empty(active && !query ? 'No successful reads match this selection.' : noResults('successful reads', query)));
    if (state.report.skillGroups.some((group) => group.cataloged)) target.append(button('View skill catalog', () => { $('catalog-context').open = true; $('catalog-context').querySelector('summary').focus(); }, 'link'));
  }
  target.append(pagination('skills', groups.length, 8, renderRanks));
}
function renderCatalog() {
  const groups = state.report.skillGroups.filter((group) => group.cataloged && group.name.toLowerCase().includes($('catalog-search').value.toLowerCase()));
  const target = $('catalog-list'); target.replaceChildren();
  for (const group of pageItems(groups, 'catalog', 8)) {
    const row = node('div', null, 'identity-item'); row.append(button(group.name, () => selectSkill(group.name), 'link'), node('p', totalEvidence(group.counts) === 0 ? 'No recorded activity' : countsText(group.counts))); target.append(row);
  }
  if (!groups.length) target.append(empty(noResults('catalog entries', $('catalog-search').value)));
  target.append(pagination('catalog', groups.length, 8, renderCatalog));
}
function skillName(key) { return state.report.skills.find((skill) => skill.key === key)?.identity.name || 'Unknown skill'; }
function relationshipFlow(relationship) {
  const flow = node('div', null, 'relationship-flow');
  const clusters = relationship.kind === 'same-group' ? [relationship.skills] : [relationship.from, relationship.to];
  clusters.forEach((keys, index) => {
    if (index) { const arrow = node('span', '→', 'flow-arrow'); arrow.setAttribute('aria-label', 'then next group'); flow.append(arrow); }
    const cluster = node('div', null, 'skill-cluster'); keys.forEach((key) => cluster.append(node('span', skillName(key), 'skill-node'))); flow.append(cluster);
  });
  return flow;
}
function renderRelationships() {
  const relationships = [...state.report.relationships].sort((a, b) => b.evidence.length - a.evidence.length);
  const target = $('relationship-view'); target.replaceChildren();
  const grid = node('div', null, 'relationship-grid');
  for (const relationship of pageItems(relationships, 'relationships', 4)) {
    const card = node('article', null, 'relationship'); card.append(node('p', relationship.kind === 'same-group' ? 'Same read group' : 'Consecutive read groups', 'small'), relationshipFlow(relationship), button('View ' + count(relationship.evidence.length, 'occurrence'), () => selectRelationship(relationship), 'link')); grid.append(card);
  }
  target.append(grid);
  if (!relationships.length) target.append(empty(noResults('read patterns')));
  target.append(pagination('relationships', relationships.length, 4, renderRelationships));
}
function selectSkill(name) {
  state.skillSelection = { kind: 'skill', name }; state.pages.identities = 0; renderSkillDetail(); showWorkspace('models');
  $('skill-detail').tabIndex = -1; $('skill-detail').focus();
}
function matchingModelGroups() {
  const query = $('model-search').value.toLowerCase();
  return state.report.skillGroups.filter((group) => group.counts.successfulReads + group.counts.failedReads > 0 && group.name.toLowerCase().includes(query));
}
function renderModels() {
  const report = state.report; const measure = $('model-measure').value;
  const groups = matchingModelGroups();
  const columns = pageItems(report.models, 'columns', 6);
  const matrix = table(['Skill', ...columns.map((column) => modelLabel(column.model))], measure === 'successfulReads' ? 'Successful reads by skill and model' : 'Read failures by skill and model'); matrix.className = 'matrix';
  const max = groups.reduce((value, group) => Math.max(value, ...group.models.map((model) => model[measure])), 1);
  for (const group of pageItems(groups, 'models', 12)) {
    const row = node('tr'); const label = node('th'); label.scope = 'row'; label.append(button(group.name, () => selectSkill(group.name), 'link')); row.append(label);
    for (const column of columns) {
      const value = group.models.find((entry) => sameModel(entry.model, column.model))?.[measure] || 0;
      const cell = node('td');
      const action = button(number(value), () => { state.skillSelection = { kind: 'model-skill', name: group.name, model: column.model }; state.pages.identities = 0; renderSkillDetail(); $('skill-detail').tabIndex = -1; $('skill-detail').focus(); }, 'heat-' + (value === 0 ? 0 : Math.max(1, Math.ceil(value / max * 4))));
      action.setAttribute('aria-label', group.name + ', ' + modelLabel(column.model) + ': ' + count(value, measure === 'successfulReads' ? 'successful read' : 'read failure')); cell.append(action); row.append(cell);
    }
    matrix.lastChild.append(row);
  }
  $('model-matrix').replaceChildren(groups.length && columns.length ? matrix : empty(noResults('reads', $('model-search').value)));
  $('model-pagination').replaceChildren(pagination('models', groups.length, 12, renderModels));
  if (groups.length && report.models.length > 6) $('model-pagination').append(pagination('columns', report.models.length, 6, renderModels));
  renderSkillDetail();
  setOptions($('route-model'), 'All models', report.models.map((column, index) => ({ value: String(index), label: modelLabel(column.model) })));
}
function renderSkillDetail() {
  const target = $('skill-detail'); target.replaceChildren();
  const selection = state.skillSelection;
  const selectedModel = selection?.kind === 'model-skill' ? selection.model : undefined;
  const group = state.report.skillGroups.find((entry) => entry.name === selection?.name);
  target.hidden = !group && (!matchingModelGroups().length || !state.report.models.length);
  if (!group) { if (!target.hidden) target.append(node('h2', 'Select a skill'), node('p', 'Select a skill name or count to view its records and paths.', 'footnote')); return; }
  const heading = node('div', null, 'section-heading'); heading.append(node('h2', group.name), button('View session paths', () => { state.focus = { kind: 'skill', name: group.name }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = selectedModel === undefined ? '' : String(state.report.models.findIndex((column) => sameModel(column.model, selectedModel))); renderPaths(); showWorkspace('paths', true); })); target.append(heading);
  target.append(node('p', countsText(group.counts), 'detail-counts'));
  if (selectedModel !== undefined) { const counts = group.models.find((column) => sameModel(column.model, selectedModel)); target.append(node('p', modelLabel(selectedModel) + ': ' + count(counts?.successfulReads || 0, 'read') + ' · ' + count(counts?.failedReads || 0, 'failure'), 'footnote')); }
  const identities = node('div', null, 'identity-list');
  identities.append(node('p', 'Files with the same skill name can have different content.', 'small'));
  const variants = group.skillKeys.map((key) => state.report.skills.find((entry) => entry.key === key)).filter(Boolean);
  for (const variant of pageItems(variants, 'identities', 8)) {
    const item = node('div', null, 'identity-item'); item.dataset.machine = variant.identity.machineId;
    item.append(node('p', 'Agent host: ' + variant.identity.host + ' · Machine: ' + variant.identity.machineId), node('p', variant.identity.kind === 'resolved' ? variant.identity.canonicalPath : 'Skill name not linked to a file'), node('p', countsText(variant.counts)), node('p', variant.cataloged ? 'In recorded catalog' : 'Not in recorded catalog'));
    identities.append(item);
  }
  identities.append(pagination('identities', variants.length, 8, renderSkillDetail));
  target.append(disclosure('Files and requests · ' + count(variants.length, 'entry', 'entries'), identities));
}
function selectRelationship(relationship) {
  state.focus = { kind: 'relationship', relationship, evidenceIndex: 0 }; state.pages.routes = 0; state.pages.evidence = 0;
  state.routeKey = relationship.evidence[0]?.routeKey || null;
  state.pages.steps = Math.floor((relationship.evidence[0]?.stepIndex ?? relationship.evidence[0]?.fromStepIndex ?? 0) / 30);
  $('route-search').value = ''; $('route-model').value = ''; renderPaths(); showWorkspace('paths', true);
}
function matchingRoutes() {
  const report = state.report; let keys = null;
  if (state.focus.kind === 'skill') keys = new Set(report.skillGroups.find((group) => group.name === state.focus.name)?.routeKeys || []);
  if (state.focus.kind === 'relationship') keys = new Set(state.focus.relationship.evidence.map((entry) => entry.routeKey));
  if (state.focus.kind === 'explore') keys = new Set(explorationSnapshot(state.explore.interval, state.explore.skillName).paths.map((entry) => entry.route.key));
  const query = $('route-search').value.toLowerCase(); const modelIndex = $('route-model').value; const model = modelIndex === '' ? undefined : report.models[Number(modelIndex)]?.model;
  return report.routes.filter((route) => {
    if (keys && !keys.has(route.key)) return false;
    if (model !== undefined && !route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => item.evidence.kind === 'read-result' && sameModel(item.evidence.model, model)
      && (state.focus.kind !== 'skill' || skillName(item.skillKey) === state.focus.name)
      && (state.focus.kind !== 'explore' || (item.evidence.outcome === 'success' && inInterval(item.observedAt, state.explore.interval)
        && (state.explore.skillName === null || item.evidence.skill.name === state.explore.skillName)))))) return false;
    return !query || route.scope.projectCwd.toLowerCase().includes(query) || route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => skillName(item.skillKey).toLowerCase().includes(query)));
  });
}
function renderPaths() {
  const routes = matchingRoutes();
  const label = state.focus.kind === 'skill' ? 'Paths containing ' + state.focus.name : state.focus.kind === 'relationship' ? 'Paths with this pattern' : state.focus.kind === 'explore' ? 'Paths in exploration' : 'All session paths';
  $('path-focus-label').textContent = label;
  $('back-to-explorer').hidden = state.focus.kind !== 'explore';
  $('route-count').textContent = count(routes.length, 'path');
  if (!routes.some((route) => route.key === state.routeKey)) { state.routeKey = routes[0]?.key || null; state.pages.steps = 0; }
  const target = $('route-list'); target.replaceChildren();
  for (const route of pageItems(routes, 'routes', 8)) {
    const choice = button('', () => { state.routeKey = route.key; state.pages.steps = 0; renderPaths(); $('chain-view').focus(); }, 'route-choice');
    choice.dataset.routeKey = route.key; choice.setAttribute('aria-pressed', String(route.key === state.routeKey));
    choice.append(node('strong', project(route.scope.projectCwd)), node('p', date(route.lastEvidenceAt, true) + ' UTC'), node('p', count(route.counts.successfulReads, 'read') + ' · ' + count(route.steps.length, 'step')));
    const names = [...new Set(route.steps.flatMap((step) => step.kind === 'observations' ? step.items.map((item) => skillName(item.skillKey)) : []))];
    choice.append(node('p', names.slice(0, 4).join(' · ') + (names.length > 4 ? ' …' : ''), 'route-preview')); target.append(choice);
  }
  if (!routes.length) target.append(empty($('route-search').value ? 'No paths match this search.' : state.focus.kind !== 'all' || $('route-model').value ? 'No paths match these filters.' : noResults('paths')));
  $('route-pagination').replaceChildren(pagination('routes', routes.length, 8, renderPaths));
  renderRelationshipDetail(routes); renderRouteDetail(routes.find((route) => route.key === state.routeKey));
}
function renderRelationshipDetail(routes) {
  const target = $('relationship-detail'); target.hidden = state.focus.kind !== 'relationship'; target.replaceChildren();
  if (state.focus.kind !== 'relationship') return;
  const relationship = state.focus.relationship;
  target.append(node('h2', relationship.kind === 'same-group' ? 'Same read group' : 'Consecutive read groups'), relationshipFlow(relationship));
  const occurrences = relationship.evidence.map((evidence, index) => ({ evidence, index })).filter(({ evidence }) => routes.some((route) => route.key === evidence.routeKey));
  if (occurrences.length) target.append(node('p', 'Select an occurrence to highlight its steps.', 'small'));
  const links = node('div', null, 'detail-counts');
  for (const { evidence, index } of pageItems(occurrences, 'evidence', 8)) {
    const route = routes.find((route) => route.key === evidence.routeKey);
    links.append(button(project(route.scope.projectCwd) + ' · ' + date(route.lastEvidenceAt, true) + ' · occurrence ' + (index + 1), () => {
      state.focus.evidenceIndex = index; state.routeKey = evidence.routeKey; state.pages.steps = Math.floor((evidence.stepIndex ?? evidence.fromStepIndex) / 30); state.pages.routes = Math.floor(routes.findIndex((item) => item.key === evidence.routeKey) / 8); renderPaths(); $('chain-view').focus();
    }, 'link'));
  }
  target.append(links, pagination('evidence', occurrences.length, 8, renderPaths));
}
function renderRouteDetail(route) {
  const target = $('chain-view'); target.replaceChildren();
  delete target.dataset.routeKey; delete target.dataset.machine;
  target.hidden = !route;
  if (!route) return;
  target.dataset.routeKey = route.key; target.dataset.machine = route.scope.machineId;
  const heading = node('div', null, 'section-heading'); const title = node('div'); title.append(node('h2', project(route.scope.projectCwd))); heading.append(title, node('span', date(route.firstEvidenceAt) + ' UTC', 'small muted')); target.append(heading);
  target.append(node('p', countsText(route.counts), 'small'));
  const scope = node('dl');
  for (const [label, value] of Object.entries(route.scope)) scope.append(node('dt', sessionLabels[label] || label), node('dd', value ?? 'Unknown'));
  target.append(disclosure('Session details', scope));
  let highlighted = [];
  if (state.focus.kind === 'relationship') {
    const evidence = state.focus.relationship.evidence[state.focus.evidenceIndex];
    if (evidence?.routeKey === route.key) highlighted = 'stepIndex' in evidence ? [evidence.stepIndex] : [evidence.fromStepIndex, evidence.toStepIndex];
  }
  const modelIndex = $('route-model').value;
  const pathModel = modelIndex === '' ? undefined : state.report.models[Number(modelIndex)]?.model;
  const timeline = node('ol', null, 'timeline'); timeline.start = state.pages.steps * 30 + 1;
  for (const [offset, step] of pageItems(route.steps, 'steps', 30).entries()) {
    const index = state.pages.steps * 30 + offset;
    const item = node('li', null, 'timeline-step' + (step.kind === 'gap' ? ' gap' : '') + (highlighted.includes(index) ? ' supporting' : ''));
    item.dataset.stepIndex = String(index);
    const label = node('div', null, 'step-heading'); label.append(node('span', String(index + 1).padStart(2, '0') + ' / ' + (step.kind === 'gap' ? 'Gap' : step.items.every((entry) => entry.evidence.kind === step.items[0]?.evidence.kind) ? stepLabels[step.items[0]?.evidence.kind] || 'Activity' : 'Activity')), node('span', date(step.observedAt, true) + (step.observedAt ? ' UTC' : ''))); item.append(label);
    if (highlighted.includes(index)) item.append(node('p', 'Selected occurrence', 'support-note'));
    if (step.kind === 'gap') {
      item.append(node('p', step.reason === 'filtered-intermediates' ? count(step.omitted, 'record') + ' hidden by filters.' : 'Capture gap: ' + count(step.omitted, 'record') + ' lost. ' + (gapLabels[step.reason] || 'Unknown capture reason') + '.', 'gap-card'));
      item.append(disclosure('Gap details', node('p', step.reason + ' · ' + (step.observedAt ?? 'No usable timestamp'))));
    } else {
      const group = node('div', null, 'step-group');
      for (const observation of step.items) {
        const evidence = observation.evidence;
        const kind = evidence.kind === 'read-attempt' ? 'attempt' : evidence.kind === 'skill-invocation' ? 'invocation' : evidence.kind === 'command-intent' ? 'request' : evidence.kind === 'wrapper-observed' ? 'wrapper' : evidence.outcome === 'success' ? 'read' : 'failure';
        const inExploration = state.focus.kind === 'explore' && evidence.kind === 'read-result' && evidence.outcome === 'success'
          && inInterval(observation.observedAt, state.explore.interval) && (state.explore.skillName === null || evidence.skill.name === state.explore.skillName)
          && (pathModel === undefined || sameModel(evidence.model, pathModel));
        const card = node('div', null, 'observation ' + kind + (inExploration ? ' matching' : ''));
        if (inExploration) card.append(node('span', 'In exploration', 'sr-only'));
        card.append(node('strong', skillName(observation.skillKey)), node('p', kind === 'request' ? 'Request · ' + (commandLabels[evidence.source] || evidence.source) : kind === 'wrapper' ? 'Wrapper · ' + (wrapperLabels[evidence.wrapperSource] || 'source unknown') : (kind === 'attempt' ? 'Read attempt · outcome unknown' : kind === 'invocation' ? 'Native invocation · ' + evidence.outcome : kind === 'read' ? 'Successful read' : 'Read failure') + ' · ' + modelLabel(evidence.model)));
        group.append(card);
      }
      item.append(group);
      const audit = node('div', null, 'route-scope'); audit.append(node('p', 'Turn: ' + (step.turnId ?? 'Unknown') + ' · Leaf: ' + (step.leafId ?? 'Unknown'), 'small'));
      for (const observation of step.items) audit.append(node('p', 'Record ' + observation.observationId + ' · sequence ' + observation.sequence + ' · ' + observation.observedAt + (observation.evidence.kind === 'command-intent' ? '' : ' · ' + (observation.evidence.skill.canonicalPath || 'Path unknown')) + (observation.evidence.kind === 'read-result' ? ' · tool call ' + observation.evidence.toolCallId : observation.evidence.kind === 'wrapper-observed' ? ' · ' + observation.evidence.wrapperSource : ''), 'footnote'));
      item.append(disclosure('Record details', audit));
    }
    timeline.append(item);
  }
  target.append(timeline, pagination('steps', route.steps.length, 30, () => renderRouteDetail(route)));
}

$('preview-label').hidden = new URLSearchParams(location.search).get('preview') !== '1';
document.querySelectorAll('[data-workspace]').forEach((item) => item.addEventListener('click', () => showWorkspace(item.dataset.workspace)));
$('filter-form').addEventListener('submit', (event) => { event.preventDefault(); loadDashboard(); });
$('refresh-data').addEventListener('click', loadDashboard);
$('reset-filters').addEventListener('click', () => { $('filter-form').reset(); $('time-preset').value = '7'; state.trends = { kind: 'top', count: 5 }; resetSelections(); loadDashboard(); });
$('host-filter').addEventListener('change', () => { for (const id of ['project-filter', 'model-provider-filter', 'model-id-filter']) $(id).value = ''; loadDashboard(); });
$('machine-filter').addEventListener('change', () => { for (const id of ['project-filter', 'model-provider-filter', 'model-id-filter']) $(id).value = ''; loadDashboard(); });
$('toggle-filters').addEventListener('click', () => { $('scope-panel').hidden = !$('scope-panel').hidden; $('toggle-filters').setAttribute('aria-expanded', String(!$('scope-panel').hidden)); });
$('time-preset').addEventListener('change', () => {
  const preset = $('time-preset').value;
  if (preset === 'custom') { $('scope-panel').hidden = false; $('toggle-filters').setAttribute('aria-expanded', 'true'); $('from-filter').focus(); return; }
  loadDashboard();
});
for (const id of ['from-filter', 'to-filter']) $(id).addEventListener('change', () => { $('time-preset').value = 'custom'; });
for (const [id, key, render] of [['skill-search', 'skills', renderRanks], ['model-search', 'models', renderModels], ['catalog-search', 'catalog', renderCatalog], ['route-search', 'routes', renderPaths]]) $(id).addEventListener('input', () => { state.pages[key] = 0; if (state.report) render(); });
$('model-measure').addEventListener('change', () => { if (state.report) renderModels(); });
$('route-model').addEventListener('change', () => { state.pages.routes = 0; state.routeKey = null; renderPaths(); });
$('browse-paths').addEventListener('click', () => showWorkspace('paths', true));
$('view-explorer').addEventListener('click', () => { $('explorer-panel').focus(); $('explorer-panel').scrollIntoView({ block: 'nearest' }); });
$('clear-explorer').addEventListener('click', () => { state.explore = { skillName: null, interval: null }; renderExplore(); focusExploration(); });
$('explore-models').addEventListener('click', () => selectSkill(state.explore.skillName));
$('explore-all-paths').addEventListener('click', () => explorePaths());
$('back-to-explorer').addEventListener('click', () => { showWorkspace('overview', true); $('explorer-panel').focus(); $('explorer-panel').scrollIntoView({ block: 'nearest' }); });
$('clear-path-focus').addEventListener('click', () => { state.focus = { kind: 'all' }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = ''; renderPaths(); });
loadDashboard();
`;
