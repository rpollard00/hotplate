export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hotplate</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <header class="shell hero">
    <div>
      <p class="eyebrow">Local pi skill analytics</p>
      <h1>Hotplate</h1>
      <p class="lede">Read-only dashboard for local observations. Evidence labels keep command intent, wrappers, and model reads separate.</p>
    </div>
    <div class="status-card" id="status-card">
      <span class="status-dot" aria-hidden="true"></span>
      <span id="status-text">Loading</span>
    </div>
  </header>

  <main class="shell">
    <section class="panel filters" aria-labelledby="filters-heading">
      <div>
        <h2 id="filters-heading">Filters</h2>
        <p>Totals and tables use these filters. The chain skill button filters the chain view only.</p>
      </div>
      <form id="filter-form" class="filter-grid">
        <label>Project
          <select id="project-filter" name="projectCwd">
            <option value="">All projects</option>
          </select>
        </label>
        <label>Source
          <select id="source-filter" name="source">
            <option value="">All command sources</option>
            <option value="interactive">Interactive commands</option>
            <option value="rpc">RPC commands</option>
            <option value="extension">Extension commands</option>
          </select>
        </label>
        <label>Model provider
          <select id="model-provider-filter" name="modelProvider">
            <option value="">All providers</option>
          </select>
        </label>
        <label>Model
          <select id="model-id-filter" name="modelId">
            <option value="">All models</option>
          </select>
        </label>
        <label>From
          <input id="from-filter" name="fromObservedAt" type="datetime-local">
        </label>
        <label>To
          <input id="to-filter" name="toObservedAt" type="datetime-local">
        </label>
        <div class="filter-actions">
          <button type="submit">Apply</button>
          <button type="button" id="reset-filters" class="secondary">Reset</button>
          <button type="button" id="refresh-data" class="secondary">Refresh</button>
        </div>
      </form>
    </section>

    <section id="message-panel" class="panel message" hidden></section>

    <section class="metrics-grid" aria-label="Overview" id="overview-cards"></section>

    <section class="grid-two">
      <section class="panel" aria-labelledby="source-heading">
        <h2 id="source-heading">Source and evidence split</h2>
        <div id="source-split" class="bars"></div>
      </section>
      <section class="panel" aria-labelledby="health-heading">
        <h2 id="health-heading">Capture health</h2>
        <div id="capture-health"></div>
      </section>
    </section>

    <section class="panel" aria-labelledby="skills-heading">
      <div class="section-header">
        <div>
          <h2 id="skills-heading">Skills</h2>
          <p>Cataloged skills can have zero observed loads. Command intent is not proof that pi loaded a skill.</p>
        </div>
        <button type="button" id="clear-chain-skill" hidden>Show all chains</button>
      </div>
      <div id="skill-table" class="table-wrap"></div>
    </section>

    <section class="panel" aria-labelledby="models-heading">
      <h2 id="models-heading">Provider and model comparison</h2>
      <div id="model-matrix" class="table-wrap"></div>
    </section>

    <section class="panel" aria-labelledby="chains-heading">
      <div class="section-header">
        <div>
          <h2 id="chains-heading">Observed-order skill chains</h2>
          <p>Observed order, not proven dependency. Reads from one model turn form one group. Gaps mark filtered or dropped observations.</p>
        </div>
        <p class="pill" id="chain-filter-label">All skills</p>
      </div>
      <div id="chain-view" class="chains"></div>
    </section>

    <section class="panel blind-spots" aria-labelledby="blind-spots-heading">
      <h2 id="blind-spots-heading">Blind spots</h2>
      <ul>
        <li>Hotplate captures live pi sessions only. It does not import historical transcripts.</li>
        <li>Bash reads, custom tools, external agents, and processes without the extension can be unobserved.</li>
        <li>RPC command intent is not proof of human action.</li>
        <li>Wrappers are not proof of slash command expansion.</li>
        <li>Failed reads are not successful skill loads.</li>
        <li>Process crashes can lose queued observations before SQLite writes complete.</li>
      </ul>
    </section>
  </main>

  <script src="/assets/app.js"></script>
</body>
</html>`;

export const dashboardCss = `:root {
  color-scheme: light;
  --bg: #f7f3ea;
  --panel: #fffdf8;
  --ink: #241a12;
  --muted: #6e6258;
  --line: #e0d6c8;
  --accent: #ba4a1c;
  --accent-strong: #8f2f13;
  --accent-soft: #f7d9c9;
  --ok: #257a44;
  --warn: #9d6b00;
  --bad: #a33131;
  --shadow: 0 18px 50px rgb(55 38 20 / 0.10);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(circle at top left, #ffe3cc 0, transparent 32rem), var(--bg);
  color: var(--ink);
}
button, input, select { font: inherit; }
button {
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent);
  color: white;
  cursor: pointer;
  padding: 0.55rem 0.9rem;
}
button.secondary, .link-button {
  background: transparent;
  color: var(--accent-strong);
}
button:hover { filter: brightness(0.96); }
.shell { width: min(1180px, calc(100% - 2rem)); margin: 0 auto; }
.hero {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 2.5rem 0 1.25rem;
  align-items: end;
}
.eyebrow { color: var(--accent-strong); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { font-size: clamp(2.4rem, 8vw, 5rem); line-height: 0.9; margin: 0; }
h2 { margin: 0 0 0.5rem; }
p { color: var(--muted); margin: 0.25rem 0 0; }
.lede { max-width: 44rem; font-size: 1.05rem; }
.panel, .status-card, .metric-card {
  background: color-mix(in srgb, var(--panel), white 35%);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--shadow);
}
.panel { margin: 1rem 0; padding: 1rem; }
.status-card { display: flex; align-items: center; gap: 0.55rem; padding: 0.7rem 0.9rem; min-width: 12rem; }
.status-dot { width: 0.75rem; height: 0.75rem; border-radius: 50%; background: var(--warn); display: inline-block; }
.status-card.ready .status-dot { background: var(--ok); }
.status-card.error .status-dot { background: var(--bad); }
.filter-grid { display: grid; gap: 0.85rem; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 1rem; align-items: end; }
label { display: grid; gap: 0.35rem; color: var(--muted); font-size: 0.9rem; }
select, input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0.58rem 0.65rem;
  background: white;
  color: var(--ink);
}
.filter-actions { display: flex; gap: 0.5rem; align-items: end; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }
.metric-card { padding: 1rem; }
.metric-value { display: block; font-size: 2rem; font-weight: 800; }
.metric-label { color: var(--muted); }
.grid-two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.section-header { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 720px; }
th, td { border-bottom: 1px solid var(--line); padding: 0.65rem 0.5rem; text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
.skill-name { display: grid; gap: 0.2rem; }
.path { color: var(--muted); font-size: 0.82rem; max-width: 34rem; overflow-wrap: anywhere; }
.badge, .pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 0.18rem 0.55rem;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.8rem;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.bars { display: grid; gap: 0.65rem; }
.bar-row { display: grid; grid-template-columns: minmax(8rem, 12rem) 1fr auto; gap: 0.6rem; align-items: center; }
.bar-track { height: 0.75rem; background: #eee2d5; border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; min-width: 0.25rem; background: var(--accent); border-radius: 999px; }
.health-list, .blind-spots ul { margin: 0.75rem 0 0; padding-left: 1.2rem; color: var(--muted); }
.chains { display: grid; gap: 1rem; }
.chain-run { border: 1px solid var(--line); border-radius: 18px; padding: 0.85rem; background: white; }
.chain-title { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.chain-steps { display: flex; flex-wrap: wrap; gap: 0.55rem; align-items: stretch; }
.chain-step, .chain-gap { overflow-wrap: anywhere; min-width: 0; border-radius: 16px; padding: 0.65rem; border: 1px solid var(--line); background: #fffaf1; max-width: 20rem; }
.chain-gap { background: #f5eee5; color: var(--muted); border-style: dashed; }
.chain-items { display: grid; gap: 0.35rem; }
.evidence-button { border-radius: 12px; text-align: left; background: white; color: var(--ink); border-color: var(--line); padding: 0.45rem 0.55rem; }
.evidence-kind { color: var(--accent-strong); font-weight: 700; }
.empty { color: var(--muted); padding: 1rem 0; }
.message { border-color: var(--warn); }
.message.error { border-color: var(--bad); }
@media (max-width: 900px) {
  .hero, .section-header { display: grid; }
  .filter-grid, .metrics-grid, .grid-two { grid-template-columns: 1fr; }
  table { min-width: 640px; }
}
`;

export const dashboardJs = `const state = {
  requestId: 0,
  chainSkillName: null,
};

const els = {
  statusCard: document.getElementById("status-card"),
  statusText: document.getElementById("status-text"),
  messagePanel: document.getElementById("message-panel"),
  filterForm: document.getElementById("filter-form"),
  projectFilter: document.getElementById("project-filter"),
  sourceFilter: document.getElementById("source-filter"),
  modelProviderFilter: document.getElementById("model-provider-filter"),
  modelIdFilter: document.getElementById("model-id-filter"),
  fromFilter: document.getElementById("from-filter"),
  toFilter: document.getElementById("to-filter"),
  resetFilters: document.getElementById("reset-filters"),
  overviewCards: document.getElementById("overview-cards"),
  sourceSplit: document.getElementById("source-split"),
  captureHealth: document.getElementById("capture-health"),
  skillTable: document.getElementById("skill-table"),
  modelMatrix: document.getElementById("model-matrix"),
  chainView: document.getElementById("chain-view"),
  chainFilterLabel: document.getElementById("chain-filter-label"),
  clearChainSkill: document.getElementById("clear-chain-skill"),
};

els.filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadDashboard();
});
document.getElementById("refresh-data").addEventListener("click", loadDashboard);
els.resetFilters.addEventListener("click", () => {
  els.filterForm.reset();
  state.chainSkillName = null;
  loadDashboard();
});
els.clearChainSkill.addEventListener("click", () => {
  state.chainSkillName = null;
  loadDashboard();
});

function setStatus(kind, text) {
  els.statusCard.classList.remove("ready", "error");
  if (kind) els.statusCard.classList.add(kind);
  els.statusText.textContent = text;
}

function showMessage(kind, title, body) {
  els.messagePanel.hidden = false;
  els.messagePanel.className = kind === "error" ? "panel message error" : "panel message";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = body;
  els.messagePanel.replaceChildren(heading, paragraph);
}

function clearMessage() {
  els.messagePanel.hidden = true;
  els.messagePanel.replaceChildren();
}

function filterParams() {
  const params = new URLSearchParams();
  addIfPresent(params, "projectCwd", els.projectFilter.value);
  addIfPresent(params, "source", els.sourceFilter.value);
  addIfPresent(params, "modelProvider", els.modelProviderFilter.value);
  addIfPresent(params, "modelId", els.modelIdFilter.value);
  addIfPresent(params, "fromObservedAt", dateTimeValue(els.fromFilter.value));
  addIfPresent(params, "toObservedAt", dateTimeValue(els.toFilter.value));
  if (state.chainSkillName) params.set("chainSkill", state.chainSkillName);
  return params;
}

function addIfPresent(params, name, value) {
  if (value) params.set(name, value);
}

function dateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

async function loadDashboard() {
  const requestId = ++state.requestId;
  setStatus(null, "Loading");
  try {
    const response = await fetch(\`/api/dashboard?\${filterParams().toString()}\`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    const payload = await response.json();
    if (requestId === state.requestId) renderPayload(payload);
  } catch (error) {
    if (requestId !== state.requestId) return;
    clearDashboard();
    setStatus("error", "Error");
    showMessage("error", "Dashboard error", error instanceof Error ? error.message : "Unknown error");
  }
}

function renderPayload(payload) {
  if (payload.kind === "missing") {
    setStatus(null, "No database");
    showMessage("info", "No Hotplate database found", \`Start a pi session with Hotplate capture enabled, or run a demo against an explicit DB path. Looked for \${payload.databasePath}.\`);
    clearDashboard();
    renderFilterOptions(payload.filterOptions);
    return;
  }

  if (payload.kind === "error") {
    setStatus("error", "Error");
    showMessage("error", "Cannot read Hotplate database", payload.message);
    clearDashboard();
    renderFilterOptions(payload.filterOptions);
    return;
  }

  setStatus("ready", "Ready");
  clearMessage();
  renderFilterOptions(payload.filterOptions);
  renderOverview(payload.overview);
  renderSourceSplit(payload.sourceSplit);
  renderCaptureHealth(payload.health);
  renderSkillTable(payload.skills.rows);
  renderModelMatrix(payload.matrix.rows);
  renderChains(payload.chains.runs, payload.chainSkillName);
}

function clearDashboard() {
  els.overviewCards.replaceChildren();
  els.sourceSplit.replaceChildren();
  els.captureHealth.replaceChildren();
  els.skillTable.replaceChildren();
  els.modelMatrix.replaceChildren();
  els.chainView.replaceChildren();
  els.chainFilterLabel.textContent = "All skills";
  els.clearChainSkill.hidden = true;
}

function renderFilterOptions(options) {
  if (!options) return;
  setOptions(els.projectFilter, "All projects", options.projects.map((project) => ({ value: project, label: project })));
  setOptions(els.modelProviderFilter, "All providers", options.modelProviders.map((provider) => ({ value: provider, label: provider })));
  setOptions(els.modelIdFilter, "All models", options.modelIds.map((model) => ({ value: model, label: model })));
}

function setOptions(select, allLabel, options) {
  const current = select.value;
  const children = [];
  const all = document.createElement("option");
  all.value = "";
  all.textContent = allLabel;
  children.push(all);
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    children.push(item);
  }
  select.replaceChildren(...children);
  select.value = options.some((option) => option.value === current) ? current : "";
}

function renderOverview(overview) {
  const cards = [
    ["Observations", overview.observationCount],
    ["Successful reads", overview.successfulReadCount],
    ["Failed reads", overview.failedReadCount],
    ["Observed activations", overview.uniqueObservedSkillRunActivations],
    ["Catalog skills", overview.catalogSkillCount],
    ["Dropped observations", overview.droppedObservationCount],
    ["First observed", formatTime(overview.firstObservedAt)],
    ["Last observed", formatTime(overview.lastObservedAt)],
  ];
  els.overviewCards.replaceChildren(...cards.map(([label, value]) => metricCard(label, value)));
}

function metricCard(label, value) {
  const card = document.createElement("article");
  card.className = "metric-card";
  const number = document.createElement("span");
  number.className = "metric-value";
  number.textContent = String(value ?? "None");
  const caption = document.createElement("span");
  caption.className = "metric-label";
  caption.textContent = label;
  card.replaceChildren(number, caption);
  return card;
}

function renderSourceSplit(rows) {
  if (rows.length === 0) {
    els.sourceSplit.replaceChildren(empty("No source evidence in this filter."));
    return;
  }
  const max = Math.max(...rows.map((row) => row.count), 1);
  els.sourceSplit.replaceChildren(...rows.map((row) => {
    const item = document.createElement("div");
    item.className = "bar-row";
    const label = document.createElement("span");
    label.textContent = row.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = \`\${Math.max(4, (row.count / max) * 100)}%\`;
    track.append(fill);
    const count = document.createElement("strong");
    count.textContent = String(row.count);
    item.replaceChildren(label, track, count);
    return item;
  }));
}

function renderCaptureHealth(health) {
  const summary = document.createElement("p");
  summary.textContent = \`\${health.captureGapCount} gap events, \${health.droppedObservationCount} dropped observations.\`;
  if (health.byReason.length === 0) {
    els.captureHealth.replaceChildren(summary);
    return;
  }
  const list = document.createElement("ul");
  list.className = "health-list";
  for (const row of health.byReason) {
    const item = document.createElement("li");
    item.textContent = \`\${row.reason}: \${row.eventCount} events, \${row.droppedObservationCount} dropped, last \${formatTime(row.lastObservedAt)}.\`;
    list.append(item);
  }
  els.captureHealth.replaceChildren(summary, list);
}

function renderSkillTable(rows) {
  if (rows.length === 0) {
    els.skillTable.replaceChildren(empty("No skills match this filter."));
    return;
  }
  const table = makeTable(["Skill", "Evidence", "Reads", "Activations", "Last observed"]);
  const body = table.querySelector("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const stack = document.createElement("div");
    stack.className = "skill-name";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-button";
    button.textContent = row.skillName;
    button.addEventListener("click", () => {
      state.chainSkillName = row.skillName;
      loadDashboard();
    });
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = row.canonicalPath ?? "Intent only, no canonical path";
    stack.append(button, path);
    if (row.cataloged) stack.append(badge("catalog"));
    else if (row.canonicalPath) stack.append(badge("not in observed catalog"));
    if (row.cataloged && row.uniqueObservedRunActivations === 0 && row.successfulReadCount === 0 && row.wrapperObservedCount === 0) stack.append(badge("zero observed loads"));
    name.append(stack);
    tr.append(
      name,
      cell(\`intent \${row.commandIntentCount} · wrappers \${row.wrapperObservedCount}\`),
      cell(\`success \${row.successfulReadCount} · failed \${row.failedReadCount}\`),
      cell(row.uniqueObservedRunActivations),
      cell(formatTime(row.lastObservedAt)),
    );
    body.append(tr);
  }
  els.skillTable.replaceChildren(table);
}

function renderModelMatrix(rows) {
  if (rows.length === 0) {
    els.modelMatrix.replaceChildren(empty("No model read results match this filter."));
    return;
  }
  const table = makeTable(["Skill", "Provider", "Model", "Reads", "Activations"]);
  const body = table.querySelector("tbody");
  for (const row of rows) {
    const model = row.model;
    const tr = document.createElement("tr");
    tr.append(
      cell(row.skillName),
      cell(model ? model.provider : "Unknown"),
      cell(model ? model.id : "Unknown"),
      cell(\`success \${row.successfulReadCount} · failed \${row.failedReadCount}\`),
      cell(row.uniqueObservedRunActivations),
    );
    body.append(tr);
  }
  els.modelMatrix.replaceChildren(table);
}

function renderChains(runs, chainSkillName) {
  els.chainFilterLabel.textContent = chainSkillName ? \`Skill: \${chainSkillName}\` : "All skills";
  els.clearChainSkill.hidden = !chainSkillName;
  if (runs.length === 0) {
    els.chainView.replaceChildren(empty("No observed chains match this filter."));
    return;
  }
  els.chainView.replaceChildren(...runs.map(renderRun));
}

function renderRun(run) {
  const article = document.createElement("article");
  article.className = "chain-run";
  const title = document.createElement("div");
  title.className = "chain-title";
  title.append(badge(run.projectCwd), badge(\`session \${run.sessionId ?? "unknown"}\`), badge(\`segment \${run.segmentId}\`), badge(\`run \${run.runId ?? "unknown"}\`));
  const steps = document.createElement("div");
  steps.className = "chain-steps";
  for (const step of run.steps) steps.append(renderStep(step));
  article.replaceChildren(title, steps);
  return article;
}

function renderStep(step) {
  if (step.kind === "gap") {
    const gap = document.createElement("div");
    gap.className = "chain-gap";
    gap.textContent = \`Gap: \${step.omitted} omitted (\${step.reason})\`;
    return gap;
  }
  const item = document.createElement("div");
  item.className = "chain-step";
  const time = document.createElement("p");
  time.textContent = formatTime(step.observedAt);
  const list = document.createElement("div");
  list.className = "chain-items";
  for (const observation of step.items) list.append(renderEvidence(observation.evidence));
  item.replaceChildren(time, list);
  return item;
}

function renderEvidence(evidence) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "evidence-button";
  const kind = document.createElement("span");
  kind.className = "evidence-kind";
  kind.textContent = evidence.kind;
  const detail = document.createElement("span");
  detail.textContent = \` \${evidenceLabel(evidence)}\`;
  button.append(kind, detail);
  const skill = evidenceSkill(evidence);
  if (skill) {
    button.addEventListener("click", () => {
      state.chainSkillName = skill;
      loadDashboard();
    });
  }
  return button;
}

function evidenceLabel(evidence) {
  if (evidence.kind === "command-intent") return \`\${evidence.skillName} · \${evidence.source}\`;
  if (evidence.kind === "wrapper-observed") return \`\${evidence.skill.name} · \${evidence.wrapperSource}\`;
  if (evidence.kind === "read-result") {
    const model = evidence.model ? \`\${evidence.model.provider}/\${evidence.model.id}\` : "unknown model";
    return \`\${evidence.skill.name} · \${evidence.outcome} · \${model}\`;
  }
  return "unknown evidence";
}

function evidenceSkill(evidence) {
  if (evidence.kind === "command-intent") return evidence.skillName;
  if (evidence.kind === "wrapper-observed" || evidence.kind === "read-result") return evidence.skill.name;
  return null;
}

function makeTable(headers) {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head, document.createElement("tbody"));
  return table;
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = String(value);
  return td;
}

function badge(value) {
  const span = document.createElement("span");
  span.className = "badge";
  span.textContent = String(value);
  return span;
}

function empty(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty";
  paragraph.textContent = message;
  return paragraph;
}

function formatTime(value) {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

loadDashboard();
`;
