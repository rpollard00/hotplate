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
      <p id="scope-summary">All time · All projects · All machines</p>
      <div class="scope-actions"><label class="inline-label">Period<select id="time-preset"><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label><button type="button" id="toggle-filters" class="quiet" aria-expanded="false" aria-controls="scope-panel">Filters</button><button type="button" id="reset-filters" class="quiet">Reset</button></div>
    </div>
    <section id="scope-panel" class="panel" hidden aria-label="Evidence scope">
      <form id="filter-form" class="filter-grid">
        <label>Machine<select id="machine-filter" name="machineId"><option value="">All machines</option></select></label>
        <label>Project<select id="project-filter" name="projectCwd"><option value="">All projects</option></select></label>
        <label>Command source<select id="source-filter" name="source"><option value="">All command sources</option><option value="interactive">Interactive</option><option value="rpc">RPC</option><option value="extension">Extension</option></select></label>
        <label>Model provider<select id="model-provider-filter" name="modelProvider"><option value="">All providers</option></select></label>
        <label>Model<select id="model-id-filter" name="modelId"><option value="">All models</option></select></label>
        <label>From (UTC)<input id="from-filter" name="fromObservedAt" type="datetime-local"></label>
        <label>To (UTC)<input id="to-filter" name="toObservedAt" type="datetime-local"></label>
        <div class="filter-actions"><button type="submit">Apply scope</button></div>
      </form>
      <p class="footnote">Scope applies to every workspace. Command-source filters select requests only. Model filters select read results. Gaps remain visible.</p>
    </section>
    <section id="message-panel" class="message panel" role="status" hidden></section>
    <main id="workspace" tabindex="-1" aria-busy="true">
      <div id="dashboard-content" hidden>
        <section id="overview-workspace" aria-labelledby="overview-heading">
          <div class="page-heading"><div><p class="eyebrow">Recorded evidence</p><h1 id="overview-heading">How skills get used.</h1><p>Reads, requests, and the paths between them.</p></div><button type="button" id="overview-mako" class="quiet">Explore mako paths <span aria-hidden="true">↗</span></button></div>
          <div id="overview-cards" class="metrics-grid" aria-label="Scope totals"></div>
          <div id="evidence-context" class="evidence-context"></div>
          <div class="overview-grid">
            <section class="panel activity-panel" aria-labelledby="activity-heading"><div class="section-heading"><div><p class="eyebrow">When</p><h2 id="activity-heading">Activity over time</h2></div><span class="small muted">UTC</span></div><div id="activity-chart"></div></section>
            <section class="panel" aria-labelledby="skills-heading"><div class="section-heading"><div><p class="eyebrow">What</p><h2 id="skills-heading">Most-read skills</h2></div><span class="small muted">Successful reads</span></div><label class="search-label"><span class="sr-only">Find a skill</span><input id="skill-search" type="search" placeholder="Find a skill…"></label><div id="skill-table"></div></section>
          </div>
          <section class="panel" aria-labelledby="relationships-heading"><div class="section-heading"><div><p class="eyebrow">Together & next</p><h2 id="relationships-heading">Observed relationships</h2><p>Successful reads in the same group or adjacent groups. Not dependencies.</p></div><button type="button" id="browse-paths" class="quiet">Browse session paths ↗</button></div><div id="relationship-view"></div></section>
          <details class="panel" id="catalog-context"><summary>Catalog & evidence limits</summary><div id="coverage"></div><label class="search-label">Find a catalog skill<input id="catalog-search" type="search" placeholder="Search names…"></label><div id="catalog-list"></div><div class="limits"><p><strong>Not measured:</strong> usefulness, outcomes, missed opportunities, or agent identity.</p><p>Requests do not prove a read. Wrappers do not prove command expansion. Read failures are not successful reads.</p><p>Capture covers live pi sessions with the extension. Bash reads, other tools, external agents, and queued records lost during a crash can be unobserved.</p></div></details>
        </section>
        <section id="models-workspace" aria-labelledby="models-heading" hidden>
          <div class="page-heading"><div><p class="eyebrow">Compare</p><h1 id="models-heading">Skills by model.</h1><p>Recorded reads, not model quality. Requests and wrappers have no model attribution.</p></div></div>
          <section class="panel"><div class="section-heading"><label class="search-label">Find a skill<input id="model-search" type="search" placeholder="Search skill names…"></label><label class="inline-label">Measure<select id="model-measure"><option value="successfulReads">Successful reads</option><option value="failedReads">Read failures</option></select></label></div><div id="model-matrix" class="table-wrap" tabindex="0" role="region" aria-label="Skill by model counts"></div><p class="matrix-scroll-hint footnote">Scroll horizontally to compare models.</p><div id="model-pagination"></div><p class="footnote">Same-name variants combined. Each column is a provider and model pair. Zero means no matching recorded reads.</p></section>
          <section id="skill-detail" class="panel" aria-live="polite"></section>
        </section>
        <section id="paths-workspace" aria-labelledby="paths-heading" hidden>
          <div class="page-heading"><div><p class="eyebrow">Follow the evidence</p><h1 id="paths-heading">Session paths.</h1><p>Scoped runs in observed order. No links across gaps or run boundaries.</p></div><button id="mako-focus" type="button" class="quiet" aria-pressed="false">Focus on mako</button></div>
          <div class="path-toolbar panel"><div><strong id="path-focus-label">All session paths</strong><p class="small">Detail selection only. Overview totals keep the applied scope.</p></div><label class="search-label"><span class="sr-only">Search session paths</span><input id="route-search" type="search" placeholder="Find project or skill…"></label><label class="inline-label">Model<select id="route-model"><option value="">All models</option></select></label><button type="button" id="clear-path-focus" class="quiet">Clear selection</button></div>
          <div id="relationship-detail" class="panel" hidden></div>
          <div class="path-layout"><section class="panel route-master" aria-label="Recent session paths"><div class="section-heading"><h2>Recent paths</h2><span class="small muted" id="route-count"></span></div><div id="route-list"></div><div id="route-pagination"></div></section><section id="chain-view" class="panel route-detail" aria-label="Selected session path" tabindex="-1"></section></div>
        </section>
      </div>
    </main>
    <footer><span>Hotplate / read-only</span><span>Recorded evidence, not inferred outcomes.</span></footer>
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
.eyebrow { text-transform: uppercase; letter-spacing: .13em; font-size: 10px; font-weight: 700; color: var(--teal); }
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
.scope-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.inline-label { display: flex; align-items: center; gap: 8px; }
.scope-actions button, .scope-actions select { padding: 5px 9px; font-size: 12px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 22px; min-width: 0; margin-bottom: 18px; }
.filter-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; align-items: end; }
.page-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.page-heading > div, .section-heading > div { min-width: 0; }
.page-heading > button, .section-heading > button { flex-shrink: 0; }
.page-heading { padding: 15px 0 25px; }
.section-heading { margin-bottom: 18px; }
.section-heading p:not(.eyebrow) { margin-top: 4px; font-size: 12px; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 9px; background: white; }
.metric-card { padding: 22px 26px; border-right: 1px solid var(--line); }
.metric-card:last-child { border: 0; }
.metric-label { font-size: 12px; color: var(--muted); font-weight: 600; }
.metric-value { display: block; font-size: 38px; line-height: 1.3; letter-spacing: -.04em; font-variant-numeric: tabular-nums; margin: 5px 0; }
.metric-note { font-size: 11px; color: var(--muted); }
.metric-card:last-child .metric-value { color: var(--accent); }
.evidence-context { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 12px; padding: 12px 2px 22px; color: var(--muted); }
.evidence-context strong { color: var(--ink); }
.overview-grid { display: grid; grid-template-columns: minmax(0,1.55fr) minmax(330px,1fr); gap: 18px; }
.activity-summary { display: flex; align-items: baseline; gap: 10px; margin: 4px 0 15px; }
.activity-summary strong { font-size: 27px; font-weight: 600; letter-spacing: -.04em; }
.activity-svg { display: block; width: 100%; height: 240px; }
.activity-svg text { font: 11px ui-sans-serif, system-ui, sans-serif; fill: var(--muted); }
.activity-svg .gridline { stroke: #e9ece6; stroke-width: 1; }
.activity-svg .read-bar { fill: var(--teal); }
.activity-svg .failure-bar { fill: #c15b40; }
.chart-axis, .legend { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--muted); }
.legend { justify-content: start; flex-wrap: wrap; margin-top: 14px; }
.legend span::before { content: ''; display: inline-block; width: 7px; height: 7px; background: var(--teal); margin-right: 6px; border-radius: 2px; }
.legend .failure::before { background: #c15b40; }
details { margin-top: 15px; }
summary { color: var(--muted); font-size: 12px; font-weight: 600; }
details[open] > summary { margin-bottom: 15px; }
.search-label { max-width: 360px; margin-bottom: 12px; }
.rank-row { display: grid; grid-template-columns: 22px minmax(0,1fr) 38px; align-items: center; gap: 10px; padding: 8px 0; }
.rank-number { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.rank-row button { display: block; font-size: 12px; }
.rank-row strong { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.rank-track { background: #f0f3ee; height: 4px; margin-top: 7px; border-radius: 2px; }
.rank-fill { height: 100%; background: #73a294; border-radius: 2px; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; padding-top: 14px; }
.pagination-actions { display: flex; gap: 5px; }
.pagination button { padding: 4px 8px; font-size: 11px; }
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
.support-note { color: #985020; font-size: 11px; }
.limits { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 15px; display: grid; gap: 7px; font-size: 12px; }
.empty { padding: 30px 4px; color: var(--muted); }
.message { margin-top: 18px; border-left: 3px solid var(--accent); }
.message p { margin: 8px 0 16px; }
footer { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--line); margin: 20px 0; padding: 18px 0; color: var(--muted); font-size: 11px; }
.sr-only, .skip-link:not(:focus) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip-link:focus { display: block; padding: 12px; color: var(--teal); }
@media (min-width: 1600px) { .shell { width: min(1440px,90%); } }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr 1fr; }.path-toolbar { flex-wrap: wrap; }.path-toolbar > div:first-child { width: 100%; }.path-layout { grid-template-columns: 260px minmax(0,1fr); }.filter-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }.metric-card { padding: 20px; } }
@media (max-width: 760px) {
  .shell { width: calc(100% - 28px); }.app-header { padding: 12px 14px; }.identity { gap: 9px; }.identity-note { display: none; }.header-actions { gap: 8px; }.preview { font-size: 9px; }.workspace-nav { gap: 24px; }.scope-bar { align-items: start; flex-direction: column; gap: 10px; }.scope-actions { width: 100%; }.scope-actions .inline-label { margin-right: auto; }.page-heading { align-items: start; gap: 12px; }.page-heading > button { font-size: 11px; max-width: 125px; }.page-heading p:not(.eyebrow) { font-size: 12px; }.panel { padding: 17px; }.metrics-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.metric-card { padding: 17px; }.metric-card:nth-child(2) { border-right: 0; }.metric-card:nth-child(-n+2) { border-bottom: 1px solid var(--line); }.metric-value { font-size: 31px; }.overview-grid, .relationship-grid, .path-layout { grid-template-columns: 1fr; }.filter-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.activity-svg { height: 210px; }.section-heading { align-items: start; flex-wrap: wrap; }.section-heading > button { font-size: 11px; }.path-toolbar { gap: 12px; }.path-toolbar .search-label { max-width: none; flex: 1; min-width: 140px; }.path-toolbar .inline-label { max-width: 100%; }.path-toolbar select { max-width: 160px; }.route-master { margin-bottom: 0; }.route-detail { min-height: 0; }.step-heading { flex-wrap: wrap; gap: 4px; }.relationship-flow { gap: 6px; }.skill-node { font-size: 11px; }footer { flex-wrap: wrap; }
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
  pages: { skills: 0, models: 0, columns: 0, relationships: 0, routes: 0, steps: 0, catalog: 0, identities: 0, evidence: 0 },
};
const number = (value) => value.toLocaleString('en-US');
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
function countsText(counts) { return number(counts.successfulReads) + ' reads · ' + number(counts.failedReads) + ' failures · ' + number(counts.requests) + ' requests · ' + number(counts.wrappers) + ' wrappers'; }
function totalEvidence(counts) { return counts.successfulReads + counts.failedReads + counts.requests + counts.wrappers; }
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
  const first = total ? state.pages[key] * size + 1 : 0;
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
  $('message-panel').replaceChildren(node('h2', title), node('p', text));
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
  for (const key of Object.keys(state.pages)) state.pages[key] = 0;
  for (const id of ['skill-search', 'model-search', 'route-search', 'catalog-search', 'route-model']) $(id).value = '';
}
async function loadDashboard() {
  const requestId = ++state.requestId;
  state.controller?.abort(); state.controller = new AbortController();
  state.report = null;
  $('dashboard-content').hidden = true; $('workspace').setAttribute('aria-busy', 'true');
  setStatus('loading', 'Loading');
  showMessage('Loading evidence', 'Reading the applied scope…');
  try {
    const response = await fetch('/api/dashboard?' + filterParams(), { signal: state.controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Dashboard request failed (HTTP ' + response.status + ').');
    const payload = await response.json();
    if (requestId !== state.requestId) return;
    if (!['ready', 'missing', 'error'].includes(payload.kind)) throw new Error('Unexpected dashboard response.');
    renderFilterOptions(payload.filterOptions);
    if (payload.kind === 'missing') {
      setStatus('missing', 'No database'); showMessage('No Hotplate database found', 'Start a pi session with capture enabled. No evidence is available yet.');
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
    setStatus('error', 'Error'); showMessage('Cannot load dashboard', error instanceof Error ? error.message : 'Unknown dashboard error.', true);
  } finally {
    if (requestId === state.requestId) $('workspace').setAttribute('aria-busy', 'false');
  }
}
function renderFilterOptions(options) {
  if (!options) return;
  for (const [id, label, values] of [
    ['machine-filter', 'All machines', options.machines], ['project-filter', 'All projects', options.projects],
    ['model-provider-filter', 'All providers', options.modelProviders], ['model-id-filter', 'All models', options.modelIds],
  ]) setOptions($(id), label, values.map((value) => ({ value, label: value })));
}
function renderScope() {
  const scope = state.report.scope;
  const time = !scope.fromObservedAt && !scope.toObservedAt ? 'All time' : (scope.fromObservedAt ? date(scope.fromObservedAt, true) : 'First evidence') + ' to ' + (scope.toObservedAt ? date(scope.toObservedAt, true) : 'Latest evidence') + ' UTC';
  const parts = [time, scope.projectCwd ? project(scope.projectCwd) : 'All projects', scope.machineId ? '1 machine' : 'All machines'];
  if (scope.source) parts.push(scope.source + ' requests');
  if (scope.modelProvider || scope.modelId) parts.push([scope.modelProvider, scope.modelId].filter(Boolean).join(' / '));
  $('scope-summary').textContent = parts.join(' · ');
}
function renderOverview() {
  const report = state.report;
  const metrics = [
    ['Skill reads', report.counts.successfulReads, 'Successful file reads'],
    ['Skills read', report.skillsRead, 'Distinct skill names'],
    ['Session paths', report.routes.length, 'Scoped runs, not unique sessions'],
    ['Read failures', report.counts.failedReads, 'Failed file reads'],
  ];
  $('overview-cards').replaceChildren(...metrics.map(([label, value, note]) => {
    const card = node('article', null, 'metric-card'); card.append(node('span', label, 'metric-label'), node('strong', number(value), 'metric-value'), node('span', note, 'metric-note')); return card;
  }));
  $('evidence-context').replaceChildren();
  for (const [label, count] of [['requests', report.counts.requests], ['wrappers', report.counts.wrappers], ['capture gaps', report.coverage.captureGaps]]) {
    const item = node('span'); item.append(node('strong', number(count)), document.createTextNode(' ' + label)); $('evidence-context').append(item);
  }
  $('evidence-context').append(node('span', 'Requests and wrappers are separate from reads.'));
  renderActivity(); renderRanks(); renderRelationships(); renderCatalog();
  const coverage = report.coverage;
  $('coverage').replaceChildren(node('p', number(coverage.captureGaps) + ' capture gaps · ' + number(coverage.droppedObservations) + ' dropped observations · ' + number(coverage.filteredOmissions) + ' filtered omissions. Zero gaps does not prove complete capture.', 'footnote'), node('p', 'Catalog context uses machine, project, and time only. “No matching evidence” is not a missed opportunity.', 'footnote'));
}
function svgNode(tag, attrs) { const item = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value)); return item; }
function renderActivity() {
  const target = $('activity-chart'); target.replaceChildren();
  const report = state.report; const activity = report.activity;
  if (activity.kind === 'empty') target.append(empty('No dated evidence in this scope. Try All time or reset the filters.'));
  else {
    const summary = node('div', null, 'activity-summary'); summary.append(node('strong', number(report.counts.successfulReads)), node('span', 'successful reads in scope', 'muted small')); target.append(summary);
    const max = Math.max(1, ...activity.bins.map((bin) => bin.counts.successfulReads + bin.counts.failedReads));
    const svg = svgNode('svg', { viewBox: '0 0 680 240', role: 'img', 'aria-labelledby': 'activity-title activity-description', class: 'activity-svg', preserveAspectRatio: 'none' });
    const title = svgNode('title', { id: 'activity-title' }); title.textContent = 'Read activity in UTC';
    const description = svgNode('desc', { id: 'activity-description' }); description.textContent = activity.bins.length + ' time buckets from ' + date(activity.startAt) + '. Green bars show successful reads, orange bars show failures. Exact counts, including requests, wrappers, and zeros, follow in the data table.';
    svg.append(title, description);
    for (const fraction of [0, .5, 1]) {
      const y = 215 - fraction * 190; svg.append(svgNode('line', { x1: 37, x2: 678, y1: y, y2: y, class: 'gridline' }));
      const label = svgNode('text', { x: 27, y: y + 4, 'text-anchor': 'end' }); label.textContent = number(Math.round(max * fraction)); svg.append(label);
    }
    const width = 636 / activity.bins.length;
    activity.bins.forEach((bin, index) => {
      const reads = bin.counts.successfulReads / max * 190; const failures = bin.counts.failedReads / max * 190;
      const group = svgNode('g', {}); const tooltip = svgNode('title', {}); tooltip.textContent = date(bin.startAt) + ': ' + countsText(bin.counts); group.append(tooltip);
      group.append(svgNode('rect', { x: 39 + index * width, y: 215 - reads, width: Math.max(1, width * .7), height: reads, rx: 1, class: 'read-bar' }), svgNode('rect', { x: 39 + index * width, y: 215 - reads - failures, width: Math.max(1, width * .7), height: failures, rx: 1, class: 'failure-bar' })); svg.append(group);
    });
    target.append(svg);
    const axis = node('div', null, 'chart-axis'); axis.append(node('span', date(activity.startAt)), node('span', date(new Date(Date.parse(activity.endAt) - 1).toISOString()))); target.append(axis);
    const legend = node('div', null, 'legend'); legend.append(node('span', 'Successful reads'), node('span', 'Read failures', 'failure')); target.append(legend);
    target.append(node('p', 'Each bar covers ' + Math.round(activity.binWidthMs / 86400000) + ' UTC day(s). Zero means no matching recorded evidence.', 'footnote'));
    const data = table(['UTC interval', 'Reads', 'Failures', 'Requests', 'Wrappers']);
    for (const bin of activity.bins) { const row = node('tr'); [date(bin.startAt) + ' – ' + date(new Date(Date.parse(bin.endAt) - 1).toISOString()), bin.counts.successfulReads, bin.counts.failedReads, bin.counts.requests, bin.counts.wrappers].forEach((value) => row.append(node('td', value))); data.lastChild.append(row); }
    const scroll = node('div', null, 'table-wrap'); scroll.append(data); target.append(disclosure('Activity data · ' + activity.bins.length + ' buckets', scroll));
  }
  if (report.coverage.undatedEvidence > 0) target.append(node('p', number(report.coverage.undatedEvidence) + ' records have no usable timestamp and are not shown in the activity chart.', 'footnote'));
}
function renderRanks() {
  const query = $('skill-search').value.toLowerCase();
  const groups = state.report.skillGroups.filter((group) => group.counts.successfulReads > 0 && group.name.toLowerCase().includes(query));
  const target = $('skill-table'); target.replaceChildren();
  const max = groups[0]?.counts.successfulReads || 1;
  pageItems(groups, 'skills', 8).forEach((group, index) => {
    const row = node('div', null, 'rank-row'); row.append(node('span', String(state.pages.skills * 8 + index + 1).padStart(2, '0'), 'rank-number'));
    const name = node('div'); name.append(button(group.name, () => selectSkill(group.name), 'link'));
    const track = node('div', null, 'rank-track'); const fill = node('div', null, 'rank-fill'); fill.style.width = group.counts.successfulReads / max * 100 + '%'; track.append(fill); name.append(track);
    row.append(name, node('strong', number(group.counts.successfulReads))); target.append(row);
  });
  if (!groups.length) target.append(empty('No successful reads match. Catalog-only skills are in Catalog & evidence limits.'));
  target.append(pagination('skills', groups.length, 8, renderRanks));
}
function renderCatalog() {
  const groups = state.report.skillGroups.filter((group) => group.cataloged && group.name.toLowerCase().includes($('catalog-search').value.toLowerCase()));
  const target = $('catalog-list'); target.replaceChildren();
  for (const group of pageItems(groups, 'catalog', 8)) {
    const row = node('div', null, 'identity-item'); row.append(button(group.name, () => selectSkill(group.name), 'link'), node('p', totalEvidence(group.counts) === 0 ? 'No matching evidence' : countsText(group.counts))); target.append(row);
  }
  if (!groups.length) target.append(empty('No catalog skills match this scope.'));
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
    const card = node('article', null, 'relationship'); card.append(node('p', relationship.kind === 'same-group' ? 'SAME GROUP · no internal order' : 'NEXT GROUP · observed order', 'eyebrow'), relationshipFlow(relationship), button(number(relationship.evidence.length) + ' supporting occurrences ↗', () => selectRelationship(relationship), 'link')); grid.append(card);
  }
  target.append(grid);
  if (!relationships.length) target.append(empty('No successful-read relationships in this scope. Requests, wrappers, failures, and gaps do not create links.'));
  target.append(pagination('relationships', relationships.length, 4, renderRelationships));
}
function selectSkill(name) {
  state.skillSelection = { kind: 'skill', name }; state.pages.identities = 0; renderSkillDetail(); showWorkspace('models');
  $('skill-detail').tabIndex = -1; $('skill-detail').focus();
}
function renderModels() {
  const report = state.report; const measure = $('model-measure').value;
  const groups = report.skillGroups.filter((group) => (group.counts.successfulReads + group.counts.failedReads > 0) && group.name.toLowerCase().includes($('model-search').value.toLowerCase()));
  const columns = pageItems(report.models, 'columns', 6);
  const matrix = table(['Skill', ...columns.map((column) => modelLabel(column.model))], measure === 'successfulReads' ? 'Successful reads by skill and model' : 'Read failures by skill and model'); matrix.className = 'matrix';
  const max = groups.reduce((value, group) => Math.max(value, ...group.models.map((model) => model[measure])), 1);
  for (const group of pageItems(groups, 'models', 12)) {
    const row = node('tr'); const label = node('th'); label.scope = 'row'; label.append(button(group.name, () => selectSkill(group.name), 'link')); row.append(label);
    for (const column of columns) {
      const count = group.models.find((entry) => sameModel(entry.model, column.model))?.[measure] || 0;
      const cell = node('td');
      const action = button(number(count), () => { state.skillSelection = { kind: 'model-skill', name: group.name, model: column.model }; state.pages.identities = 0; renderSkillDetail(); $('skill-detail').tabIndex = -1; $('skill-detail').focus(); }, 'heat-' + (count === 0 ? 0 : Math.max(1, Math.ceil(count / max * 4))));
      action.setAttribute('aria-label', group.name + ', ' + modelLabel(column.model) + ': ' + count + ' ' + (measure === 'successfulReads' ? 'successful reads' : 'read failures')); cell.append(action); row.append(cell);
    }
    matrix.lastChild.append(row);
  }
  $('model-matrix').replaceChildren(groups.length && columns.length ? matrix : empty('No model read results match this scope.'));
  $('model-pagination').replaceChildren(pagination('models', groups.length, 12, renderModels));
  if (report.models.length > 6) $('model-pagination').append(pagination('columns', report.models.length, 6, renderModels));
  renderSkillDetail();
  setOptions($('route-model'), 'All models', report.models.map((column, index) => ({ value: String(index), label: modelLabel(column.model) })));
}
function renderSkillDetail() {
  const target = $('skill-detail'); target.replaceChildren();
  const selection = state.skillSelection;
  const selectedModel = selection?.kind === 'model-skill' ? selection.model : undefined;
  const group = state.report.skillGroups.find((entry) => entry.name === selection?.name);
  if (!group) { target.append(node('h2', 'Inspect a skill'), node('p', 'Select a name or count to see evidence and supporting session paths.', 'footnote')); return; }
  const heading = node('div', null, 'section-heading'); heading.append(node('h2', group.name), button('Open session paths ↗', () => { state.focus = { kind: 'skill', name: group.name }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = selectedModel === undefined ? '' : String(state.report.models.findIndex((column) => sameModel(column.model, selectedModel))); renderPaths(); showWorkspace('paths', true); })); target.append(heading);
  target.append(node('p', 'Same-name variants combined. Names do not prove identical content or resolve requests to a file.', 'small'), node('p', countsText(group.counts), 'detail-counts'));
  if (selectedModel !== undefined) { const counts = group.models.find((column) => sameModel(column.model, selectedModel)); target.append(node('p', modelLabel(selectedModel) + ': ' + (counts?.successfulReads || 0) + ' reads · ' + (counts?.failedReads || 0) + ' failures', 'footnote')); }
  const identities = node('div', null, 'identity-list');
  const variants = group.skillKeys.map((key) => state.report.skills.find((entry) => entry.key === key)).filter(Boolean);
  for (const variant of pageItems(variants, 'identities', 8)) {
    const item = node('div', null, 'identity-item'); item.dataset.machine = variant.identity.machineId;
    item.append(node('p', 'Machine: ' + variant.identity.machineId), node('p', variant.identity.kind === 'resolved' ? variant.identity.canonicalPath : 'Request only · no resolved file'), node('p', countsText(variant.counts)), node('p', variant.cataloged ? 'In catalog context' : 'Not in catalog context'));
    identities.append(item);
  }
  identities.append(pagination('identities', variants.length, 8, renderSkillDetail));
  target.append(disclosure('Identity details · ' + variants.length + ' variants', identities));
}
function focusMako() { state.focus = { kind: 'mako' }; state.routeKey = null; state.pages.routes = 0; $('route-search').value = ''; $('route-model').value = ''; renderPaths(); showWorkspace('paths', true); }
function selectRelationship(relationship) {
  state.focus = { kind: 'relationship', relationship, evidenceIndex: 0 }; state.pages.routes = 0; state.pages.evidence = 0;
  state.routeKey = relationship.evidence[0]?.routeKey || null;
  state.pages.steps = Math.floor((relationship.evidence[0]?.stepIndex ?? relationship.evidence[0]?.fromStepIndex ?? 0) / 30);
  $('route-search').value = ''; $('route-model').value = ''; renderPaths(); showWorkspace('paths', true);
}
function matchingRoutes() {
  const report = state.report; let keys = null;
  if (state.focus.kind === 'mako') keys = new Set(report.skillGroups.filter((group) => group.name.toLowerCase() === 'mako' || group.name.toLowerCase().startsWith('mako-') || group.name.toLowerCase().startsWith('mako/')).flatMap((group) => group.routeKeys));
  if (state.focus.kind === 'skill') keys = new Set(report.skillGroups.find((group) => group.name === state.focus.name)?.routeKeys || []);
  if (state.focus.kind === 'relationship') keys = new Set(state.focus.relationship.evidence.map((entry) => entry.routeKey));
  const query = $('route-search').value.toLowerCase(); const modelIndex = $('route-model').value; const model = modelIndex === '' ? undefined : report.models[Number(modelIndex)]?.model;
  return report.routes.filter((route) => {
    if (keys && !keys.has(route.key)) return false;
    if (model !== undefined && !route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => item.evidence.kind === 'read-result' && sameModel(item.evidence.model, model) && (state.focus.kind !== 'skill' || skillName(item.skillKey) === state.focus.name)))) return false;
    return !query || route.scope.projectCwd.toLowerCase().includes(query) || route.steps.some((step) => step.kind === 'observations' && step.items.some((item) => skillName(item.skillKey).toLowerCase().includes(query)));
  });
}
function renderPaths() {
  const routes = matchingRoutes();
  const label = state.focus.kind === 'mako' ? 'Paths containing mako' : state.focus.kind === 'skill' ? 'Paths containing ' + state.focus.name : state.focus.kind === 'relationship' ? 'Paths supporting this relationship' : 'All session paths';
  $('path-focus-label').textContent = label; $('mako-focus').setAttribute('aria-pressed', String(state.focus.kind === 'mako'));
  $('route-count').textContent = number(routes.length) + ' scoped runs';
  if (!routes.some((route) => route.key === state.routeKey)) { state.routeKey = routes[0]?.key || null; state.pages.steps = 0; }
  const target = $('route-list'); target.replaceChildren();
  for (const route of pageItems(routes, 'routes', 8)) {
    const choice = button('', () => { state.routeKey = route.key; state.pages.steps = 0; renderPaths(); $('chain-view').focus(); }, 'route-choice');
    choice.dataset.routeKey = route.key; choice.setAttribute('aria-pressed', String(route.key === state.routeKey));
    choice.append(node('strong', project(route.scope.projectCwd)), node('p', date(route.lastEvidenceAt, true) + ' UTC'), node('p', number(route.counts.successfulReads) + ' reads · ' + route.steps.length + ' steps'));
    const names = [...new Set(route.steps.flatMap((step) => step.kind === 'observations' ? step.items.map((item) => skillName(item.skillKey)) : []))];
    choice.append(node('p', names.slice(0, 4).join(' · ') + (names.length > 4 ? ' …' : ''), 'route-preview')); target.append(choice);
  }
  if (!routes.length) target.append(empty('No paths match this selection. Clear the selection or reset the scope.'));
  $('route-pagination').replaceChildren(pagination('routes', routes.length, 8, renderPaths));
  renderRelationshipDetail(routes); renderRouteDetail(routes.find((route) => route.key === state.routeKey));
}
function renderRelationshipDetail(routes) {
  const target = $('relationship-detail'); target.hidden = state.focus.kind !== 'relationship'; target.replaceChildren();
  if (state.focus.kind !== 'relationship') return;
  const relationship = state.focus.relationship;
  target.append(node('h2', relationship.kind === 'same-group' ? 'Read together in one group' : 'Read in adjacent groups'), relationshipFlow(relationship), node('p', 'Observed order is not a dependency. Select an occurrence to highlight its original steps.', 'small'));
  const occurrences = relationship.evidence.map((evidence, index) => ({ evidence, index })).filter(({ evidence }) => routes.some((route) => route.key === evidence.routeKey));
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
  if (!route) { target.append(empty('Select a session path to inspect its evidence.')); return; }
  target.dataset.routeKey = route.key; target.dataset.machine = route.scope.machineId;
  const heading = node('div', null, 'section-heading'); const title = node('div'); title.append(node('p', 'Selected path · complete within applied scope', 'eyebrow'), node('h2', project(route.scope.projectCwd))); heading.append(title, node('span', date(route.firstEvidenceAt) + ' UTC', 'small muted')); target.append(heading);
  target.append(node('p', countsText(route.counts), 'small'), node('p', 'Groups preserve recorded order. Items inside a read group have no implied direction.', 'footnote'));
  if (state.focus.kind === 'mako') target.append(node('p', 'Mako focus includes matching names and wrapper evidence. Complete containing paths remain visible. This does not prove mako routing.', 'footnote'));
  const scope = node('dl');
  for (const [label, value] of Object.entries(route.scope)) scope.append(node('dt', label), node('dd', value ?? 'Unknown'));
  target.append(disclosure('Full path scope', scope));
  let highlighted = [];
  if (state.focus.kind === 'relationship') {
    const evidence = state.focus.relationship.evidence[state.focus.evidenceIndex];
    if (evidence?.routeKey === route.key) highlighted = 'stepIndex' in evidence ? [evidence.stepIndex] : [evidence.fromStepIndex, evidence.toStepIndex];
  }
  const timeline = node('ol', null, 'timeline'); timeline.start = state.pages.steps * 30 + 1;
  for (const [offset, step] of pageItems(route.steps, 'steps', 30).entries()) {
    const index = state.pages.steps * 30 + offset;
    const item = node('li', null, 'timeline-step' + (step.kind === 'gap' ? ' gap' : '') + (highlighted.includes(index) ? ' supporting' : ''));
    item.dataset.stepIndex = String(index);
    const label = node('div', null, 'step-heading'); label.append(node('span', String(index + 1).padStart(2, '0') + ' / ' + (step.kind === 'gap' ? 'Gap' : step.items.every((entry) => entry.evidence.kind === 'read-result') ? 'Read group' : 'Evidence')), node('span', date(step.observedAt, true) + (step.observedAt ? ' UTC' : ''))); item.append(label);
    if (highlighted.includes(index)) item.append(node('p', 'Supporting relationship evidence', 'support-note'));
    if (step.kind === 'gap') item.append(node('p', (step.reason === 'filtered-intermediates' ? 'Filtered gap: ' : 'Capture gap: ') + step.omitted + ' omitted · ' + step.reason + '. No relationship crosses this gap.', 'gap-card'));
    else {
      const group = node('div', null, 'step-group');
      for (const observation of step.items) {
        const evidence = observation.evidence;
        const kind = evidence.kind === 'command-intent' ? 'request' : evidence.kind === 'wrapper-observed' ? 'wrapper' : evidence.outcome === 'success' ? 'read' : 'failure';
        const card = node('div', null, 'observation ' + kind);
        card.append(node('strong', skillName(observation.skillKey)), node('p', kind === 'request' ? 'Request · ' + evidence.source : kind === 'wrapper' ? 'Wrapper · ' + evidence.wrapperSource : (kind === 'read' ? 'Successful read' : 'Read failure') + ' · ' + modelLabel(evidence.model)));
        group.append(card);
      }
      item.append(group);
      const audit = node('div', null, 'route-scope'); audit.append(node('p', 'Turn: ' + (step.turnId ?? 'Unknown') + ' · Leaf: ' + (step.leafId ?? 'Unknown'), 'small'));
      for (const observation of step.items) audit.append(node('p', 'Record ' + observation.observationId + ' · sequence ' + observation.sequence + ' · ' + observation.observedAt + (observation.evidence.kind === 'command-intent' ? '' : ' · ' + observation.evidence.skill.canonicalPath) + (observation.evidence.kind === 'read-result' ? ' · tool call ' + observation.evidence.toolCallId : ''), 'footnote'));
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
$('reset-filters').addEventListener('click', () => { $('filter-form').reset(); $('time-preset').value = 'all'; resetSelections(); loadDashboard(); });
$('machine-filter').addEventListener('change', () => { for (const id of ['project-filter', 'model-provider-filter', 'model-id-filter']) $(id).value = ''; loadDashboard(); });
$('toggle-filters').addEventListener('click', () => { $('scope-panel').hidden = !$('scope-panel').hidden; $('toggle-filters').setAttribute('aria-expanded', String(!$('scope-panel').hidden)); });
$('time-preset').addEventListener('change', () => {
  const preset = $('time-preset').value;
  if (preset === 'custom') { $('scope-panel').hidden = false; $('toggle-filters').setAttribute('aria-expanded', 'true'); $('from-filter').focus(); return; }
  if (preset === 'all') { $('from-filter').value = ''; $('to-filter').value = ''; }
  else { const now = new Date(); $('to-filter').value = now.toISOString().slice(0, 16); $('from-filter').value = new Date(now.getTime() - Number(preset) * 86400000).toISOString().slice(0, 16); }
  loadDashboard();
});
for (const id of ['from-filter', 'to-filter']) $(id).addEventListener('change', () => { $('time-preset').value = 'custom'; });
for (const [id, key, render] of [['skill-search', 'skills', renderRanks], ['model-search', 'models', renderModels], ['catalog-search', 'catalog', renderCatalog], ['route-search', 'routes', renderPaths]]) $(id).addEventListener('input', () => { state.pages[key] = 0; if (state.report) render(); });
$('model-measure').addEventListener('change', () => { if (state.report) renderModels(); });
$('route-model').addEventListener('change', () => { state.pages.routes = 0; state.routeKey = null; renderPaths(); });
$('overview-mako').addEventListener('click', focusMako); $('mako-focus').addEventListener('click', focusMako);
$('browse-paths').addEventListener('click', () => showWorkspace('paths', true));
$('clear-path-focus').addEventListener('click', () => { state.focus = { kind: 'all' }; state.pages.routes = 0; state.routeKey = null; $('route-search').value = ''; $('route-model').value = ''; renderPaths(); });
loadDashboard();
`;
