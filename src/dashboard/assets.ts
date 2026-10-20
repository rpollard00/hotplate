import { projectMetrics } from "./metrics.js";
import { contentMeasures } from "../content-analytics.js";

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
      <button type="button" data-workspace="metrics" aria-current="page">Metrics</button>
      <button type="button" data-workspace="paths">Session paths</button>
      <button type="button" data-workspace="resources">Resources</button>
      <span class="workspace-indicator" aria-hidden="true" hidden></span>
    </nav>
    <div class="scope-bar">
      <p id="scope-summary" hidden></p>
      <div class="scope-actions"><label class="inline-label">Agent<select id="host-filter" name="host" form="filter-form"><option value="">All agents</option></select></label><label class="inline-label">Model<select id="model-filter" name="model" form="filter-form"><option value="">All models</option></select></label><label class="inline-label">Period<select id="time-preset"><option value="all">All time</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label><button type="button" id="toggle-filters" class="quiet" aria-expanded="false" aria-controls="scope-panel">More filters</button><button type="button" id="reset-filters" class="quiet">Reset</button></div>
    </div>
    <section id="scope-panel" class="panel" hidden aria-label="Filters">
      <form id="filter-form" class="filter-grid">
        <label>Machine<select id="machine-filter" name="machineId"><option value="">All machines</option></select></label>
        <label>Project<select id="project-filter" name="projectCwd"><option value="">All projects</option></select></label>
        <label>Command source <span>Requests only</span><select id="source-filter" name="source"><option value="">All command sources</option><option value="interactive">Interactive</option><option value="rpc">RPC</option><option value="extension">Extension</option></select></label>
        <label>From (UTC)<input id="from-filter" name="fromObservedAt" type="datetime-local" step="0.001"></label>
        <label>To (UTC)<input id="to-filter" name="toObservedAt" type="datetime-local" step="0.001"></label>
        <div class="filter-actions"><button type="submit">Apply filters</button></div>
      </form>
      <p class="footnote">Filters apply to all tabs.</p>
    </section>
    <section id="message-panel" class="message panel" role="status" hidden></section>
    <main id="workspace" tabindex="-1" aria-busy="true">
      <div id="dashboard-content" hidden>
        <section id="metrics-workspace" aria-labelledby="metrics-heading">
          <div class="page-heading"><div><h1 id="metrics-heading">Skill and resource metrics</h1></div></div>
          <div id="overview-cards" class="metrics-grid" aria-label="Filtered totals"></div>
          <div id="evidence-context" class="evidence-context"></div>
          <div class="metric-controls"><label>Content<select id="metric-content"><option value="skills">Skills</option><option value="resources">Resources</option><option value="both" selected>Both</option></select></label><label>Measure<select id="metric-measure"><option value="successfulReads">Successful reads</option><option value="uses">Skill uses</option><option value="failedReads">Read failures</option><option value="invocations">Native invocations</option><option value="invocationFailures">Invocation failures</option><option value="readAttempts">Read attempts</option><option value="requests">Requests</option><option value="wrappers">Wrappers</option></select></label><label>Split by<select id="metric-split"><option value="skill">Skill / total ranking</option><option value="agent">Agent</option><option value="model">Model</option><option value="agent-model">Agent + model</option></select></label></div><p id="metric-explanation" class="footnote"></p><details id="tool-coverage" class="footnote"><summary id="tool-coverage-summary">Tool coverage</summary><div id="tool-coverage-content"></div></details><div id="content-status" class="content-status" role="status" hidden></div>
          <div class="overview-grid">
            <section class="panel activity-panel" aria-labelledby="activity-heading"><div class="section-heading"><div><h2 id="activity-heading">Over time</h2></div><div class="activity-actions"><span class="small muted">UTC</span><button id="view-explorer" class="quiet" type="button" hidden>View selection</button></div></div><div id="activity-chart"></div></section>
            <section class="panel" aria-labelledby="skills-heading"><div class="section-heading"><h2 id="skills-heading">Compare skills</h2><label class="inline-label">Display<select id="metric-display"><option value="count">Count</option><option value="session-share">Session share</option></select></label></div><label class="search-label"><span class="sr-only">Find a skill</span><input id="skill-search" type="search" placeholder="Find a skill…"></label><div id="skill-table" class="table-wrap" tabindex="0" role="region" aria-label="Skill comparison"></div><p id="comparison-scroll-hint" class="matrix-scroll-hint footnote" hidden>Scroll horizontally to compare all columns.</p><div id="comparison-pagination"></div><p id="comparison-note" class="footnote"></p></section>
          </div>
          <section id="explorer-panel" class="panel explorer-panel" aria-labelledby="explorer-heading" tabindex="-1" hidden>
            <div class="section-heading"><div><p class="small muted">Within the current filters</p><h2 id="explorer-heading">Successful-read exploration</h2></div><div class="explorer-actions"><button id="explore-models" class="quiet" type="button" hidden>Skill details</button><button id="clear-explorer" class="quiet" type="button">Clear selection</button></div></div>
            <div id="explore-chips" class="explore-chips"></div>
            <p id="explore-rule" class="small muted"></p>
            <div id="explore-totals" class="explore-totals"></div>
            <div class="explore-layout"><section id="explore-comparison" aria-label="Period comparison"></section><div class="explore-side"><section aria-labelledby="explore-path-heading"><div class="section-heading"><h3 id="explore-path-heading">Matching paths</h3><button id="explore-all-paths" class="link" type="button">View all</button></div><div id="explore-paths"></div></section><section aria-labelledby="explore-model-heading"><h3 id="explore-model-heading">Models in selection</h3><p class="footnote">Successful reads matching the selected skill and UTC dates.</p><div id="explore-model-list"></div></section></div></div>
            <p id="explore-announcement" class="sr-only" role="status" aria-live="polite"></p>
          </section>
          <section id="skill-detail" class="panel" aria-live="polite" hidden></section><section id="content-detail" class="panel" aria-live="polite" hidden></section>
          <details class="panel" id="read-patterns"><summary id="relationships-heading">Read patterns</summary><div class="section-heading"><button type="button" id="browse-paths" class="quiet">View session paths</button></div><div id="relationship-view"></div></details>
          <details class="panel" id="catalog-context"><summary>Skill catalog</summary><p class="footnote">The catalog follows machine, project, and date filters only.</p><label class="search-label">Find a catalog skill<input id="catalog-search" type="search" placeholder="Search names…"></label><div id="catalog-list"></div></details>
        </section>
        <section id="resources-workspace" aria-labelledby="resources-heading" hidden>
          <div class="page-heading"><div><h1 id="resources-heading">Resources</h1><p id="resource-summary"></p></div></div>
          <details id="resource-coverage" class="panel"><summary id="resource-coverage-summary">Observation coverage</summary><div id="resource-coverage-content"></div></details>
          <section class="panel" aria-label="Resource inventory and access">
            <div id="resource-controls" class="resource-controls">
              <label class="search-label">Find a file<input id="resource-search" type="search" placeholder="Search paths or owner skills…"></label>
              <label>Type<select id="resource-kind"><option value="">All files</option><option value="skill">Skills</option><option value="principle">Principles</option><option value="reference">References</option><option value="script">Scripts</option><option value="file">Other files</option></select></label>
              <label>Observation<select id="resource-observation"><option value="">All observations</option><option value="observed">Observed agent activity</option><option value="not-observed">No observed agent access</option><option value="unknown">Unknown</option></select></label>
            </div>
            <p id="resource-scroll-hint" class="resource-scroll-hint footnote">Scroll horizontally for access counts and attribution.</p>
            <div id="resource-table" class="table-wrap" tabindex="0" role="region" aria-label="Resource access evidence"></div>
            <div id="resource-pagination"></div>
            <p id="resource-evidence-note" class="footnote">This inventory includes filesystem diagnostics. Confirmed reads have native read results. Inferred reads come from recognized commands. Observed access can include catalog polling.</p>
          </section>
        </section>
        <section id="paths-workspace" aria-labelledby="paths-heading" hidden>
          <div class="page-heading"><div><h1 id="paths-heading">Session paths</h1><p>Recorded activity by session and available run.</p></div></div>
          <div class="path-toolbar panel"><div><strong id="path-focus-label">All session paths</strong><p class="small">These controls filter paths only.</p><button id="back-to-explorer" type="button" class="link" hidden>Back to exploration</button></div><label class="search-label"><span class="sr-only">Search session paths</span><input id="route-search" type="search" placeholder="Find project or skill…"></label><label class="inline-label">Model<select id="route-model"><option value="">All models</option></select></label><button type="button" id="clear-path-focus" class="quiet">Reset path filters</button></div>
          <div id="relationship-detail" class="panel" hidden></div>
          <div class="path-layout"><section class="panel route-master" aria-label="Recent session paths"><div class="section-heading"><h2>Recent paths</h2><span class="small muted" id="route-count"></span></div><span class="route-indicator" aria-hidden="true" hidden></span><div id="route-list"></div><div id="route-pagination"></div></section><section id="chain-view" class="panel route-detail" aria-label="Selected session path" tabindex="-1"></section></div>
        </section>
      </div>
    </main>
    <details class="panel" id="data-help"><summary>About this data</summary><div class="data-definitions">
      <p>A skill read is a successful tool read of <code>SKILL.md</code>. A request records a skill command. A wrapper records skill text found in input.</p>
      <p>A skill use is a successful read, a successful native skill invocation, or a read attempt. Failures are not skill uses.</p>
      <p>A read attempt has no known outcome. The dashboard shows read attempts as unconfirmed.</p>
      <p>An agent session is one session of one agent. Agent comparisons count sessions, because a run means different things in different agents.</p>
      <p>Skills are grouped by name, even when their file paths or contents differ.</p>
      <p>Model identity appears when the capture source supplies it.</p>
      <p>Each path represents one recorded run. A session can contain multiple runs. Order within a read group is unknown.</p>
      <p>Capture gaps represent lost records. Filtered gaps represent records hidden by filters.</p>
      <p>Agent comparisons use evidence from Hotplate integrations. Each integration records different evidence. For example, the Codex integration records read attempts with no known outcome.</p>
      <p>Tool activity counts confirmed reads, inferred reads, read attempts, read failures, and native invocations from enabled agent integrations.</p>
      <p>Inferred reads come from recognized literal commands with successful tool outcomes. A file read does not establish which instructions the agent followed.</p>
      <p>All recorded activity includes filesystem observers, requests, and wrappers. Filesystem activity can include catalog polling.</p>
      <p>Resource inventory records files found in skill directories. Files without observed tool access are not known to be unused. Filesystem covered dates do not establish complete tool coverage.</p>
      <p>Tool coverage counts observed operations. Opaque operations have unresolved file access and do not create skill or resource rows.</p>
      <p>Unknown and non-agent access remain separate from activity attributed to an agent.</p>
    </div></details>
  </div>
  <script src="/assets/app.js"></script>
</body>
</html>`;

export const dashboardCss = `@font-face {
  font-family: "JetBrains Mono Variable";
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url("/assets/fonts/jetbrains-mono-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
@font-face {
  font-family: "Archivo Variable";
  font-style: normal;
  font-weight: 100 900;
  font-stretch: 62% 125%;
  font-display: swap;
  src: url("/assets/fonts/archivo-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
:root {
  color-scheme: dark;
  --paper-rgb: 245 240 230;
  --bg: #000; --panel: #000;
  --ink: rgb(var(--paper-rgb) / .94); --muted: rgb(var(--paper-rgb) / .7);
  --quiet: rgb(var(--paper-rgb) / .54); --faint: rgb(var(--paper-rgb) / .26);
  --line: rgb(var(--paper-rgb) / .14); --control-line: rgb(var(--paper-rgb) / .38); --active-line: rgb(var(--paper-rgb) / .6);
  --soft: rgb(var(--paper-rgb) / .05); --soft-strong: rgb(var(--paper-rgb) / .09);
  --teal-rgb: 25 195 125; --teal: rgb(var(--teal-rgb)); --teal-bright: #7dffb5; --teal-deep: #0f5c46; --teal-pale: #e9ffe9;
  --accent-rgb: 240 138 60; --accent: rgb(var(--accent-rgb)); --unconfirmed-rgb: 255 224 138; --unconfirmed: rgb(var(--unconfirmed-rgb));
  --tooling-rgb: 255 133 194; --tooling: rgb(var(--tooling-rgb));
  --bad-rgb: 255 141 142; --bad: rgb(var(--bad-rgb));
  --selection-line: rgb(var(--teal-rgb) / .5); --selection: rgb(var(--teal-rgb) / .08);
  --mono: "JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --sans: "Archivo Variable", system-ui, sans-serif;
  font-family: var(--mono);
  font-synthesis: none;
  scrollbar-color: var(--faint) var(--bg);
  scrollbar-width: thin;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; color: var(--ink); background: var(--bg); font-size: 12px; line-height: 1.4; -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; color: inherit; }
code, kbd { font-family: var(--mono); }
button, select, summary { cursor: pointer; }
button { border: 1px solid var(--control-line); border-radius: 3px; background: var(--panel); color: var(--ink); min-height: 32px; padding: 7px 11px; font-weight: 500; }
button:hover:enabled { border-color: var(--active-line); color: var(--ink); }
button:disabled { cursor: default; opacity: .45; }
button.quiet { background: transparent; border-color: var(--control-line); color: var(--muted); }
button.quiet:hover:enabled { background: var(--soft); }
button.link { border: 0; min-height: 0; padding: 0; background: transparent; color: var(--muted); text-align: left; overflow-wrap: anywhere; text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
button.link:hover:enabled { text-decoration-color: var(--ink); }
:focus-visible { outline: 1.5px solid rgb(var(--paper-rgb)); outline-offset: 2px; }
input, select { border: 1px solid var(--control-line); border-radius: 3px; min-height: 32px; padding: 7px 9px; background: var(--panel); color: var(--ink); min-width: 0; max-width: 100%; }
input::placeholder { color: var(--quiet); opacity: 1; }
input:focus, select:focus { border-color: var(--active-line); }
input { width: 100%; }
label { display: grid; gap: 5px; font-size: 11px; font-weight: 500; color: var(--quiet); }
h1, h2, h3, p { margin: 0; overflow-wrap: anywhere; }
h1, h2, h3 { font-family: var(--sans); font-stretch: 112%; line-height: 1.2; }
h1 { font-size: 23px; font-weight: 800; letter-spacing: -.02em; margin: 4px 0 7px; }
h2 { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
h3 { font-size: 14px; font-weight: 700; }
p { color: var(--muted); }
.small, .footnote { font-size: 11px; }
.footnote { margin-top: 14px; }
.muted { color: var(--muted); }
.app-header { min-height: 52px; padding: 8px 3.2%; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; border-bottom: 1px solid var(--line); background: var(--bg); }
.identity, .header-actions { display: flex; gap: 14px; align-items: center; }
.identity { min-width: 0; flex-wrap: wrap; }
.header-actions { margin-left: auto; }
.identity strong { font-family: var(--sans); font-stretch: 112%; font-size: 19px; font-weight: 800; letter-spacing: -.035em; }
.brand-mark { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border: 1px solid var(--teal); background: var(--bg); color: var(--teal-bright); font-size: 22px; font-weight: 600; border-radius: 3px; }
.identity-note { border-left: 1px solid var(--line); padding-left: 14px; color: var(--quiet); font-size: 11px; }
.preview { font-size: 9px; padding: 3px 6px; border: 1px solid rgb(var(--accent-rgb) / .35); color: var(--accent); background: var(--bg); border-radius: 3px; }
#status-text { color: var(--quiet); font-size: 11px; white-space: nowrap; }
#status-text::before { content: ''; display: inline-block; width: 5px; height: 5px; background: var(--accent); border-radius: 50%; margin-right: 7px; }
#status-text[data-kind=ready]::before { background: var(--teal); }
#status-text[data-kind=error]::before { background: var(--bad); }
.shell { width: min(1440px, 93.6%); margin: auto; }
.workspace-nav { position: relative; display: flex; gap: 26px; padding-top: 4px; border-bottom: 1px solid var(--line); }
.workspace-nav button { min-height: 40px; padding: 11px 1px; border: 0; border-bottom: 1px solid transparent; border-radius: 0; background: transparent; color: var(--quiet); font-size: 11px; }
.workspace-nav button[aria-current] { color: var(--ink); }
.workspace-indicator, .route-indicator { position: absolute; z-index: 1; background: var(--teal); pointer-events: none; transform-origin: 0 0; }
.workspace-indicator { height: 1px; bottom: -1px; }
.route-indicator { width: 2px; border-radius: 1px; }
.scope-bar { flex-wrap: wrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; font-size: 11px; }
.scope-actions { flex-wrap: wrap; max-width: 100%; display: flex; align-items: center; gap: 8px; min-width: 0; margin-left: auto; }
.inline-label { display: flex; align-items: center; gap: 8px; }
.scope-actions label { min-width: 0; }
.scope-actions select { max-width: 230px; min-width: 0; }
.metric-controls { display: flex; flex-wrap: wrap; gap: 18px; margin: 0 0 8px; }
.metric-controls label { display: flex; align-items: center; gap: 8px; }
#metric-explanation { margin: 0 0 18px; }
.scope-actions button, .scope-actions select { padding: 5px 8px; font-size: 11px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 18px; min-width: 0; margin-bottom: 18px; }
.filter-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; align-items: end; }
.page-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.page-heading > div, .section-heading > div { min-width: 0; }
.section-heading > button { flex-shrink: 0; }
.page-heading { padding: 13px 0 18px; }
.section-heading { margin-bottom: 16px; }
.section-heading p { margin-top: 4px; font-size: 11px; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 3px; background: var(--panel); }
.metric-card { padding: 18px 22px; border-right: 1px solid var(--line); }
.metric-card:last-child { border: 0; }
.metric-label { font-size: 11px; color: var(--muted); font-weight: 500; }
.metric-value { display: block; font-size: 32px; line-height: 1.3; letter-spacing: -.045em; font-variant-numeric: tabular-nums; margin: 5px 0; }
.metric-note { font-size: 10px; color: var(--quiet); }
.metric-card:last-child .metric-value { color: var(--bad); }
.evidence-context { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 11px; padding: 10px 2px 18px; color: var(--quiet); }
.overview-grid { display: grid; grid-template-columns: minmax(0,1.55fr) minmax(330px,1fr); gap: 18px; }
.overview-grid.matrix-layout { grid-template-columns: minmax(0,1fr); }
.matrix th { overflow-wrap: anywhere; }
.content-status { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; font-size: 12px; }
.content-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.content-name .link { overflow-wrap: anywhere; text-align: left; min-width: 0; }
.content-label { min-width: 0; }
.content-toggle { flex: 0 0 36px; width: 36px; min-height: 40px; padding: 4px; }
.content-child .content-name { padding-left: 22px; }
.content-latest { display: block; font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; margin-top: 10px; }
.content-location { overflow-wrap: anywhere; color: var(--muted); font-size: 11px; line-height: 1.6; }
.content-breakdown { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 14px 0; }
.content-breakdown > div { min-width: 110px; }
.content-breakdown strong, .content-breakdown span { display: block; }
.content-breakdown span { color: var(--muted); font-size: 11px; }
.content-detail-heading { overflow-wrap: anywhere; min-width: 0; }
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
.trend-label:hover:enabled { border-left-color: var(--skill-color); }
.trend-label small { font-size: 11px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.trend-scale { position: relative; text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.trend-scale > span { position: absolute; right: 0; }
.trend-plot { position: relative; height: 240px; min-width: 0; touch-action: pan-y; user-select: none; cursor: crosshair; }
.activity-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.activity-svg .gridline { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.trend-area { stroke: var(--bg); stroke-width: 0.6; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.trend-cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--quiet); pointer-events: none; }
.brush-shade { position: absolute; top: 0; bottom: 0; background: rgb(0 0 0 / .68); pointer-events: none; }
.brush-shade.before { left: 0; }.brush-shade.after { right: 0; }
.brush-band { position: absolute; top: 0; bottom: 0; padding: 0; border: 0; border-left: 1px solid var(--teal); border-right: 1px solid var(--teal); border-radius: 3px; background: var(--selection); cursor: grab; }
.brush-band:hover:enabled { border-left-color: var(--teal); border-right-color: var(--teal); background: rgb(var(--teal-rgb) / .13); }
.trend-plot[data-dragging=true], .trend-plot[data-dragging=true] * { cursor: grabbing; }
.trend-plot[data-pointer=true]:focus { outline: none; }
.brush-handle { position: absolute; top: calc(50% - 22px); height: 44px; width: 24px; padding: 0; border: 0; border-radius: 0; background: transparent; transform: translateX(-50%); cursor: ew-resize; touch-action: pan-y; }
.brush-handle::after { content: ''; position: absolute; top: calc(50% - 15px); left: 8px; width: 8px; height: 30px; border: 2px solid var(--bg); border-radius: 2px; background: var(--teal-bright); }
.brush-handle:hover { background: var(--selection); }
.chart-axis { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--muted); grid-column: 2; padding-top: 10px; }
.chart-axis > span { min-width: 0; overflow-wrap: anywhere; }
.chart-axis > span:last-child { text-align: right; }
.trend-readout, .brush-range { font-size: 11px; color: var(--muted); min-height: 1.5em; margin-top: 12px; font-variant-numeric: tabular-nums; }
.brush-range { color: var(--teal-bright); margin-top: 4px; }
.activity-data { min-width: 640px; }
.activity-choice[aria-pressed=true] { background: var(--soft); }
details { margin-top: 15px; }
summary { color: var(--muted); font-size: 11px; font-weight: 500; }
summary:hover { color: var(--ink); }
details[open] > summary { margin-bottom: 15px; }
.search-label { max-width: 360px; margin-bottom: 12px; }
.rank-row { display: grid; grid-template-columns: 22px minmax(0,1fr) 38px; align-items: center; gap: 10px; padding: 8px 0; }
.rank-number { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.rank-row button { display: block; font-size: 12px; }
.rank-row strong { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.rank-row.selected { background: var(--selection); margin: 0 -9px; padding: 8px 9px; border-radius: 3px; }
.rank-row.selected button { color: var(--teal-bright); }
.rank-track { background: var(--soft-strong); height: 3px; margin-top: 7px; border-radius: 0; }
.rank-fill { height: 100%; background: var(--teal); }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; padding-top: 14px; }
.pagination-actions { display: flex; gap: 5px; }
.pagination button { padding: 4px 8px; font-size: 11px; }
.explorer-panel { border-color: var(--selection-line); }
.explorer-panel > .section-heading { align-items: start; }
.explorer-panel > .section-heading h2 { font-size: 19px; margin-top: 2px; }
.explorer-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.explore-chips, .explore-totals { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.explore-chips { margin: 12px 0 8px; }
#explore-rule { margin-bottom: 18px; }
.explore-chip { border: 1px solid var(--selection-line); border-radius: 3px; background: var(--selection); color: var(--teal-bright); padding: 5px 9px; font-size: 11px; }
.explore-chip:hover { background: rgb(var(--teal-rgb) / .13); }
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
.relationship { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 14px; }
.relationship-flow { display: flex; align-items: center; gap: 10px; margin: 10px 0 12px; }
.skill-cluster { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
.skill-node { background: var(--panel); border: 1px solid var(--faint); border-radius: 3px; padding: 5px 8px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.flow-arrow { color: var(--teal); flex-shrink: 0; }
.relationship button { font-size: 11px; }
.table-wrap { overflow-x: auto; max-width: 100%; }
.resource-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; margin-bottom: 20px; }
.resource-controls .search-label { flex: 1; min-width: 220px; max-width: none; margin-bottom: 0; }
.resource-controls > label { display: grid; gap: 7px; font-size: 12px; font-weight: 600; }
.resource-controls input, .resource-controls select { height: 38px; }
.resource-table { min-width: 1280px; table-layout: fixed; }
.resource-table th:first-child { width: 310px; }
.resource-table th:nth-child(2) { width: 165px; }
.resource-table th:nth-child(n+3):nth-child(-n+8) { width: 90px; white-space: nowrap; }
.resource-table th:nth-child(9), .resource-table th:nth-child(10) { width: 125px; }
.resource-table td { vertical-align: top; }
.resource-table td:nth-child(n+3):nth-child(-n+8) { font-variant-numeric: tabular-nums; text-align: right; }
.resource-path { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.resource-meta { display: block; font-size: 11px; line-height: 1.65; color: var(--muted); margin-top: 5px; }
.resource-state { display: inline-block; align-self: start; padding: 3px 7px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg); color: var(--quiet); font-size: 11px; font-weight: 500; }
.resource-state[data-state="observed"], .resource-state[data-state="active"] { color: var(--teal-bright); border-color: var(--selection-line); background: var(--selection); }
.resource-state[data-state="not-observed"] { color: var(--muted); background: var(--soft); }
.resource-state[data-state="unavailable"], .resource-state[data-state="overflow"], .resource-state[data-state="stale"] { color: var(--accent); border-color: rgb(var(--accent-rgb) / .35); background: rgb(var(--accent-rgb) / .06); }
.resource-coverage-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px 20px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.resource-coverage-row:last-child { border-bottom: 0; padding-bottom: 0; }
.resource-coverage-row p { margin: 4px 0 0; overflow-wrap: anywhere; }
.resource-table details { margin-top: 8px; font-size: 11px; }
.resource-table details p { margin: 6px 0; overflow-wrap: anywhere; }
.resource-scroll-hint { display: none; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
caption { text-align: left; color: var(--muted); padding-bottom: 12px; }
th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; overflow-wrap: anywhere; }
th { font-size: 11px; color: var(--muted); font-weight: 600; }
.matrix { table-layout: fixed; min-width: 620px; }
.matrix th:first-child { width: 210px; position: sticky; left: 0; z-index: 1; background: var(--panel); }
.matrix-scroll-hint { display: none; }
.matrix td { text-align: center; font-variant-numeric: tabular-nums; padding: 5px; }
.matrix td button { width: 100%; min-height: 37px; border: 0; color: var(--teal-pale); font-weight: 500; }
.matrix .heat-0 { background: var(--soft); color: var(--quiet); font-weight: 400; }
.matrix .heat-1 { background: rgb(var(--teal-rgb) / .1); }.matrix .heat-2 { background: rgb(var(--teal-rgb) / .2); }.matrix .heat-3 { background: rgb(var(--teal-rgb) / .35); }.matrix .heat-4 { background: var(--teal-deep); }
.matrix th small { display: block; font-size: 10px; font-weight: 400; }
.matrix td > span { display: block; min-height: 37px; line-height: 37px; border-radius: 3px; }
.detail-counts { display: flex; flex-wrap: wrap; gap: 12px 24px; padding: 15px 0; font-size: 12px; }
.identity-list { display: grid; gap: 10px; margin-top: 12px; }
.identity-item { padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; overflow-wrap: anywhere; }
.identity-item p { font-size: 12px; }
.path-toolbar { display: flex; align-items: center; gap: 18px; padding: 15px 18px; }
.path-toolbar > div:first-child { margin-right: auto; min-width: 0; }
.path-toolbar .search-label { margin-bottom: 0; max-width: 210px; }
.path-toolbar select { max-width: 210px; }
.path-layout { display: grid; grid-template-columns: 310px minmax(0,1fr); gap: 18px; align-items: start; }
.route-master { position: relative; padding: 18px 14px; }
.route-choice { display: block; text-align: left; width: 100%; background: transparent; border: 1px solid transparent; border-radius: 3px; color: var(--ink); padding: 12px 10px; margin-bottom: 4px; font-weight: 400; }
.route-choice[aria-pressed=true] { background: var(--selection); border-color: var(--selection-line); }
.route-choice strong { font-size: 13px; display: block; }
.route-choice p { font-size: 11px; margin-top: 4px; }
.route-choice .route-preview { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--teal-bright); }
.route-detail { min-height: 410px; }
.route-scope { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: 100px minmax(0,1fr); gap: 5px 14px; font-size: 12px; }
dt { color: var(--muted); }dd { margin: 0; overflow-wrap: anywhere; }
.timeline { position: relative; list-style: none; padding: 0; margin: 24px 0 0; }
.timeline-trace { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.timeline-connector { stroke: var(--teal); stroke-width: 1.5; }
.timeline-tip { fill: var(--teal-bright); opacity: 0; }
.timeline-arrival { fill: none; stroke: var(--teal-bright); stroke-width: 1.25; opacity: 0; transform-box: fill-box; transform-origin: center; }
.timeline-step { position: relative; padding: 0 0 22px 28px; margin-left: 8px; border-left: 1px solid var(--faint); }
.timeline-step:last-of-type { border-left-color: transparent; }
.timeline-step::before { content: ''; position: absolute; width: 9px; height: 9px; background: var(--faint); border: 3px solid var(--bg); box-sizing: content-box; border-radius: 50%; left: -8px; top: 2px; }
.step-heading { display: flex; gap: 12px; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 9px; }
.step-group { display: flex; flex-wrap: wrap; gap: 7px; }
.observation { background: var(--panel); border: 1px solid var(--line); border-left: 2px solid var(--teal); border-radius: 3px; padding: 9px 12px; min-width: 0; max-width: 100%; }
.observation strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
.observation p { font-size: 11px; overflow-wrap: anywhere; }
.observation.attempt { background: rgb(var(--unconfirmed-rgb) / .04); border-color: rgb(var(--unconfirmed-rgb) / .3); border-left-color: var(--unconfirmed); border-left-style: dashed; }
.observation.invocation { border-left-color: var(--tooling); }
.observation.request { background: rgb(var(--tooling-rgb) / .04); border-color: rgb(var(--tooling-rgb) / .3); border-left-color: var(--tooling); }
.observation.wrapper { background: rgb(var(--accent-rgb) / .04); border-color: rgb(var(--accent-rgb) / .3); border-left-color: var(--accent); }
.observation.failure { background: rgb(var(--bad-rgb) / .04); border-color: rgb(var(--bad-rgb) / .3); border-left-color: var(--bad); }
.timeline-step.gap { border-left: 1px dashed var(--accent); }
.timeline-step.gap::before { background: var(--accent); }
.gap-card { padding: 12px; background: var(--panel); border: 1px dashed rgb(var(--accent-rgb) / .5); border-radius: 3px; font-size: 12px; }
.timeline-step.supporting .step-group { outline: 2px solid var(--accent); outline-offset: 5px; border-radius: 3px; }
.observation.matching { outline: 2px solid var(--teal); outline-offset: 2px; }
.support-note { color: var(--accent); font-size: 11px; }
.data-definitions { display: grid; gap: 10px; font-size: 12px; }
.empty { padding: 30px 4px; color: var(--muted); }
.message { margin-top: 18px; border-left: 3px solid var(--accent); }
body:has(#status-text[data-kind=error]) .message { border-left-color: var(--bad); }
.message p { margin: 8px 0 16px; }
.sr-only, .skip-link:not(:focus) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip-link:focus { display: block; padding: 12px; color: var(--teal); }
@media (min-width: 1600px) { .shell { width: min(1440px,90%); } }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr 1fr; }.path-toolbar { flex-wrap: wrap; }.path-toolbar > div:first-child { width: 100%; }.path-layout { grid-template-columns: 260px minmax(0,1fr); }.filter-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }.metric-card { padding: 20px; } }
@media (max-width: 760px) {
  .explore-layout { grid-template-columns: 1fr; gap: 20px; }
  .compare-row { grid-template-columns: minmax(0,1fr) 68px 68px; }
  .shell { width: calc(100% - 28px); }.app-header { padding: 12px 14px; }.identity { gap: 9px; }.identity-note { display: none; }.header-actions { gap: 8px; }.preview { font-size: 9px; }.workspace-nav { gap: 24px; }.scope-bar { align-items: start; flex-direction: column; gap: 10px; }.scope-actions { width: 100%; }.scope-actions .inline-label { flex: 1 1 140px; flex-direction: column; align-items: stretch; gap: 4px; }.scope-actions select { width: 100%; max-width: 100%; min-height: 40px; }.scope-actions button { min-height: 40px; }.metric-controls label { flex: 1 1 140px; flex-direction: column; align-items: stretch; gap: 4px; }.metric-controls select { width: 100%; }.scope-actions { margin-left: 0; }.page-heading { align-items: start; gap: 12px; }.page-heading p { font-size: 12px; }.panel { padding: 17px; }.metrics-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.metric-card { padding: 17px; }.metric-card:nth-child(2) { border-right: 0; }.metric-card:nth-child(-n+2) { border-bottom: 1px solid var(--line); }.metric-value { font-size: 31px; }.overview-grid, .relationship-grid, .path-layout { grid-template-columns: 1fr; }.filter-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.trend-plot { height: 200px; }.section-heading { align-items: start; flex-wrap: wrap; }.section-heading > button { font-size: 11px; }.path-toolbar { gap: 12px; }.path-toolbar .search-label { max-width: none; flex: 1; min-width: 140px; }.path-toolbar .inline-label { max-width: 100%; }.path-toolbar select { max-width: 160px; }.route-master { margin-bottom: 0; }.route-detail { min-height: 0; }.step-heading { flex-wrap: wrap; gap: 4px; }.relationship-flow { gap: 6px; }.skill-node { font-size: 11px; }
}
@media (max-width: 900px) {
}
@media (max-width: 480px) {
}
@media (max-width: 760px) {
  .matrix th:first-child { width: 150px; }
  .matrix-scroll-hint { display: block; }
  .resource-scroll-hint { display: block; margin-bottom: 12px; }
  #route-list { max-height: 320px; overflow-y: auto; }
}
@media (prefers-reduced-motion: no-preference) { button, input, select, summary { transition: background-color .12s linear, border-color .12s linear, color .12s linear; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
`;

export const dashboardJs = 'const projectMetrics = ' + projectMetrics.toString() + ';\nconst contentMeasures = ' + JSON.stringify(contentMeasures) + ';\n' + String.raw`'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  requestId: 0, controller: null, filterQuery: '', report: null, pathModels: [], resources: { kind: 'unrequested' }, workspace: 'metrics', metricView: null,
  focus: { kind: 'all' }, routeKey: null, skillSelection: null,
  explore: { skillName: null, interval: null },
  trends: { kind: 'top', count: 5 },
  content: { kind: 'unrequested' }, contentRequestId: 0, contentInterval: null, contentExpanded: new Set(), contentDetail: null, contentTrends: { kind: 'top', count: 5 },
  contentMeasures: { resources: 'toolActivity', both: 'toolActivity' }, skillPresentation: { measure: 'successfulReads', split: 'skill', display: 'count' }, filterOptions: null,
  pages: { activity: 0, skills: 0, columns: 0, relationships: 0, routes: 0, steps: 0, catalog: 0, identities: 0, evidence: 0, resources: 0 },
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
const hostOrder = ['pi', 'claude-code', 'codex', 'opencode-v1', 'opencode-v2', 'unknown'];
const hostLabels = { pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex', 'opencode-v1': 'OpenCode v1', 'opencode-v2': 'OpenCode v2', unknown: 'Unknown host' };
const hostColors = { pi: '#9fc7f5', 'claude-code': '#f08a3c', codex: '#19c37d', 'opencode-v1': '#ffe08a', 'opencode-v2': '#ff85c2', unknown: '#aba8a1' };
const hostLabel = (host) => hostLabels[host] || host;
const hostColor = (host) => hostColors[host] || hostColors.unknown;
class DashboardFetchError extends Error {}
const pageLabels = { skills: 'skill rows', columns: 'comparison columns' };
const pageLabel = key => key === 'skills' && isContentView() ? 'item rows' : pageLabels[key] || key;
const motion = (() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const scopes = new Map(); const remembered = new WeakMap();
  const growEase = 'cubic-bezier(.25,.5,.6,1)';
  const visible = element => element.isConnected && element.getClientRects().length > 0 && element.getBoundingClientRect().height > 0;
  const damping = 30 / (2 * .7); const frequency = Math.sqrt(520 / .7 - damping * damping);
  const spring = Array.from({ length: 31 }, (_, index) => {
    const offset = index / 30; const time = offset * .45;
    const progress = index === 30 ? 1 : 1 - Math.exp(-damping * time) * (Math.cos(frequency * time) + damping / frequency * Math.sin(frequency * time));
    return { offset, progress };
  });
  function stop(scope) {
    const transaction = scopes.get(scope);
    if (!transaction) return;
    scopes.delete(scope);
    for (const animation of transaction.animations) { animation.onfinish = null; animation.oncancel = null; animation.cancel(); }
    for (const cleanup of transaction.cleanups) cleanup();
  }
  function cancel(scope) {
    for (const owner of [...scopes.keys()]) if (owner === scope || scope.contains(owner)) stop(owner);
  }
  function complete(scope, transaction) {
    if (scopes.get(scope) !== transaction || transaction.animations.size) return;
    scopes.delete(scope);
    for (const cleanup of transaction.cleanups) cleanup();
  }
  function play(scope, transaction, element, frames, options) {
    const animation = element.animate(frames, options);
    transaction.animations.add(animation);
    const release = () => { transaction.animations.delete(animation); complete(scope, transaction); };
    animation.onfinish = release; animation.oncancel = release;
  }
  function run(scope, build) {
    stop(scope);
    if (preference.matches || !scope.animate || !visible(scope)) return;
    const transaction = { animations: new Set(), cleanups: [] };
    scopes.set(scope, transaction);
    build((element, frames, options) => play(scope, transaction, element, frames, options), transaction.cleanups);
    complete(scope, transaction);
  }
  function changed(scope, signature) {
    if (!visible(scope)) return false;
    if (remembered.get(scope) === signature) return false;
    remembered.set(scope, signature); return true;
  }
  function capture(scope) {
    const items = new Map();
    for (const element of scope.querySelectorAll('[data-motion-key]')) {
      if (!visible(element)) continue;
      const fill = element.querySelector('.rank-fill');
      items.set(element.dataset.motionKey, { rect: element.getBoundingClientRect(), fill: fill?.getBoundingClientRect().width });
    }
    cancel(scope); return items;
  }
  function reflow(scope, before) {
    run(scope, animate => {
      for (const element of scope.querySelectorAll('[data-motion-key]')) {
        const previous = before.get(element.dataset.motionKey);
        if (!previous || !visible(element)) continue;
        const next = element.getBoundingClientRect(); const dx = previous.rect.left - next.left; const dy = previous.rect.top - next.top;
        if (Math.abs(dx) + Math.abs(dy) > .5) animate(element, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'translate(0,0)' }], { duration: 400, easing: 'cubic-bezier(.22,1,.36,1)' });
        const fill = element.querySelector('.rank-fill'); const width = fill?.getBoundingClientRect().width;
        if (fill && previous.fill !== undefined && Math.abs(previous.fill - width) > .5) animate(fill, [{ width: previous.fill + 'px' }, { width: width + 'px' }], { duration: 400, easing: growEase });
      }
    });
  }
  function marker(element, bounds, travel = true) {
    const signature = JSON.stringify(bounds);
    if (travel && !element.hidden && remembered.get(element) === signature) return;
    remembered.set(element, signature);
    const parent = element.parentElement; const parentRect = parent.getBoundingClientRect();
    const before = element.hidden ? null : element.getBoundingClientRect();
    cancel(element);
    element.hidden = bounds === null;
    if (!bounds) return;
    Object.assign(element.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
    if (!travel || !before || !before.width || !before.height || !bounds.width || !bounds.height) return;
    const dx = before.left - parentRect.left - parent.clientLeft - bounds.left; const dy = before.top - parentRect.top - parent.clientTop - bounds.top;
    const sx = before.width / bounds.width; const sy = before.height / bounds.height;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(before.width - bounds.width) + Math.abs(before.height - bounds.height) < .5) return;
    run(element, animate => animate(element, spring.map(({ offset, progress }) => ({ offset, transform: 'translate(' + dx * (1 - progress) + 'px,' + dy * (1 - progress) + 'px) scale(' + (sx + (1 - sx) * progress) + ',' + (sy + (1 - sy) * progress) + ')' })), { duration: 450, easing: 'linear' }));
  }
  function chart(scope) {
    const paths = [...scope.querySelectorAll('.trend-area')];
    const signature = JSON.stringify([presentation(), paths.map(path => [path.dataset.skill, path.getAttribute('d'), path.getAttribute('fill')])]);
    if (!changed(scope, signature)) return;
    run(scope, animate => paths.forEach((path, index) => animate(path, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: Math.min(550, 260 + path.getBoundingClientRect().width / 2.4), delay: Math.min(index * 12, 120), easing: growEase, fill: 'backwards' })));
  }
  function expand(element, before) {
    stop(element);
    const height = visible(element) ? element.getBoundingClientRect().height : 0;
    run(element, animate => {
      if (Math.abs(height - before) < 1) return;
      animate(element, [{ height: before + 'px', overflow: 'clip' }, { height: height + 'px', overflow: 'clip' }], { duration: 260, easing: growEase });
    });
  }
  function trace(scope) {
    const timeline = scope.querySelector('.timeline');
    if (!timeline || !changed(scope, scope.dataset.traceSignature)) return;
    run(scope, (animate, cleanups) => {
      const bounds = timeline.getBoundingClientRect(); const steps = [...timeline.querySelectorAll('.timeline-step')].slice(0, 6);
      if (!steps.length) return;
      const points = steps.map(step => { const box = step.getBoundingClientRect(); return { x: box.left - bounds.left + .5, y: box.top - bounds.top + 9.5 }; });
      const overlay = svgNode('svg', { class: 'timeline-trace', viewBox: '0 0 ' + bounds.width + ' ' + bounds.height, 'aria-hidden': 'true', focusable: 'false' });
      timeline.append(overlay); cleanups.push(() => overlay.remove());
      for (const [index, step] of steps.entries()) {
        if (step.classList.contains('gap')) continue;
        const point = points[index]; const previous = points[index - 1];
        const connected = index > 0 && !steps[index - 1].classList.contains('gap');
        const delay = index <= 1 ? 0 : 450 + (index - 2) * 150; const duration = index === 1 ? 450 : 420;
        const arrival = connected ? delay + duration : index === 0 ? 0 : 450 + (index - 1) * 150;
        if (connected) {
          const length = point.y - previous.y;
          const connector = svgNode('line', { class: 'timeline-connector', x1: previous.x, x2: point.x, y1: previous.y, y2: point.y, 'stroke-dasharray': length });
          const tip = svgNode('circle', { class: 'timeline-tip', r: 2.6, cx: previous.x, cy: previous.y });
          overlay.append(connector, tip);
          animate(connector, [{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration, delay, easing: 'linear', fill: 'backwards' });
          animate(tip, [{ transform: 'translateY(0px)', opacity: 0, offset: 0 }, { opacity: 1, offset: .01 }, { opacity: 1, offset: .99 }, { transform: 'translateY(' + length + 'px)', opacity: 0, offset: 1 }], { duration, delay, easing: 'linear', fill: 'backwards' });
        }
        const ring = svgNode('circle', { class: 'timeline-arrival', r: 7, cx: point.x, cy: point.y }); overlay.append(ring);
        animate(ring, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 550, delay: arrival, easing: 'ease-out' });
        const group = step.querySelector('.step-group');
        if (group) animate(group, [{ filter: 'brightness(1)' }, { filter: 'brightness(1.35)', offset: .25 }, { filter: 'brightness(1)' }], { duration: 300, delay: arrival, easing: 'ease-out' });
      }
    });
  }
  function cancelAll() { for (const scope of [...scopes.keys()]) cancel(scope); }
  preference.addEventListener('change', event => { if (event.matches) cancelAll(); });
  window.addEventListener('resize', () => { cancelAll(); updateWorkspaceMarker(false); updateRouteMarker(false); });
  document.addEventListener('focusin', event => {
    for (const scope of [...scopes.keys()]) if (scope !== event.target && scope.contains(event.target) && (scope.matches('details, #scope-panel, #explorer-panel'))) cancel(scope);
  });
  document.addEventListener('toggle', event => {
    if (!(event.target instanceof HTMLDetailsElement)) return;
    const details = event.target;
    const route = details.closest('#chain-view'); if (route) cancel(route);
    if (!details.open) { cancel(details); return; }
    const style = getComputedStyle(details); const summary = details.querySelector('summary');
    const closedHeight = summary.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    queueMicrotask(() => { if (details.open && details.isConnected && (!details.contains(document.activeElement) || document.activeElement === summary)) expand(details, closedHeight); });
  }, true);
  return { capture, reflow, marker, chart, expand, trace, cancel, cancelAll };
})();
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
    previous.setAttribute('aria-label', 'Previous ' + pageLabel(key)); next.setAttribute('aria-label', 'Next ' + pageLabel(key));
    controls.append(previous, next); wrap.append(controls);
  }
  return wrap;
}
function restorePagerFocus(key, direction) {
  const label = pageLabel(key);
  const target = document.querySelector('[aria-label="' + direction + ' ' + label + '"]:not(:disabled)') || document.querySelector('[aria-label$=" ' + label + '"]:not(:disabled)');
  target?.focus();
}
function pageItems(items, key, size) { state.pages[key] = Math.min(state.pages[key], Math.max(0, Math.ceil(items.length / size) - 1)); return items.slice(state.pages[key] * size, (state.pages[key] + 1) * size); }
function setOptions(select, label, options) {
  const current = select.value; const currentLabel = select.selectedOptions[0]?.textContent.replace(/ · unavailable$/, '') || current;
  const all = node('option', label); all.value = '';
  select.replaceChildren(all);
  for (const option of options) { const item = node('option', option.label); item.value = option.value; select.append(item); }
  if (current && !options.some((option) => option.value === current)) { const retained = node('option', currentLabel + ' · unavailable'); retained.value = current; retained.disabled = true; select.append(retained); }
  select.value = current;
}
function updateWorkspaceMarker(travel = true) {
  const nav = document.querySelector('.workspace-nav'); const active = nav.querySelector('[aria-current]');
  const bounds = nav.getBoundingClientRect(); const destination = active.getBoundingClientRect();
  motion.marker(nav.querySelector('.workspace-indicator'), { left: destination.left - bounds.left - nav.clientLeft, top: destination.bottom - bounds.top - nav.clientTop - 1, width: destination.width, height: 1 }, travel);
}
function updateRouteMarker(travel = true) {
  const list = $('route-list'); const parent = list.parentElement; const marker = parent.querySelector('.route-indicator');
  const selected = list.querySelector('.route-choice[aria-pressed="true"]'); const bounds = list.getBoundingClientRect(); const destination = selected?.getBoundingClientRect();
  if (!destination || bounds.height === 0 || destination.bottom <= bounds.top || destination.top >= bounds.bottom) { motion.marker(marker, null); return; }
  const box = parent.getBoundingClientRect();
  const top = Math.max(destination.top + 8, bounds.top); const bottom = Math.min(destination.bottom - 8, bounds.bottom);
  motion.marker(marker, { left: destination.left - box.left - parent.clientLeft + 1, top: top - box.top - parent.clientTop, width: 2, height: Math.max(0, bottom - top) }, travel);
}
function showWorkspace(name, focusHeading = false) {
  const changed = state.workspace !== name;
  state.workspace = name;
  for (const workspace of ['metrics', 'paths', 'resources']) { const element = $(workspace + '-workspace'); if (workspace !== name) motion.cancel(element); element.hidden = workspace !== name; }
  document.querySelectorAll('[data-workspace]').forEach((item) => {
    if (item.dataset.workspace === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  if (changed) updateWorkspaceMarker();
  if (state.report) {
    if (name === 'resources' && state.resources.kind === 'unrequested') void loadResources();
    else showWorkspaceStatus();
  }
  if (focusHeading) { const heading = $(name === 'paths' ? 'paths-heading' : name + '-heading'); heading.tabIndex = -1; heading.focus(); }
}
function setStatus(kind, text) { $('status-text').dataset.kind = kind; $('status-text').textContent = text; }
function showMessage(title, text, retry = false) {
  $('message-panel').hidden = false;
  $('message-panel').replaceChildren(node('h2', title));
  if (text) $('message-panel').append(node('p', text));
  if (retry) $('message-panel').append(button('Retry', loadDashboard));
}
function showMissingDatabase(databasePath) {
  $('dashboard-content').hidden = true; $('scope-summary').hidden = true;
  setStatus('missing', 'No database'); showMessage('No Hotplate database found', 'Check the database location and capture or collector configuration. Then refresh the dashboard.', true);
  $('message-panel').append(disclosure('Database location', node('p', databasePath)));
}
function showDashboardError(error) {
  $('dashboard-content').hidden = true; $('scope-summary').hidden = true;
  setStatus('error', 'Error'); showMessage('Cannot load dashboard', error instanceof DashboardFetchError ? 'Could not reach the dashboard server.' : undefined, true);
  $('message-panel').append(disclosure('Error details', node('p', error instanceof Error ? error.message : String(error))));
}
function showWorkspaceStatus() {
  if (state.workspace === 'metrics' && isContentView()) { renderScope(); $('message-panel').hidden = true; $('dashboard-content').hidden = false; renderContentStatus(); return; }
  if (state.workspace !== 'resources' || state.resources.kind === 'ready') {
    renderScope(); $('message-panel').hidden = true; $('dashboard-content').hidden = false;
    $('workspace').setAttribute('aria-busy', 'false'); setStatus('ready', 'Ready');
    if (state.workspace === 'metrics') motion.chart($('activity-chart'));
    if (state.workspace === 'paths') { updateRouteMarker(); motion.trace($('chain-view')); }
    return;
  }
  const resources = state.resources;
  $('workspace').setAttribute('aria-busy', String(resources.kind === 'loading'));
  if (resources.kind === 'missing') showMissingDatabase(resources.databasePath);
  else if (resources.kind === 'error') showDashboardError(resources.error);
  else {
    $('dashboard-content').hidden = true; $('scope-summary').hidden = true;
    setStatus('loading', 'Loading'); showMessage('Loading resources…');
  }
}
async function fetchDashboard(scope, query, signal) {
  const params = new URLSearchParams(query); params.set('scope', scope);
  const response = await fetch('/api/dashboard?' + params, { signal, headers: { Accept: 'application/json' } }).catch((error) => {
    if (error instanceof TypeError && ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'].includes(error.message)) throw new DashboardFetchError(error.message);
    throw error;
  });
  if (!response.ok) throw new Error('Dashboard request failed (HTTP ' + response.status + ').');
  const payload = await response.json();
  if (!payload || !['ready', 'missing', 'error'].includes(payload.kind)) throw new Error('Unexpected dashboard response.');
  if (payload.kind === 'ready') {
    if ('scope' in payload && payload.scope !== scope) throw new Error('Unexpected dashboard response scope.');
    if (!payload.filterOptions || !['hosts', 'machines', 'projects'].every(key => Array.isArray(payload.filterOptions[key]))) throw new Error('The dashboard filters are unavailable.');
    if (scope === 'skills' && (!payload.report || !Array.isArray(payload.report.skillGroups) || !Array.isArray(payload.report.routes))) throw new Error('The dashboard report is unavailable.');
    if (scope === 'resources' && (!Array.isArray(payload.resources?.rows) || !Array.isArray(payload.resourceCoverage?.rows))) throw new Error('The resource report is unavailable.');
  }
  return payload;
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
  for (const id of ['skill-search', 'route-search', 'catalog-search', 'route-model', 'resource-search', 'resource-kind', 'resource-observation']) $(id).value = '';
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
  cancelContentRequest(); state.content = { kind: 'unrequested' }; state.contentInterval = null; state.contentDetail = null; state.contentTrends = { kind: 'top', count: 5 };
  motion.cancel($('dashboard-content'));
  const requestId = ++state.requestId;
  state.controller?.abort(); state.controller = new AbortController();
  if (state.resources.kind === 'loading') state.resources.controller.abort();
  state.resources = { kind: 'unrequested' };
  state.filterQuery = filterParams().toString();
  state.report = null;
  $('scope-summary').hidden = true; $('scope-summary').textContent = '';
  $('dashboard-content').hidden = true; $('workspace').setAttribute('aria-busy', 'true');
  setStatus('loading', 'Loading');
  showMessage('Loading activity…');
  try {
    const payload = await fetchDashboard('skills', state.filterQuery, state.controller.signal);
    if (requestId !== state.requestId) return;
    state.filterOptions = payload.filterOptions; renderFilterOptions(payload.filterOptions);
    if (payload.kind === 'missing') {
      showMissingDatabase(payload.databasePath); return;
    }
    if (payload.kind === 'error') throw new Error(payload.message);
    state.report = payload.report;
    const models = [...state.report.models];
    for (const measure of ['uses', 'invocationFailures']) for (const series of projectMetrics(state.report, { measure, split: 'model', display: 'count' }).series) { if (series.attribution !== 'none' && !models.some(column => sameModel(column.model, series.model))) models.push({ model: series.model }); }
    state.pathModels = models;
    resetSelections();
    setOptions($('route-model'), 'All models', state.pathModels.map((column, index) => ({ value: String(index), label: modelLabel(column.model) })));
    renderMetrics(); renderPaths();
    if (state.workspace === 'resources') void loadResources();
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.report = null; showDashboardError(error);
  } finally {
    if (requestId === state.requestId) {
      if (state.report) showWorkspaceStatus();
      else $('workspace').setAttribute('aria-busy', 'false');
    }
  }
}
async function loadResources() {
  if (!state.report || state.resources.kind !== 'unrequested') return;
  const requestId = state.requestId;
  const controller = new AbortController();
  state.resources = { kind: 'loading', controller };
  showWorkspaceStatus();
  try {
    const payload = await fetchDashboard('resources', state.filterQuery, controller.signal);
    if (requestId !== state.requestId) return;
    if (payload.kind === 'missing') state.resources = { kind: 'missing', databasePath: payload.databasePath };
    else {
      if (payload.kind === 'error') throw new Error(payload.message);
      state.resources = { kind: 'ready', rows: payload.resources.rows, coverage: payload.resourceCoverage.rows };
      renderResources();
    }
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.resources = { kind: 'error', error };
  } finally {
    if (requestId === state.requestId && state.workspace === 'resources') showWorkspaceStatus();
  }
}
function renderFilterOptions(options) {
  if (!options) return;
  const pairs = options.agentModelPairs || [];
  const modelValue = (model) => model === null ? 'unknown' : JSON.stringify([model.provider, model.id]);
  const selectedHost = $('host-filter').value; const selectedModel = $('model-filter').value;
  const rank = (host) => { const index = hostOrder.indexOf(host); return index === -1 ? hostOrder.length : index; };
  setOptions($('host-filter'), 'All agents', [...(options.hosts || [])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(value => ({ value, label: hostLabel(value) })));
  const models = [...new Map(pairs.map(pair => [modelValue(pair.model), pair.model])).entries()];
  setOptions($('model-filter'), 'All models', models.map(([value, model]) => ({ value, label: modelLabel(model) })));
  for (const option of $('host-filter').options) if (option.value) {
    option.disabled = !options.hosts.includes(option.value) || Boolean(selectedModel && !pairs.some(pair => pair.host === option.value && modelValue(pair.model) === selectedModel));
    option.textContent = hostLabel(option.value) + (option.disabled ? ' · unavailable' : '');
  }
  for (const option of $('model-filter').options) if (option.value) {
    option.disabled = !models.some(([value]) => value === option.value) || Boolean(selectedHost && !pairs.some(pair => pair.host === selectedHost && modelValue(pair.model) === option.value));
    const found = models.find(([value]) => value === option.value);
    option.textContent = (found ? modelLabel(found[1]) : option.value === 'unknown' ? 'Unknown model' : option.textContent.replace(/ · unavailable$/, '')) + (option.disabled ? ' · unavailable' : '');
  }
  for (const [id, label, values] of [['machine-filter', 'All machines', options.machines], ['project-filter', 'All projects', options.projects]]) setOptions($(id), label, values.map(value => ({ value, label: value })));
}
function renderScope() {
  const scope = state.report.scope;
  const parts = [];
  if (scope.fromObservedAt || scope.toObservedAt) parts.push((scope.fromObservedAt || 'First record') + ' to ' + (scope.toObservedAt || 'Latest record') + ' · UTC');
  if (scope.projectCwd) parts.push('Project: ' + scope.projectCwd);
  if (scope.host) parts.push('Agent host: ' + hostLabel(scope.host));
  if (scope.machineId) parts.push('Machine: ' + scope.machineId);
  if (scope.source) parts.push((commandLabels[scope.source] || scope.source) + ' requests');
  if (scope.modelSelection) parts.push('Model: ' + (scope.modelSelection.kind === 'unknown' ? 'Unknown model' : modelLabel(scope.modelSelection.model)));
  if (scope.modelProvider) parts.push('Model provider: ' + scope.modelProvider);
  if (scope.modelId) parts.push('Model: ' + scope.modelId);
  $('scope-summary').textContent = parts.join(' · ');
  $('scope-summary').hidden = parts.length === 0;
}
function renderMetrics() {
  if (isContentView()) { loadContentAnalytics(); return; }
  $('overview-cards').hidden = false; $('evidence-context').hidden = false;
  updateMetricProjection();
  const report = state.report;
  const metrics = [
    ['Successful reads', report.counts.successfulReads],
    ['Skill names read', report.skillsRead],
    ['Session paths', scopedRoutes().length, 'Known runs and unassigned events'],
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
  renderActivity(); renderExplore(); renderRelationships(); renderCatalog(); renderSkillDetail();
  const coverage = report.coverage;
  $('evidence-context').append(node('span', count(coverage.captureGaps, 'capture gap') + ' · ' + count(coverage.droppedObservations, 'record') + ' lost · ' + count(coverage.filteredOmissions, 'record') + ' hidden by filters'));
}
function svgNode(tag, attrs) { const item = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value)); return item; }
function mountTimeBrush(plot, activity, readout, onChange, onReadout) {
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
  plot.setAttribute('aria-label', (isContentView() ? 'Content trends. Drag' : 'Skill trends. Drag') + ' to select dates. Arrow keys inspect intervals. Enter selects. Shift extends. Escape clears.');
  let selected = null; let gesture = null; let focus = { kind: 'summary', index: activity.bins.length - 1 };
  function publish(announce = false) {
    onReadout(focus.kind === 'inspection' ? { kind: 'inspection', index: focus.index } : selected === null ? { kind: 'displayed' } : { kind: 'selected', interval: interval(...selected) }, announce);
  }
  function summarize() { focus = { kind: 'summary', index: focus.index }; publish(); }
  function commit(value, extend = false) { focus = { kind: 'summary', index: focus.index }; onChange(value, extend); }
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
    paint(selected); summarize();
  }
  plot.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || gesture !== null) return;
    motion.cancel($('activity-chart'));
    summarize();
    const anchor = position(event); let mode = event.target.dataset.mode || 'create';
    if (selected && (mode === 'start' || mode === 'end')) mode = Math.abs(anchor - selected[0]) < Math.abs(anchor - selected[1]) ? 'start' : 'end';
    gesture = { mode, anchor, range: selected, pointer: event.pointerId };
    plot.dataset.pointer = 'true'; plot.setPointerCapture(event.pointerId); plot.focus({ preventScroll: true });
    paint(mode === 'create' ? [anchor, anchor] : selected, true);
  });
  plot.addEventListener('pointermove', (event) => {
    if (gesture !== null && event.pointerId !== gesture.pointer) return;
    const step = position(event);
    if (gesture !== null) { paint(preview(step), true); return; }
    focus = { kind: 'inspection', source: 'pointer', index: Math.min(activity.bins.length - 1, Math.floor(step * stepMs / activity.binWidthMs)) }; publish();
  });
  plot.addEventListener('pointerleave', () => { if (focus.kind === 'inspection' && focus.source === 'pointer') summarize(); });
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
    commit(interval(from, to), event.shiftKey && mode === 'create');
  });
  plot.addEventListener('pointercancel', cancel); plot.addEventListener('lostpointercapture', cancel);
  plot.addEventListener('blur', () => { delete plot.dataset.pointer; summarize(); });
  plot.addEventListener('keydown', (event) => {
    motion.cancel($('activity-chart'));
    delete plot.dataset.pointer;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (gesture !== null) cancel();
      else { commit(null); plot.focus({ preventScroll: true }); }
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
      commit(interval(from, to)); return;
    }
    if (event.target !== plot) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? activity.bins.length - 1 : clamp(focus.index + (event.key === 'ArrowLeft' ? -1 : 1), 0, activity.bins.length - 1);
      focus = { kind: 'inspection', source: 'keyboard', index }; publish(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); const bin = activity.bins[focus.index]; commit({ startAt: bin.startAt, endAt: bin.endAt }, event.shiftKey);
    }
  });
  return (value) => {
    const next = value === null ? null : [(Date.parse(value.startAt) - start) / stepMs, (Date.parse(value.endAt) - start) / stepMs];
    if (selected?.[0] !== next?.[0] || selected?.[1] !== next?.[1]) focus = { kind: 'summary', index: focus.index };
    selected = next; paint(selected); publish();
  };
}
const metricUnit = () => ({ successfulReads: 'read', inferredReads: 'inferred read', toolActivity: 'tool record', activity: 'record', fsOpens: 'filesystem open', fsAccesses: 'filesystem access' })[presentation().measure] || measureLabels[presentation().measure].toLowerCase().replace(/s$/, '');
const metricCount = value => count(value, metricUnit(), presentation().measure === 'fsAccesses' ? 'filesystem accesses' : undefined);
const measureLabels = { failedReads: 'Read failures', uses: 'Skill uses', invocations: 'Native invocations', invocationFailures: 'Invocation failures', readAttempts: 'Read attempts', requests: 'Requests', wrappers: 'Wrappers', ...Object.fromEntries(Object.entries(contentMeasures).map(([key, value]) => [key, value.label])), get successfulReads() { return isContentView() ? contentMeasures.successfulReads.label : 'Successful reads'; } };
const contentMode = () => $('metric-content').value;
const isContentView = () => contentMode() !== 'skills';
const contentReport = () => state.content.kind === 'unrequested' ? null : state.content.report;
const activeInterval = () => isContentView() ? state.contentInterval : state.explore.interval;
const activeTrends = () => isContentView() ? state.contentTrends : state.trends;
function setActiveTrends(value) { if (isContentView()) state.contentTrends = value; else state.trends = value; }
const skillMeasureOptions = Array.from($('metric-measure').options, option => ({ value: option.value, label: option.textContent }));
function configureContentControls() {
  const content = isContentView();
  const options = content ? Object.entries(contentMeasures).filter(([, item]) => contentMode() === 'both' || item.resources).map(([value, item]) => ({ value, label: item.label })) : skillMeasureOptions;
  const selected = content ? state.contentMeasures[contentMode()] : state.skillPresentation.measure;
  $('metric-measure').replaceChildren(...options.map(({ value, label }) => { const option = node('option', label); option.value = value; return option; }));
  $('metric-measure').value = selected;
  $('metric-display').value = content ? 'count' : state.skillPresentation.display;
  $('metric-display').disabled = content;
  $('tool-coverage').hidden = !content || state.content.kind !== 'ready';
  $('metric-split').querySelector('[value="skill"]').textContent = content ? 'Item / total ranking' : 'Skill / total ranking';
  $('metrics-heading').textContent = contentMode() === 'skills' ? 'Skill metrics' : contentMode() === 'resources' ? 'Resource metrics' : 'Skill and resource metrics';
  $('skills-heading').textContent = contentMode() === 'skills' ? 'Compare skills' : contentMode() === 'resources' ? 'Compare resources' : 'Compare skills and resources';
  $('comparison-note').textContent = '';
  $('skill-search').placeholder = contentMode() === 'skills' ? 'Find a skill…' : contentMode() === 'resources' ? 'Find a resource…' : 'Find a skill or resource…';
  $('skill-search').previousElementSibling.textContent = $('skill-search').placeholder.replace('…', '');
  $('skill-table').setAttribute('aria-label', content ? 'Content comparison' : 'Skill comparison');
  for (const id of ['read-patterns', 'catalog-context']) $(id).hidden = content;
  $('content-detail').hidden = true; $('content-status').hidden = true;
  if (content) { $('explorer-panel').hidden = true; $('skill-detail').hidden = true; }
}
function cancelContentRequest() {
  if (state.content.kind === 'loading') state.content.controller.abort();
  state.contentRequestId += 1;
}
function contentParams() {
  const params = new URLSearchParams(state.filterQuery);
  params.set('content', contentMode()); params.set('measure', $('metric-measure').value);
  params.set('split', $('metric-split').value === 'skill' ? 'item' : $('metric-split').value);
  if (state.contentInterval) { params.set('selectionFrom', state.contentInterval.startAt); params.set('selectionTo', state.contentInterval.endAt); }
  return params;
}
function renderContentStatus() {
  const status = $('content-status'); const content = state.content;
  $('tool-coverage').hidden = !isContentView() || content.kind !== 'ready';
  status.hidden = content.kind === 'ready'; status.replaceChildren();
  if (content.kind === 'loading') status.append(node('span', state.contentInterval ? 'Loading selected counts…' : 'Loading content activity…'));
  if (content.kind === 'error') status.append(node('span', content.error), button('Retry content activity', () => loadContentAnalytics(Boolean(content.report)), 'quiet'));
  if (state.workspace !== 'metrics') return;
  $('workspace').setAttribute('aria-busy', String(content.kind === 'loading'));
  setStatus(content.kind === 'loading' ? 'loading' : content.kind === 'error' ? 'error' : 'ready', content.kind === 'loading' ? 'Loading' : content.kind === 'error' ? 'Error' : 'Ready');
}
async function loadContentAnalytics(retainChart = false) {
  if (!state.report || !isContentView()) return;
  const previous = retainChart ? contentReport() : null;
  cancelContentRequest(); const requestId = state.contentRequestId; const controller = new AbortController();
  const params = contentParams();
  state.content = { kind: 'loading', controller, report: previous };
  $('overview-cards').hidden = true; $('evidence-context').hidden = true; $('content-detail').hidden = true;
  $('skill-table').replaceChildren(empty('Loading counts…')); $('comparison-pagination').replaceChildren(); $('comparison-scroll-hint').hidden = true;
  if (!previous) { motion.cancel($('activity-chart')); $('activity-chart').replaceChildren(empty('Loading activity…')); activityView = null; }
  renderContentStatus(); updateActivitySelection();
  try {
    if (retainChart) await new Promise(resolve => {
      const cancel = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve(); }, 140);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    if (requestId !== state.contentRequestId || controller.signal.aborted) return;
    const response = await fetch('/api/content-analytics?' + params, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Content request failed (HTTP ' + response.status + ').');
    const payload = await response.json();
    if (requestId !== state.contentRequestId || !isContentView()) return;
    if (payload.kind === 'missing') throw new Error('No Hotplate database found.');
    if (payload.kind === 'error') throw new Error(payload.message);
    if (payload.kind !== 'ready' || !Array.isArray(payload.report?.selection?.rows) || !Array.isArray(payload.report?.displayed?.series)) throw new Error('The content report is unavailable.');
    const sameChart = previous !== null && JSON.stringify(previous.displayed) === JSON.stringify(payload.report.displayed);
    if (previous && !sameChart && presentation().split === 'skill') state.contentTrends = { kind: 'custom', names: displayedTrendNames() };
    state.content = { kind: 'ready', report: payload.report };
    renderFilterOptions(payload.report.filterOptions);
    renderContentMetrics(!sameChart);
  } catch (error) {
    if (requestId !== state.contentRequestId || !isContentView()) return;
    state.content = { kind: 'error', report: previous, error: error instanceof TypeError ? 'Could not reach the dashboard server.' : error.message };
    $('skill-table').replaceChildren(empty('Content counts are unavailable. Retry to load this selection.'));
    renderContentStatus(); updateActivitySelection();
  }
}
function contentMetricView(report) {
  return { series: report.displayed.series.map(series => ({ ...series, attribution: series.modelAttribution })),
    timeline: report.displayed.activity.kind === 'bucketed' ? report.displayed.activity.bins : [], undatedCount: report.overall.undatedCount };
}
function renderContentMetrics(redraw = true) {
  const report = contentReport(); state.metricView = contentMetricView(report);
  const p = presentation(); document.querySelector('.overview-grid').classList.toggle('matrix-layout', p.split !== 'skill');
  $('metric-explanation').textContent = p.measure === 'toolActivity' ? 'Agent tool reads, attempts, failures, and native invocations. Repeated operations count separately.'
    : p.measure === 'activity' ? 'All recorded evidence, including filesystem activity, requests, and wrappers. Catalog polling can appear here.'
    : p.measure === 'readAttempts' ? 'Unconfirmed tool read attempts. The outcome is unknown.'
    : p.measure === 'fsOpens' || p.measure === 'fsAccesses' ? 'Filesystem observations. Repeated events count separately.'
    : p.measure === 'successfulReads' ? 'Successful native read results. Returned portions can be unknown.'
    : p.measure === 'inferredReads' ? 'Recognized literal read commands with successful tool outcomes. Returned portions can be unknown.' : measureLabels[p.measure] + ' in the selected content.';
  const summary = report.selection;
  const entries = [[measureLabels[p.measure], number(summary.count)], ['Compared items', number(summary.rows.filter(row => row.count > 0).length)],
    ['Latest evidence (UTC)', summary.lastEvidenceAt ? timeLabel(summary.lastEvidenceAt) : 'None'], ['Read failures', number(summary.counts.failedReads)]];
  $('overview-cards').hidden = false;
  $('overview-cards').replaceChildren(...entries.map(([label, value]) => { const card = node('article', null, 'metric-card'); card.append(node('span', label, 'metric-label'), node('strong', value, label.startsWith('Latest') ? 'content-latest' : 'metric-value')); return card; }));
  $('evidence-context').hidden = false; $('evidence-context').replaceChildren();
  for (const [key, value] of Object.entries(summary.counts)) if (value && (p.measure !== 'toolActivity' || !['fsOpens', 'fsAccesses', 'requests', 'wrappers'].includes(key))) $('evidence-context').append(node('span', number(value) + ' ' + measureLabels[key].toLowerCase()));
  renderToolCoverage(report.coverage.selection);
  if (redraw) renderActivity();
  renderContentComparison(); renderContentDetail(); renderContentStatus(); updateActivitySelection();
}
function renderToolCoverage(coverage) {
  const target = $('tool-coverage-content'); target.replaceChildren();
  $('tool-coverage-summary').textContent = coverage.observedOperations
    ? 'Tool coverage · ' + count(coverage.observedOperations, 'observed operation') + ' · ' + number(coverage.opaqueOperations) + ' with unresolved file access'
    : 'Tool coverage · not reported in this scope';
  if (!coverage.observedOperations) {
    target.append(node('p', 'Historical reads can have no coverage record. Missing coverage does not mean that all reads were captured.'));
    return;
  }
  target.append(node('p', count(coverage.recognizedOperations, 'recognized operation') + ' · ' + count(coverage.outcomes.unknown, 'unknown outcome') + ' · ' + count(coverage.outcomes.error, 'failed operation')));
  const reasons = { 'unsupported-syntax': 'Unsupported command syntax', 'missing-input': 'Input unavailable', 'unsupported-tool': 'Unsupported tool', limit: 'Recognition limit' };
  for (const [key, value] of Object.entries(coverage.opaqueReasons)) if (value) target.append(node('p', reasons[key] + ': ' + number(value)));
  target.append(node('p', 'Only observed tool operations are counted. Unresolved file access is not assigned to a skill or resource. Coverage completeness is unknown.'));
}
function contentRowPath(row) { return row.identity.kind === 'skill' ? row.identity.canonicalPath || '' : row.identity.location.canonicalPath; }
function contentRowMatches(row, query) { return [row.label, contentRowPath(row), row.identity.kind === 'skill' ? row.identity.name : row.identity.location.machineId].some(value => value.toLowerCase().includes(query)); }
function contentRowName(row, child = false) {
  if (child && row.identity.kind === 'skill') return 'Skill evidence · ' + hostLabel(row.identity.host);
  if (!child || row.identity.kind !== 'file' || !row.identity.ownerSkillPath) return row.label;
  const root = row.identity.ownerSkillPath.slice(0, -'SKILL.md'.length);
  return row.identity.location.canonicalPath.startsWith(root) ? row.identity.location.canonicalPath.slice(root.length) : row.label;
}
function contentRowAction(row, child = false) {
  const name = node('div', null, 'content-name');
  if (row.children.length) {
    const expanded = state.contentExpanded.has(row.key) || Boolean($('skill-search').value.trim());
    const toggle = button(expanded ? '▾' : '▸', () => { if (state.contentExpanded.has(row.key)) state.contentExpanded.delete(row.key); else state.contentExpanded.add(row.key); renderContentComparison(); }, 'quiet content-toggle');
    toggle.disabled = Boolean($('skill-search').value.trim());
    toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + row.label); toggle.setAttribute('aria-expanded', String(expanded)); name.append(toggle);
  }
  const title = node('div', null, 'content-label'); title.append(button(contentRowName(row, child), () => selectContentDetail(row), 'link'));
  if (!child) {
    const identity = row.identity; const location = identity.kind === 'skill' ? identity : identity.location;
    const duplicate = contentReport().selection.rows.some(other => other.key !== row.key && other.label === row.label);
    const context = identity.kind === 'skill' ? ['Unresolved file association', hostLabel(identity.host), ...(location.canonicalPath ? [location.canonicalPath] : [])] : [location.canonicalPath];
    if (duplicate) context.push(location.machineId, location.sourceId);
    title.append(node('div', context.join(' · '), 'content-location'));
  }
  name.append(title); return name;
}
function renderContentComparison() {
  if (state.content.kind !== 'ready') return;
  const report = contentReport(); const query = $('skill-search').value.trim().toLowerCase();
  const rows = report.selection.rows.filter(row => row.count > 0 && (!query || contentRowMatches(row, query) || row.children.some(child => contentRowMatches(child, query))));
  $('skills-heading').textContent = contentMode() === 'resources' ? 'Compare resources' : 'Compare skills and resources';
  $('comparison-note').textContent = contentMode() === 'both' ? 'Expand a skill to compare its files. Parent totals include their children once. Select a count for evidence and location details.' : 'All files with matching activity, including SKILL.md. Select a count for evidence and location details.';
  const target = $('skill-table'); const before = motion.capture(target); target.replaceChildren(); const pager = $('comparison-pagination'); pager.replaceChildren();
  const split = presentation().split; $('comparison-scroll-hint').hidden = split === 'skill';
  if (!rows.length) {
    $('comparison-scroll-hint').hidden = true; target.append(empty(query ? 'No skills or resources match this search.' : metricEmptyText()));
    if (state.report.scope.source) target.append(button('Clear command source filter', () => { $('source-filter').value = ''; loadDashboard(); }, 'link'));
    target.append(button('View resource inventory', () => showWorkspace('resources', true), 'link')); return;
  }
  const max = Math.max(1, ...rows.map(row => row.count));
  const page = pageItems(rows, 'skills', split === 'skill' ? 8 : 12);
  const visible = page.flatMap(row => [{ row, child: false }, ...(row.children.length && (state.contentExpanded.has(row.key) || query) ? row.children.filter(child => !query || contentRowMatches(row, query) || contentRowMatches(child, query)).map(child => ({ row: child, child: true })) : [])]);
  if (split === 'skill') {
    for (const { row, child } of visible) {
      const line = node('div', null, 'rank-row' + (child ? ' content-child' : '')); line.dataset.contentKey = row.key; line.dataset.motionKey = row.key;
      line.append(node('span', child ? '↳' : '', 'rank-number'));
      const name = node('div'); name.append(contentRowAction(row, child));
      if (row.identity.kind === 'file' && !row.identity.ownerSkillPath) name.append(node('div', 'No owning skill', 'content-location'));
      const track = node('div', null, 'rank-track'); const fill = node('div', null, 'rank-fill'); fill.style.width = row.count / max * 100 + '%'; track.append(fill); name.append(track);
      const value = node('strong'); value.append(button(number(row.count), () => selectContentDetail(row), 'link')); line.append(name, value); target.append(line);
    }
  } else {
    const columns = pageItems(report.displayed.series, 'columns', 6);
    const matrix = table(['Item', ...columns.map(series => trendName(series.key))], measureLabels[presentation().measure] + ' by item and ' + split.replace('-', ' + ')); matrix.className = 'matrix';
    const maximum = Math.max(1, ...rows.flatMap(row => row.cells.map(cell => cell.count)));
    for (const { row, child } of visible) {
      const line = node('tr', null, child ? 'content-child' : ''); line.dataset.contentKey = row.key; line.dataset.motionKey = row.key;
      const heading = node('th'); heading.scope = 'row'; heading.append(contentRowAction(row, child)); line.append(heading);
      for (const column of columns) {
        const cell = row.cells.find(value => value.key === column.key);
        const value = cell?.count || 0; const item = node('td');
        const action = button(number(value), () => selectContentDetail(row, column), 'heat-' + (value ? Math.max(1, Math.ceil(value / maximum * 4)) : 0));
        action.setAttribute('aria-label', row.label + ', ' + trendName(column.key) + ': ' + metricCount(value)); item.append(action); line.append(item);
      }
      matrix.lastChild.append(line);
    }
    target.append(matrix); if (report.displayed.series.length > 6) pager.append(pagination('columns', report.displayed.series.length, 6, renderContentComparison));
  }
  pager.append(pagination('skills', rows.length, split === 'skill' ? 8 : 12, renderContentComparison)); motion.reflow(target, before);
}
function emptyContentStats() { return { count: 0, counts: {}, firstEvidenceAt: null, lastEvidenceAt: null, attributionCounts: {} }; }
function selectContentDetail(row, series = null) {
  state.contentDetail = { rowKey: row.key, columnKey: series?.key || null }; renderContentDetail();
  $('content-detail').tabIndex = -1; $('content-detail').focus(); $('content-detail').scrollIntoView({ block: 'nearest' });
}
function renderContentDetail() {
  const target = $('content-detail'); target.replaceChildren(); target.hidden = true;
  if (!isContentView() || state.content.kind !== 'ready' || !state.contentDetail) return;
  const report = contentReport(); const rows = report.selection.rows.flatMap(row => [row, ...row.children]);
  const row = rows.find(value => value.key === state.contentDetail.rowKey);
  if (!row) {
    const series = report.displayed.series.find(value => value.key === state.contentDetail.rowKey);
    if (series) { target.hidden = false; target.append(node('h2', series.label), empty('No matching evidence in the selected dates.')); }
    return;
  }
  const column = report.displayed.series.find(value => value.key === state.contentDetail.columnKey);
  const stats = column ? row.cells.find(value => value.key === column.key) || emptyContentStats() : row;
  target.hidden = false; const heading = node('div', null, 'section-heading');
  heading.append(node('h2', row.identity.kind === 'skill' ? row.label + ' · ' + hostLabel(row.identity.host) : row.label, 'content-detail-heading'), button('Close details', () => { state.contentDetail = null; target.hidden = true; }, 'quiet')); target.append(heading);
  target.append(node('p', measureLabels[presentation().measure] + (column ? ' · ' + trendName(column.key) : '') + ': ' + number(stats.count)));
  if (state.contentInterval) target.append(node('p', intervalLabel(state.contentInterval.startAt, state.contentInterval.endAt) + ' UTC', 'footnote'));
  const breakdown = node('div', null, 'content-breakdown');
  for (const [key, label] of Object.entries(contentMeasures)) if (key !== 'activity' && key !== 'toolActivity' && (contentMode() === 'both' || label.resources)) { const value = node('div'); value.append(node('strong', number(stats.counts[key] || 0)), node('span', label.label)); breakdown.append(value); }
  target.append(breakdown);
  const identity = row.identity; const location = identity.kind === 'skill' ? identity : identity.location;
  for (const [label, value] of [['File', location.canonicalPath || 'Not recorded in skill evidence'], ['Machine', location.machineId], ['Account source', location.sourceId], ['Filesystem', identity.kind === 'skill' ? 'Not recorded in skill evidence' : location.filesystemId]]) target.append(node('p', label + ': ' + value, 'content-location'));
  if (identity.kind === 'skill') target.append(node('p', 'Observed path: Not recorded in skill evidence', 'content-location'));
  if (identity.kind === 'file') target.append(node('p', 'Observed path: ' + identity.observedPath, 'content-location'), node('p', 'Owning skill: ' + (identity.ownerSkillPath || 'None'), 'content-location'));
  if (identity.kind === 'owner') target.append(node('p', 'Select a file to see requested and returned portions.', 'footnote'));
  else if (stats.readDetails?.groups.length) {
    target.append(node('h3', 'Read portions'));
    const portions = table(['Evidence', 'Count', 'Requested', 'Returned', 'Revision'], 'Requested and returned file portions');
    for (const group of stats.readDetails.groups) {
      const returned = group.delivery.kind === 'unknown' ? 'Unknown' : portionLabel(group.delivery.returned) + (group.delivery.truncated ? ' · Truncated' : ' · Not truncated');
      const line = node('tr');
      for (const value of [measureLabels[group.category], number(group.count), portionLabel(group.requested), returned, group.revision.kind === 'unknown' ? 'Unknown' : group.revision.value]) line.append(node('td', value));
      portions.tBodies[0].append(line);
    }
    const wrapper = node('div', null, 'table-wrap'); wrapper.tabIndex = 0; wrapper.setAttribute('aria-label', 'Read portion details'); wrapper.append(portions); target.append(wrapper);
    if (stats.readDetails.omittedCount) target.append(node('p', count(stats.readDetails.omittedCount, 'additional read') + ' omitted from this portion summary.', 'footnote'));
  }
  target.append(node('p', 'First evidence: ' + (stats.firstEvidenceAt ? timeLabel(stats.firstEvidenceAt) + ' UTC' : 'None in this selection'), 'content-location'), node('p', 'Latest evidence: ' + (stats.lastEvidenceAt ? timeLabel(stats.lastEvidenceAt) + ' UTC' : 'None in this selection'), 'content-location'));
  const attributions = { session: 'Session attributed', harness: 'Agent attributed', unknown: 'Unknown attribution', 'non-agent': 'Non-agent', none: 'No attribution' };
  target.append(node('p', Object.entries(stats.attributionCounts).filter(([, value]) => value).map(([key, value]) => attributions[key] + ': ' + number(value)).join(' · '), 'footnote'));
}
function portionLabel(portion) {
  if (portion.kind === 'unknown') return 'Unknown';
  if (portion.kind === 'whole') return 'Whole file';
  if (portion.count === null) return 'Lines ' + number(portion.start) + ' onward';
  if (portion.count === 0) return 'No lines from ' + number(portion.start);
  return portion.count === 1 ? 'Line ' + number(portion.start) : 'Lines ' + number(portion.start) + '–' + number(portion.start + portion.count - 1);
}
function changeContentMode() {
  cancelContentRequest(); state.content = { kind: 'unrequested' }; state.contentInterval = null; state.contentExpanded.clear(); state.contentDetail = null; state.contentTrends = { kind: 'top', count: 5 };
  $('skill-search').value = ''; state.pages.skills = 0; state.pages.columns = 0;
  configureContentControls();
  if (!isContentView()) { $('metric-split').value = state.skillPresentation.split; if (state.filterOptions) renderFilterOptions(state.filterOptions); renderMetrics(); showWorkspaceStatus(); }
  else loadContentAnalytics();
}

function presentation() { return { measure: $('metric-measure').value, split: $('metric-split').value, display: $('metric-display').value }; }
function updateMetricProjection() {
  const p = presentation();
  document.querySelector('.overview-grid').classList.toggle('matrix-layout', p.split !== 'skill');
  $('metric-display').querySelector('[value="session-share"]').disabled = p.measure !== 'uses';
  if (p.measure !== 'uses') $('metric-display').value = 'count';
  state.metricView = projectMetrics(state.report, presentation());
  const notes = { successfulReads: 'Repeated successful reads count separately.', uses: 'Successful reads, successful native invocations, and unconfirmed read attempts. Failures are excluded.', failedReads: 'Reads with a recorded error.', invocations: 'Successful native skill invocations.', invocationFailures: 'Native invocations with a recorded error.', readAttempts: 'Unconfirmed read attempts. The outcome is unknown.', requests: 'Recorded skill commands. Requests have no model attribution.', wrappers: 'Skill text found in input. Wrappers have no model attribution.' };
  $('metric-explanation').textContent = notes[p.measure] + (p.measure !== 'successfulReads' ? ' Date selections below explore successful reads in the same interval.' : '');
}
function trendKey(series) { return !isContentView() && presentation().split === 'skill' ? series.label : series.key; }
function trendName(key) { const series = state.metricView.series.find(series => trendKey(series) === key); if (!series) return key; if (isContentView() && (presentation().split === 'skill' || series.actor !== 'agent')) return series.label; return presentation().split === 'agent' ? hostLabel(series.host) : presentation().split === 'agent-model' ? hostLabel(series.host) + ' · ' + (series.attribution === 'none' ? 'No model attribution' : modelLabel(series.model)) : series.label; }
function metricActivity() {
  const original = isContentView() ? contentReport().displayed.activity : state.report.activity;
  if (original.kind === 'empty') return original;
  return { ...original, bins: state.metricView.timeline.map((bin, index) => ({ ...original.bins[index], skills: state.metricView.series.map(series => ({ name: trendKey(series), successfulReads: bin.values.find(value => value.key === series.key)?.count || 0 })), metricCount: bin.count })) };
}
function availableTrendNames() { return state.metricView.series.map(trendKey); }
function displayedTrendNames() {
  if ($('metric-split').value !== 'skill') return availableTrendNames();
  const trends = activeTrends(); return trends.kind === 'top' ? availableTrendNames().slice(0, trends.count) : trends.names;
}
function addTrend(name) {
  const names = displayedTrendNames();
  if (!names.includes(name)) state.trends = { kind: 'custom', names: [...names, name] };
}
function skillColor(name) {
  if (!skillColors.has(name)) {
    const palette = ['#19c37d', '#f08a3c', '#ff85c2', '#7dffb5', '#ffe08a', '#9fc7f5', '#b7cf78', '#d5b1ed', '#69c6bd', '#f3b49c', '#b8b4a8', '#c59f69'];
    const index = skillColors.size;
    skillColors.set(name, palette[index] || 'hsl(' + ((index * 137.508) % 360).toFixed(3) + ' 58% ' + (60 + index % 3 * 8) + '%)');
  }
  return skillColors.get(name);
}
const chartWidth = 600; const chartHeight = 240;
function chartAxis(activity) {
  const hourly = activity.binWidthMs < 86400000;
  const axis = node('div', null, 'chart-axis');
  axis.append(node('span', date(activity.startAt, hourly)), node('span', date(hourly ? activity.endAt : new Date(Date.parse(activity.endAt) - 1).toISOString(), hourly)));
  return axis;
}
function drawScale(scale, svg, maximum) {
  const ticks = [...new Set([maximum, Math.floor(maximum / 2), 0])];
  scale.replaceChildren(...ticks.map(value => {
    const tick = node('span', number(value));
    tick.style.top = (1 - value / maximum) * 100 + '%';
    tick.style.transform = value === maximum ? '' : value === 0 ? 'translateY(-100%)' : 'translateY(-50%)';
    return tick;
  }));
  for (const value of ticks) {
    const y = chartHeight - value / maximum * chartHeight;
    svg.append(svgNode('line', { x1: 0, x2: chartWidth, y1: y, y2: y, class: 'gridline' }));
  }
}
function stepPath(activity, lower, upper, maximum) {
  const start = Date.parse(activity.startAt); const duration = Date.parse(activity.endAt) - start;
  const x = at => Math.max(0, Math.min(chartWidth, (Date.parse(at) - start) / duration * chartWidth));
  const y = value => chartHeight - value / maximum * chartHeight;
  const edge = values => activity.bins.flatMap((bin, index) => [[x(bin.startAt), y(values[index])], [x(bin.endAt), y(values[index])]]);
  return [...edge(upper), ...edge(lower).reverse()].map((point, index) => (index ? 'L ' : 'M ') + point.join(' ')).join(' ') + ' Z';
}
function cursorOffset(activity, bin) {
  return ((Date.parse(bin.startAt) + Date.parse(bin.endAt)) / 2 - Date.parse(activity.startAt)) / (Date.parse(activity.endAt) - Date.parse(activity.startAt)) * 100 + '%';
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
  const catalog = isContentView() ? availableTrendNames() : [...new Set([...state.report.skillGroups.map(group => group.name), ...displayedTrendNames()])].sort((a, b) => a.localeCompare(b));
  catalog.forEach(skillColor);
  controls.hidden = catalog.length === 0;
  const chooser = node('details', null, 'trend-chooser');
  const summary = node('summary');
  const searchLabel = node('label', isContentView() ? 'Find an item' : 'Find a skill', 'search-label');
  const search = node('input'); search.type = 'search'; search.placeholder = isContentView() ? 'Search item names' : 'Search skill names'; searchLabel.append(search);
  const results = node('div', null, 'trend-options');
  const status = node('p', null, 'sr-only'); status.setAttribute('role', 'status');
  let limit = 20;
  function choices() {
    const names = displayedTrendNames();
    const candidates = catalog.filter(name => (isContentView() ? trendName(name) : name).toLowerCase().includes(search.value.toLowerCase()));
    results.replaceChildren();
    for (const name of candidates.slice(0, limit)) {
      const label = node('label', null, 'trend-option');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.skill = name; checkbox.checked = names.includes(name);
      const swatch = node('span', null, 'trend-swatch'); swatch.style.setProperty('--skill-color', skillColor(name));
      checkbox.addEventListener('change', () => {
        const current = displayedTrendNames();
        setActiveTrends({ kind: 'custom', names: checkbox.checked ? [...new Set([...current, name])] : current.filter(value => value !== name) });
        updateActivitySelection();
        status.textContent = trendName(name) + (checkbox.checked ? ' added to chart.' : ' removed from chart.');
      });
      label.append(checkbox, swatch, node('span', isContentView() ? trendName(name) : name)); results.append(label);
    }
    if (!candidates.length) results.append(empty(isContentView() ? 'No items match this search.' : 'No skills match this search.'));
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
    summary.textContent = (isContentView() ? 'Items (' : 'Skills (') + names.length + ')';
    results.querySelectorAll('input').forEach(checkbox => { checkbox.checked = names.includes(checkbox.dataset.skill); });
  };
}
function metricEmptyText() { return 'No ' + measureLabels[presentation().measure].toLowerCase() + (hasFilters() ? ' match these filters.' : ' recorded yet.'); }
function appendModelRecovery(target) { if (state.report.scope.modelSelection && ['requests', 'wrappers'].includes(presentation().measure)) { target.append(node('p', measureLabels[presentation().measure] + ' have no model attribution.', 'footnote'), button('Show all models', () => { $('model-filter').value = ''; loadDashboard(); })); } }
function renderActivity() {
  const target = $('activity-chart'); motion.cancel(target); target.replaceChildren(); activityView = null;
  const report = state.report; const activity = metricActivity();
  const updateControls = $('metric-split').value === 'skill' ? mountTrendControls(target) : () => {}; updateControls();
  if (activity.kind !== 'empty' && !state.metricView.series.length && presentation().split !== 'skill') { activityView = updateControls; target.append(empty(metricEmptyText())); appendModelRecovery(target); return; }
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
    const scale = node('div', null, 'trend-scale');
    layout.append(scale, plot, chartAxis(activity));
    const noTrends = empty((state.metricView.series.length || activeTrends().kind === 'custom' && presentation().split === 'skill') ? (isContentView() ? 'Select items to show their activity.' : 'Select skills to show their activity.') : metricEmptyText()); target.append(noTrends);
    const readout = node('p', null, 'trend-readout'); const rangeReadout = node('p', null, 'brush-range');
    const announcement = node('p', null, 'sr-only'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
    const explanation = node('p', measureLabels[presentation().measure] + ' per UTC interval', 'small muted');
    const noReads = node('p', 'No ' + measureLabels[presentation().measure].toLowerCase() + ' in this period.', 'footnote');
    target.append(explanation, layout, noReads, labels, readout, rangeReadout, announcement);
    const scroll = node('div', null, 'table-wrap'); const details = disclosure('View activity data', scroll); target.append(details);
    let shown = [];
    function showReadout(focus, announce = false) {
      const range = focus.kind === 'inspection' ? activity.bins[focus.index] : focus.kind === 'selected' ? focus.interval : activity;
      const scope = (focus.kind === 'inspection' ? 'Interval' : focus.kind === 'selected' ? 'Selected range' : 'Displayed range') + ' · ' + intervalLabel(range.startAt, range.endAt) + ' UTC';
      let counts;
      if (focus.kind === 'inspection') counts = binSkills[focus.index];
      else if (isContentView()) {
        counts = focus.kind === 'selected' && state.content.kind !== 'ready' ? null : new Map((focus.kind === 'selected' ? contentReport().selection.series : contentReport().displayed.series).map(series => [series.key, series.datedCount]));
      }
      else {
        let view = state.metricView;
        if (focus.kind === 'selected') {
          const routes = report.routes.map(route => ({ ...route, steps: route.steps.map(step => step.kind === 'observations' ? { ...step, items: step.items.filter(item => inInterval(item.observedAt, range)) } : step) }));
          view = projectMetrics({ ...report, routes }, presentation());
        }
        const names = new Map(view.series.map(series => [series.key, trendKey(series)])); counts = new Map();
        for (const bin of view.timeline) for (const value of bin.values) {
          const name = names.get(value.key); counts.set(name, (counts.get(name) || 0) + value.count);
        }
      }
      cursor.hidden = focus.kind !== 'inspection';
      if (!cursor.hidden) cursor.style.left = cursorOffset(activity, range);
      readout.textContent = scope + ' · ' + (counts === null ? state.content.kind === 'error' ? 'Selected counts unavailable' : 'Loading selected counts…' : metricCount(shown.reduce((total, name) => total + (counts.get(name) || 0), 0)));
      labels.querySelectorAll('.trend-label').forEach((label, row) => {
        const value = counts === null ? state.content.kind === 'error' ? 'Unavailable' : 'Loading…' : metricCount(counts.get(shown[row]) || 0);
        label.querySelector('small').textContent = value;
        label.title = trendName(shown[row]) + ': ' + value + ' · ' + scope;
      });
      announcement.textContent = announce ? readout.textContent + '. ' + Array.from(labels.querySelectorAll('.trend-label'), (label) => label.title).join('. ') : '';
    }
    function renderData() {
      const data = table(['UTC interval', ...shown.map(trendName), 'Total'], measureLabels[presentation().measure] + ' in each UTC interval.'); data.className = 'activity-data';
      pageItems(activity.bins, 'activity', 24).forEach((bin, offset) => {
        const index = state.pages.activity * 24 + offset;
        const row = node('tr'); const cell = node('td');
        const action = button(intervalLabel(bin.startAt, bin.endAt), (event) => selectActivityBin(index, event.shiftKey), 'link activity-choice');
        action.dataset.bin = index; action.setAttribute('aria-pressed', String(activeInterval() !== null && bin.startAt >= activeInterval().startAt && bin.endAt <= activeInterval().endAt));
        action.setAttribute('aria-label', 'Select ' + intervalLabel(bin.startAt, bin.endAt) + ' UTC'); cell.append(action); row.append(cell);
        for (const name of shown) {
          row.append(node('td', binSkills[index].get(name) || 0));
        }
        row.append(node('td', bin.metricCount));
        data.lastChild.append(row);
      });
      scroll.replaceChildren(data, pagination('activity', activity.bins.length, 24, renderData));
    }
    details.addEventListener('toggle', () => { if (details.open) renderData(); });
    const setRange = mountTimeBrush(plot, activity, rangeReadout, selectExploreInterval, showReadout);
    activityView = (selection) => {
      updateControls();
      const names = displayedTrendNames();
      noTrends.hidden = names.length > 0;
      noReads.hidden = names.length === 0 || activity.bins.some((bin, index) => names.some(name => (binSkills[index].get(name) || 0) > 0));
      for (const element of [layout, labels, explanation, readout, rangeReadout]) element.hidden = names.length === 0;
      if (JSON.stringify(names) !== JSON.stringify(shown) || !svg.firstChild) {
        shown = names; labels.replaceChildren(); svg.replaceChildren();
        const stack = buildStack(activity, names);
        svg.setAttribute('viewBox', '0 0 ' + chartWidth + ' ' + chartHeight);
        const title = svgNode('title', { id: 'activity-title' }); title.textContent = measureLabels[presentation().measure];
        const description = svgNode('desc', { id: 'activity-description' }); description.textContent = 'Stacked areas show ' + measureLabels[presentation().measure].toLowerCase() + ' in each UTC interval. Exact counts follow in the data table.';
        svg.append(title, description);
        drawScale(scale, svg, stack.maximum);
        for (const layer of stack.layers) {
          const series = state.metricView.series.find(series => trendKey(series) === layer.name);
          const color = presentation().split === 'agent' && series ? hostColor(series.host) : skillColor(layer.name); const label = presentation().split === 'skill' ? button('', () => { if (isContentView()) { if (state.content.kind === 'ready') selectContentDetail({ key: layer.name }); } else if (presentation().measure === 'successfulReads') selectExploreSkill(layer.name); else { const row = comparisonView().skills.find(row => row.name === layer.name) || state.metricView.skills.find(row => row.name === layer.name); if (row) selectMetricSkill(row, row, null); } }, 'trend-label') : node('div', null, 'trend-label');
          label.dataset.skill = layer.name; label.style.setProperty('--skill-color', color); label.append(node('span', trendName(layer.name)), node('small')); labels.append(label);
          svg.append(svgNode('path', { d: stepPath(activity, layer.lower, layer.upper, stack.maximum), fill: color, class: 'trend-area', 'data-skill': layer.name }));
        }
        motion.chart(target);
        if (details.open) renderData();
        else scroll.replaceChildren();
      }
      labels.querySelectorAll('.trend-label').forEach((label) => label.setAttribute('aria-pressed', String(label.dataset.skill === selection.skillName)));
      setRange(selection.interval);
    };
  }
  if (state.metricView.undatedCount > 0) target.append(node('p', count(state.metricView.undatedCount, 'matching record') + (isContentView() ? ' without a usable timestamp. Available in the full comparison, omitted from the trend and date selections.' : ' without a usable timestamp. Included in comparison, omitted from the trend.'), 'footnote'));
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
  if (isContentView()) {
    const current = state.contentInterval;
    state.contentInterval = extend && interval && current ? { startAt: interval.startAt < current.startAt ? interval.startAt : current.startAt, endAt: interval.endAt > current.endAt ? interval.endAt : current.endAt } : interval;
    state.pages.skills = 0; state.pages.columns = 0; loadContentAnalytics(true); return;
  }
  const current = state.explore.interval;
  state.explore.interval = extend && interval && current ? {
    startAt: interval.startAt < current.startAt ? interval.startAt : current.startAt,
    endAt: interval.endAt > current.endAt ? interval.endAt : current.endAt,
  } : interval;
  renderExplore();
}
function selectActivityBin(index, extend = false) {
  const bin = metricActivity().bins[index];
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
  const interval = activeInterval();
  $('view-explorer').hidden = isContentView() || !interval && !state.explore.skillName;
  activityView?.(isContentView() ? { interval, skillName: null } : state.explore);
  $('activity-chart').querySelectorAll('.activity-choice').forEach((action) => {
    const bin = metricActivity().bins[Number(action.dataset.bin)];
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
  $('route-model').value = model === undefined ? '' : String(state.pathModels.findIndex((column) => sameModel(column.model, model)));
  renderPaths(); showWorkspace('paths', true);
  if (routeKey !== null) { $('chain-view').focus(); $('chain-view').scrollIntoView({ block: 'nearest' }); }
}
function renderComparison() {
  const target = $('explore-comparison'); const before = motion.capture(target); target.replaceChildren();
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
    row.dataset.motionKey = name;
    const action = button(name, () => selectExploreSkill(name), 'link'); action.setAttribute('aria-pressed', String(name === state.explore.skillName)); row.append(action);
    for (const snapshot of [current, previous]) {
      const paths = snapshot.bySkill.get(name) || 0;
      const value = node('span', null, 'compare-value');
      value.append(node('span', Math.round(paths / snapshot.readRuns * 100) + '%'), node('small', count(paths, 'path'))); row.append(value);
    }
    target.append(row);
  }
  target.append(node('p', 'Each percent uses the recorded read-bearing paths in that period. Select a skill to inspect its paths.', 'footnote'));
  motion.reflow(target, before);
}
function renderExplore() {
  if (isContentView()) return;
  const selection = state.explore; const active = selection.skillName !== null || selection.interval !== null;
  const panel = $('explorer-panel'); const before = panel.hidden ? 0 : panel.getBoundingClientRect().height; motion.cancel(panel); panel.hidden = !active;
  state.pages.skills = 0; renderSkillComparison(); updateActivitySelection();
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
  motion.expand(panel, before);
}
function comparisonView() {
  if (!state.explore.interval && !state.explore.skillName) return state.metricView;
  const matching = state.explore.skillName && presentation().measure === 'successfulReads' ? new Set(explorationSnapshot(state.explore.interval, state.explore.skillName).paths.map(entry => entry.route.key)) : null;
  const routes = state.report.routes.filter(route => !matching || matching.has(route.key)).map(route => ({ ...route, steps: route.steps.map(step => step.kind === 'observations' ? { ...step, items: step.items.filter(item => inInterval(item.observedAt, state.explore.interval)) } : step) }));
  return projectMetrics({ ...state.report, routes }, presentation());
}
function selectMetricSkill(row, cell, series) {
  state.skillSelection = { kind: 'metric-skill', name: row.name, routeKeys: cell.routeKeys, query: { presentation: { ...presentation() }, cellKey: series?.key ?? null, interval: state.explore.interval }, label: measureLabels[presentation().measure] + (series ? ' · ' + series.label : '') + ': ' + (presentation().display === 'session-share' ? shareText(cell.share) + ' of eligible sessions' : number(cell.count)) };
  state.pages.identities = 0; renderSkillDetail(); showWorkspace('metrics'); $('skill-detail').tabIndex = -1; $('skill-detail').focus();
}
function renderSkillComparison() {
  if (isContentView()) { renderContentComparison(); return; }
  const query = $('skill-search').value.toLowerCase(); const p = presentation(); const view = comparisonView();
  const share = p.display === 'session-share';
  $('comparison-scroll-hint').hidden = p.split === 'skill';
  const rows = view.skills.filter(row => (share ? row.sessions > 0 : row.count > 0) && row.name.toLowerCase().includes(query));
  $('skills-heading').textContent = 'Compare skills';
  $('comparison-note').textContent = share ? 'Sessions with this skill use / sessions with any skill use in each cohort. Models use their own session denominator. A session can appear under several models. Exact recorded skill names retain plugin prefixes.' : 'Exact recorded skill names. Select a count for matching records and paths.';
  const target = $('skill-table'); const before = motion.capture(target); target.replaceChildren();
  const pager = $('comparison-pagination'); pager.replaceChildren();
  if (!rows.length) { $('comparison-scroll-hint').hidden = true; target.append(empty(query ? noResults('skills', query) : metricEmptyText())); appendModelRecovery(target); if (state.report.skillGroups.some(group => group.cataloged)) target.append(button('View skill catalog', () => { $('catalog-context').open = true; $('catalog-context').querySelector('summary').focus(); }, 'link')); return; }
  if (p.split === 'skill') {
    const max = Math.max(1, ...rows.map(row => share ? row.share || 0 : row.count));
    for (const [index, row] of pageItems(rows, 'skills', 8).entries()) {
      const line = node('div', null, 'rank-row' + (state.explore.skillName === row.name ? ' selected' : '')); line.dataset.motionKey = row.name; line.append(node('span', String(state.pages.skills * 8 + index + 1).padStart(2, '0'), 'rank-number'));
      const name = node('div'); const action = button(row.name, () => p.measure === 'successfulReads' && !share ? selectExploreSkill(row.name) : selectMetricSkill(row, row, null), 'link'); action.setAttribute('aria-pressed', String(state.explore.skillName === row.name)); name.append(action);
      const track = node('div', null, 'rank-track'); const fill = node('div', null, 'rank-fill'); fill.style.width = (share ? row.share || 0 : row.count) / max * 100 + '%'; track.append(fill); name.append(track);
      const value = node('strong'); value.append(button(share ? shareText(row.share) : number(row.count), () => selectMetricSkill(row, row, null), 'link')); line.append(name, value); target.append(line);
    }
  } else {
    const columns = pageItems(view.series, 'columns', 6);
    const matrix = table(['Skill', ...columns.map(column => trendName(column.key))], (share ? 'Session share' : measureLabels[p.measure]) + ' by skill and ' + p.split.replace('-', ' + ')); matrix.className = 'matrix';
    const max = Math.max(1, ...rows.flatMap(row => row.cells.map(cell => share ? cell.share || 0 : cell.count)));
    for (const row of pageItems(rows, 'skills', 12)) {
      const line = node('tr'); line.dataset.motionKey = row.name; const heading = node('th'); heading.scope = 'row'; heading.append(button(row.name, () => selectMetricSkill(row, row, null), 'link')); line.append(heading);
      for (const column of columns) {
        const cell = row.cells.find(cell => cell.key === column.key) || { count: 0, sessions: 0, eligibleSessions: column.eligibleSessions, share: column.eligibleSessions ? 0 : null, routeKeys: [] };
        const value = share ? cell.share : cell.count; const text = share ? shareText(value) : number(value);
        const item = node('td'); const action = button(text, () => selectMetricSkill(row, cell, { ...column, label: trendName(column.key) }), 'heat-' + (value ? Math.max(1, Math.ceil(value / max * 4)) : 0));
        action.setAttribute('aria-label', row.name + ', ' + trendName(column.key) + ': ' + (share ? text + ' of eligible sessions (' + cell.sessions + '/' + cell.eligibleSessions + ')' : count(value, measureLabels[p.measure].toLowerCase().replace(/s$/, ''))));
        if (value === null) action.title = 'No eligible sessions'; item.append(action); line.append(item);
      }
      matrix.lastChild.append(line);
    }
    target.append(matrix);
    if (view.series.length > 6) pager.append(pagination('columns', view.series.length, 6, renderSkillComparison));
  }
  pager.append(pagination('skills', rows.length, p.split === 'skill' ? 8 : 12, renderSkillComparison));
  motion.reflow(target, before);
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
  state.skillSelection = { kind: 'skill', name }; state.pages.identities = 0; renderSkillDetail(); showWorkspace('metrics');
  $('skill-detail').tabIndex = -1; $('skill-detail').focus();
}
const resourceObservationLabels = { observed: 'Observed', 'not-observed': 'No observed agent access', unknown: 'Unknown' };
const resourceKindLabels = { skill: 'Skill', principle: 'Principle', reference: 'Reference', script: 'Script', file: 'File' };
function resourceBadge(label, status) {
  const badge = node('span', label, 'resource-state'); badge.dataset.state = status; return badge;
}
function renderResourceCoverage() {
  const rows = state.resources.coverage;
  const target = $('resource-coverage-content'); target.replaceChildren();
  const states = new Map();
  for (const row of rows) states.set(row.status, (states.get(row.status) || 0) + 1);
  $('resource-coverage-summary').textContent = 'Observation coverage' + (rows.length ? ' · ' + [...states].map(([status, value]) => number(value) + ' ' + status).join(' · ') : ' · unknown');
  if (!rows.length) {
    target.append(empty('No observer has reported coverage in this scope. Files without access records remain unknown.'));
    return;
  }
  const reasons = { 'permission-denied': 'Permission denied', unsupported: 'Unavailable on this system', 'helper-unavailable': 'Observer helper unavailable', 'queue-overflow': 'Events were dropped', 'process-exited': 'Observer process exited', 'io-error': 'Observation failed' };
  for (const row of rows) {
    const item = node('div', null, 'resource-coverage-row');
    const details = node('div'); details.append(node('strong', row.rootPath, 'resource-path'));
    details.append(node('p', (row.mechanism === 'fanotify' ? 'Filesystem' : 'Agent tools') + ' · ' + row.machineId + ' · Last report ' + date(row.lastObservedAt, true) + ' UTC', 'resource-meta'));
    if (row.reason || row.status === 'stale') details.append(node('p', row.status === 'stale' ? 'No recent heartbeat. Current coverage is unknown.' : reasons[row.reason], 'resource-meta'));
    item.append(details, resourceBadge(row.status[0].toUpperCase() + row.status.slice(1), row.status)); target.append(item);
  }
}
function renderResources() {
  if (state.resources.kind !== 'ready') return;
  const all = state.resources.rows;
  const observed = all.filter(row => row.observation === 'observed').length;
  const untouched = all.filter(row => row.observation === 'not-observed').length;
  $('resource-summary').textContent = count(all.length, 'file') + ' · ' + number(observed) + ' observed · ' + number(untouched) + ' with no observed agent access · ' + number(all.length - observed - untouched) + ' unknown';
  renderResourceCoverage();
  const query = $('resource-search').value.trim().toLowerCase();
  const kind = $('resource-kind').value;
  const observation = $('resource-observation').value;
  const rows = all.filter(row => (!kind || row.resource.kind === kind) && (!observation || row.observation === observation)
    && (!query || [row.resource.canonicalPath, row.resource.observedPath, row.resource.ownerSkillPath || '', row.machineId].some(value => value.toLowerCase().includes(query))));
  const target = $('resource-table'); target.replaceChildren();
  $('resource-controls').hidden = all.length === 0;
  $('resource-evidence-note').hidden = rows.length === 0;
  $('resource-scroll-hint').hidden = rows.length === 0;
  if (!rows.length) {
    target.append(empty(all.length ? 'No files match these resource filters.' : 'No resource inventory or access has been recorded in this scope.'));
    if (all.length) target.append(button('Clear resource filters', () => { for (const id of ['resource-search', 'resource-kind', 'resource-observation']) $(id).value = ''; state.pages.resources = 0; renderResources(); }));
    $('resource-pagination').replaceChildren();
    return;
  }
  const listing = table(['File', 'Observation', 'Confirmed', 'Inferred', 'Failures', 'Attempts', 'Opens', 'Accesses', 'Attribution', 'Last access'], 'Inventory and access evidence');
  listing.className = 'resource-table';
  for (const row of pageItems(rows, 'resources', 25)) {
    const item = node('tr'); item.dataset.resourceId = row.resourceId; item.dataset.observation = row.observation;
    const file = node('td'); file.append(node('div', row.resource.canonicalPath, 'resource-path'));
    file.append(node('span', resourceKindLabels[row.resource.kind] + ' · ' + (row.presence === 'present' ? 'Present in inventory' : row.presence === 'absent' ? 'Absent in latest complete inventory' : 'Presence unknown'), 'resource-meta'));
    if (row.resource.ownerSkillPath) file.append(node('span', 'Owner: ' + row.resource.ownerSkillPath, 'resource-meta'));
    const audit = node('div');
    audit.append(node('p', 'Machine: ' + row.machineId), node('p', 'Source: ' + row.sourceId), node('p', 'Observed path: ' + row.resource.observedPath), node('p', 'Roots: ' + row.rootPaths.join(', ')));
    audit.append(node('p', row.firstInventoriedAt ? 'First inventoried: ' + date(row.firstInventoriedAt, true) + ' UTC' : 'No inventory record'), node('p', row.lastInventoriedAt ? 'Last seen in inventory: ' + date(row.lastInventoriedAt, true) + ' UTC' : ''));
    file.append(disclosure('File details', audit)); item.append(file);
    const status = node('td'); status.append(resourceBadge(resourceObservationLabels[row.observation], row.observation));
    if (row.observation === 'not-observed') status.append(node('span', 'Covered ' + date(row.coverageFrom, true) + ' to ' + date(row.coverageTo, true) + ' UTC', 'resource-meta'));
    else if (row.observation === 'unknown') status.append(node('span', row.unattributedAccessCount ? 'Access could not be assigned to this scope.' : 'Availability or observation coverage is incomplete.', 'resource-meta'));
    item.append(status);
    for (const value of [row.successfulReadCount, row.inferredReadCount, row.failedReadCount, row.attemptCount, row.openCount, row.accessCount]) item.append(node('td', number(value)));
    const attribution = node('td');
    for (const [label, value] of [['Agent', row.attributedAccessCount], ['Unknown', row.unattributedAccessCount], ['Non-agent', row.nonAgentAccessCount]]) attribution.append(node('span', label + ': ' + number(value), 'resource-meta'));
    const lastAccess = node('td'); lastAccess.append(node('span', row.lastAccessAt ? date(row.lastAccessAt, true) + ' UTC' : 'None observed', 'resource-meta'));
    item.append(attribution, lastAccess);
    listing.tBodies[0].append(item);
  }
  target.append(listing);
  $('resource-pagination').replaceChildren(pagination('resources', rows.length, 25, renderResources));
}

function renderSkillDetail() {
  const target = $('skill-detail'); target.replaceChildren();
  const selection = state.skillSelection;
  const group = state.report.skillGroups.find((entry) => entry.name === selection?.name);
  target.hidden = !group;
  if (!group) return;
  const heading = node('div', null, 'section-heading'); heading.append(node('h2', group.name), button('View session paths', () => { state.focus = selection?.kind === 'metric-skill' ? { kind: 'metric', name: group.name, label: selection.label, routeKeys: selection.routeKeys, query: selection.query } : { kind: 'skill', name: group.name }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = ''; renderPaths(); showWorkspace('paths', true); })); target.append(heading);
  target.append(node('p', selection?.kind === 'metric-skill' ? selection.label : countsText(group.counts), 'detail-counts'));
  const identities = node('div', null, 'identity-list');
  identities.append(node('p', 'Files with the same skill name can have different content.', 'small'));
  if (selection?.kind === 'metric-skill') identities.append(node('p', 'These files and counts cover this skill in the current report scope.', 'footnote'));
  const variants = group.skillKeys.map((key) => state.report.skills.find((entry) => entry.key === key)).filter(Boolean);
  for (const variant of pageItems(variants, 'identities', 8)) {
    const item = node('div', null, 'identity-item'); item.dataset.machine = variant.identity.machineId;
    item.append(node('p', 'Agent host: ' + hostLabel(variant.identity.host) + ' · Machine: ' + variant.identity.machineId), node('p', variant.identity.kind === 'resolved' ? variant.identity.canonicalPath : 'Skill name not linked to a file'), node('p', countsText(variant.counts)), node('p', variant.cataloged ? 'In recorded catalog' : 'Not in recorded catalog'));
    identities.append(item);
  }
  identities.append(pagination('identities', variants.length, 8, renderSkillDetail));
  target.append(disclosure('Files and requests · ' + count(variants.length, 'entry', 'entries'), identities));
}
function shareText(value) { return value === null ? '—' : value === 0 ? '0%' : value < 0.005 ? '<1%' : value < 1 && value >= 0.995 ? '>99%' : Math.round(value * 100) + '%'; }
function selectRelationship(relationship) {
  state.focus = { kind: 'relationship', relationship, evidenceIndex: 0 }; state.pages.routes = 0; state.pages.evidence = 0;
  state.routeKey = relationship.evidence[0]?.routeKey || null;
  state.pages.steps = Math.floor((relationship.evidence[0]?.stepIndex ?? relationship.evidence[0]?.fromStepIndex ?? 0) / 30);
  $('route-search').value = ''; $('route-model').value = ''; renderPaths(); showWorkspace('paths', true);
}
function scopedRoutes() { const scope = state.report.scope; return state.report.routes.filter(route => !(scope.modelSelection || scope.modelProvider || scope.modelId || scope.source) || route.steps.some(step => step.kind === 'observations' && step.items.length > 0)); }
function matchingRoutes() {
  const report = state.report; let keys = null;
  if (state.focus.kind === 'skill') keys = new Set(report.skillGroups.find((group) => group.name === state.focus.name)?.routeKeys || []);
  if (state.focus.kind === 'relationship') keys = new Set(state.focus.relationship.evidence.map((entry) => entry.routeKey));
  if (state.focus.kind === 'explore') keys = new Set(explorationSnapshot(state.explore.interval, state.explore.skillName).paths.map((entry) => entry.route.key));
  if (state.focus.kind === 'metric') keys = new Set(state.focus.routeKeys);
  const query = $('route-search').value.toLowerCase(); const modelIndex = $('route-model').value; const model = modelIndex === '' ? undefined : state.pathModels[Number(modelIndex)]?.model;
  if (model !== undefined && state.focus.kind === 'metric') {
    const focus = state.focus;
    const routes = report.routes.map(route => ({ ...route, steps: route.steps.map(step => step.kind === 'observations' ? { ...step, items: step.items.filter(item => 'model' in item.evidence && sameModel(item.evidence.model, model) && inInterval(item.observedAt, focus.query.interval)) } : step) }));
    const row = projectMetrics({ ...report, routes }, focus.query.presentation).skills.find(row => row.name === focus.name);
    const matching = new Set(focus.query.cellKey === null ? row?.routeKeys || [] : row?.cells.find(cell => cell.key === focus.query.cellKey)?.routeKeys || []);
    keys = new Set([...keys].filter(key => matching.has(key)));
  }
  return scopedRoutes().filter((route) => {
    if (keys && !keys.has(route.key)) return false;
    if (model !== undefined && state.focus.kind !== 'metric' && !route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => 'model' in item.evidence && sameModel(item.evidence.model, model)
      && (state.focus.kind !== 'skill' || skillName(item.skillKey) === state.focus.name)
      && (state.focus.kind !== 'explore' || (item.evidence.kind === 'read-result' && item.evidence.outcome === 'success' && inInterval(item.observedAt, state.explore.interval)
        && (state.explore.skillName === null || item.evidence.skill.name === state.explore.skillName)))))) return false;
    return !query || route.scope.projectCwd.toLowerCase().includes(query) || route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => skillName(item.skillKey).toLowerCase().includes(query)));
  });
}
function renderPaths() {
  const routes = matchingRoutes();
  const label = state.focus.kind === 'skill' ? 'Paths containing ' + state.focus.name : state.focus.kind === 'metric' ? 'Paths containing ' + state.focus.name + ' · ' + state.focus.label : state.focus.kind === 'relationship' ? 'Paths with this pattern' : state.focus.kind === 'explore' ? 'Paths in exploration' : 'All session paths';
  $('path-focus-label').textContent = label;
  $('back-to-explorer').hidden = state.focus.kind !== 'explore';
  $('route-count').textContent = count(routes.length, 'path');
  if (!routes.some((route) => route.key === state.routeKey)) { state.routeKey = routes[0]?.key || null; state.pages.steps = 0; }
  const target = $('route-list'); const before = motion.capture(target); target.replaceChildren();
  for (const route of pageItems(routes, 'routes', 8)) {
    const choice = button('', () => { state.routeKey = route.key; state.pages.steps = 0; renderPaths(); $('chain-view').focus(); }, 'route-choice');
    choice.dataset.routeKey = route.key; choice.dataset.motionKey = route.key; choice.setAttribute('aria-pressed', String(route.key === state.routeKey));
    choice.append(node('strong', project(route.scope.projectCwd)), node('p', date(route.lastEvidenceAt, true) + ' UTC'), node('p', count(route.counts.successfulReads, 'read') + ' · ' + count(route.steps.length, 'step')));
    const names = [...new Set(route.steps.flatMap((step) => step.kind === 'observations' ? step.items.map((item) => skillName(item.skillKey)) : []))];
    choice.append(node('p', names.slice(0, 4).join(' · ') + (names.length > 4 ? ' …' : ''), 'route-preview')); target.append(choice);
  }
  if (!routes.length) target.append(empty($('route-search').value ? 'No paths match this search.' : state.focus.kind !== 'all' || $('route-model').value ? 'No paths match these filters.' : noResults('paths')));
  $('route-pagination').replaceChildren(pagination('routes', routes.length, 8, renderPaths));
  updateRouteMarker(); motion.reflow(target, before);
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
  const target = $('chain-view'); motion.cancel(target); target.replaceChildren();
  delete target.dataset.routeKey; delete target.dataset.machine; delete target.dataset.traceSignature;
  target.hidden = !route;
  if (!route) return;
  target.dataset.routeKey = route.key; target.dataset.machine = route.scope.machineId;
  const heading = node('div', null, 'section-heading'); const title = node('div'); title.append(node('h2', project(route.scope.projectCwd))); heading.append(title, node('span', date(route.firstEvidenceAt) + ' UTC', 'small muted')); target.append(heading);
  target.append(node('p', countsText(route.counts), 'small'));
  const scope = node('dl');
  for (const [label, value] of Object.entries(route.scope)) scope.append(node('dt', sessionLabels[label] || label), node('dd', label === 'host' ? hostLabel(value) : value ?? 'Unknown'));
  target.append(disclosure('Session details', scope));
  let highlighted = [];
  if (state.focus.kind === 'relationship') {
    const evidence = state.focus.relationship.evidence[state.focus.evidenceIndex];
    if (evidence?.routeKey === route.key) highlighted = 'stepIndex' in evidence ? [evidence.stepIndex] : [evidence.fromStepIndex, evidence.toStepIndex];
  }
  const modelIndex = $('route-model').value;
  const pathModel = modelIndex === '' ? undefined : state.pathModels[Number(modelIndex)]?.model;
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
        if (kind === 'invocation' && evidence.outcome === 'error') card.classList.add('failure');
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
  target.dataset.traceSignature = JSON.stringify([route.key, route.lastEvidenceAt, state.pages.steps, highlighted, modelIndex, state.focus.kind === 'explore' ? state.explore : null]);
  motion.trace(target);
}

$('preview-label').hidden = new URLSearchParams(location.search).get('preview') !== '1';
document.querySelectorAll('[data-workspace]').forEach((item) => item.addEventListener('click', () => showWorkspace(item.dataset.workspace)));
$('route-list').addEventListener('scroll', () => updateRouteMarker(false), { passive: true });
updateWorkspaceMarker(false);
document.fonts.ready.then(() => { updateWorkspaceMarker(false); updateRouteMarker(false); });
$('filter-form').addEventListener('submit', (event) => { event.preventDefault(); loadDashboard(); });
$('refresh-data').addEventListener('click', loadDashboard);
$('metric-content').addEventListener('change', changeContentMode);
$('reset-filters').addEventListener('click', () => { cancelContentRequest(); state.content = { kind: 'unrequested' }; $('metric-content').value = 'both'; state.contentMeasures = { resources: 'toolActivity', both: 'toolActivity' }; state.skillPresentation = { measure: 'successfulReads', split: 'skill', display: 'count' }; configureContentControls(); $('filter-form').reset(); $('time-preset').value = '7'; $('metric-split').value = 'skill'; $('metric-display').value = 'count'; state.trends = { kind: 'top', count: 5 }; resetSelections(); loadDashboard(); });
for (const id of ['host-filter', 'model-filter']) $(id).addEventListener('change', () => loadDashboard());
$('machine-filter').addEventListener('change', () => loadDashboard());
$('toggle-filters').addEventListener('click', () => { const panel = $('scope-panel'); const before = panel.hidden ? 0 : panel.getBoundingClientRect().height; motion.cancel(panel); panel.hidden = !panel.hidden; $('toggle-filters').setAttribute('aria-expanded', String(!panel.hidden)); motion.expand(panel, before); });
$('time-preset').addEventListener('change', () => {
  const preset = $('time-preset').value;
  if (preset === 'custom') { const panel = $('scope-panel'); const before = panel.hidden ? 0 : panel.getBoundingClientRect().height; panel.hidden = false; $('toggle-filters').setAttribute('aria-expanded', 'true'); motion.expand(panel, before); $('from-filter').focus(); return; }
  loadDashboard();
});
for (const id of ['from-filter', 'to-filter']) $(id).addEventListener('change', () => { $('time-preset').value = 'custom'; });
for (const [id, key, render] of [['skill-search', 'skills', renderSkillComparison], ['catalog-search', 'catalog', renderCatalog], ['route-search', 'routes', renderPaths], ['resource-search', 'resources', renderResources]]) $(id).addEventListener('input', () => { state.pages[key] = 0; if (key === 'resources' ? state.resources.kind === 'ready' : state.report) render(); });
for (const id of ['resource-kind', 'resource-observation']) $(id).addEventListener('change', () => { state.pages.resources = 0; if (state.resources.kind === 'ready') renderResources(); });
for (const id of ['metric-measure', 'metric-split', 'metric-display']) $(id).addEventListener('change', () => {
  if (!state.report) return; state.pages.skills = 0; state.pages.columns = 0;
  if (isContentView()) { state.contentMeasures[contentMode()] = $('metric-measure').value; state.contentDetail = null; state.contentTrends = { kind: 'top', count: 5 }; loadContentAnalytics(); }
  else { updateMetricProjection(); state.skillPresentation = presentation(); renderActivity(); renderExplore(); }
});
$('route-model').addEventListener('change', () => { state.pages.routes = 0; state.routeKey = null; renderPaths(); });
$('browse-paths').addEventListener('click', () => showWorkspace('paths', true));
$('view-explorer').addEventListener('click', () => { $('explorer-panel').focus(); $('explorer-panel').scrollIntoView({ block: 'nearest' }); });
$('clear-explorer').addEventListener('click', () => { state.explore = { skillName: null, interval: null }; renderExplore(); focusExploration(); });
$('explore-models').addEventListener('click', () => selectSkill(state.explore.skillName));
$('explore-all-paths').addEventListener('click', () => explorePaths());
$('back-to-explorer').addEventListener('click', () => { showWorkspace('metrics', true); $('explorer-panel').focus(); $('explorer-panel').scrollIntoView({ block: 'nearest' }); });
$('clear-path-focus').addEventListener('click', () => { state.focus = { kind: 'all' }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = ''; renderPaths(); });
configureContentControls();
loadDashboard();
`;
