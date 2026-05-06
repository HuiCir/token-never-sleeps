export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TNS Gateway Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-2: #f0f3f6;
      --line: #d8dee6;
      --text: #17202a;
      --muted: #5d6b7a;
      --accent: #1d6f8f;
      --green: #257a4d;
      --red: #b23b3b;
      --yellow: #8b6714;
      --blue: #2457a6;
      --purple: #6652a3;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1, h2, h3 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: 20px; font-weight: 700; }
    h2 { font-size: 15px; font-weight: 700; }
    h3 { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
    main { padding: 18px 20px 28px; }
    .subtle { color: var(--muted); }
    .topline { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
    .workspace { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 62vw; }
    .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--red); display: inline-block; }
    .status-dot.live { background: var(--green); }
    .grid { display: grid; gap: 14px; }
    .grid.summary { grid-template-columns: repeat(6, minmax(120px, 1fr)); margin-bottom: 14px; }
    .grid.two { grid-template-columns: minmax(360px, 1.2fr) minmax(360px, 1fr); }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .panel-head {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .panel-body { padding: 12px 14px; }
    .metric { padding: 12px 14px; }
    .metric strong { display: block; font-size: 22px; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    button.tab {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 7px;
      padding: 7px 10px;
      cursor: pointer;
      font: inherit;
    }
    button.tab.active { border-color: var(--accent); color: var(--accent); background: #e8f4f7; }
    .view { display: none; }
    .view.active { display: block; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 7px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.done { color: var(--green); background: #e9f6ef; border-color: #b9dfc9; }
    .pill.in_progress, .pill.active { color: var(--blue); background: #eaf1fb; border-color: #bfd0ef; }
    .pill.needs_fix, .pill.blocked { color: var(--red); background: #faeeee; border-color: #e6c1c1; }
    .pill.pending, .pill.waiting { color: var(--yellow); background: #fbf5e4; border-color: #e9d8a8; }
    .thread-board {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .thread {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      min-height: 160px;
    }
    .thread.active { border-color: #88b8c8; box-shadow: inset 3px 0 0 var(--accent); }
    .thread-title { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; margin-bottom: 8px; }
    .thread-title strong { word-break: break-word; }
    .kv { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 5px 8px; margin: 8px 0; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .skills { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
    .skill { border-color: #c9c1e8; color: var(--purple); background: #f1eefb; }
    .event-list { display: grid; gap: 7px; max-height: 520px; overflow: auto; }
    .event {
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fbfcfd;
    }
    .event code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .form-grid { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; margin-bottom: 10px; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px;
      background: #fff;
      color: var(--text);
      font: inherit;
    }
    textarea { min-height: 150px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    button.action {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 7px;
      padding: 8px 10px;
      cursor: pointer;
      font: inherit;
    }
    .pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 320px;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .empty { color: var(--muted); padding: 16px 0; }
    @media (max-width: 980px) {
      .grid.summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid.two { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .workspace { max-width: 92vw; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <span id="live-dot" class="status-dot"></span>
      <div>
        <h1>TNS Gateway Dashboard</h1>
        <div id="workspace" class="workspace">Loading workspace...</div>
      </div>
    </div>
    <div class="subtle" id="updated">Waiting for snapshot</div>
  </header>
  <main>
    <section class="grid summary" id="summary"></section>
    <nav class="tabs" id="tabs"></nav>
    <section id="views"></section>
  </main>
  <script>
    const query = new URLSearchParams(location.search);
    const state = {
      snapshot: null,
      workspaces: null,
      activeTab: "overview",
      connected: false,
      stream: null,
      workspace: query.get("workspace") || "",
      key: query.get("key") || ""
    };
    const tabs = [
      ["overview", "Overview"],
      ["threads", "Threads"],
      ["skills", "Skills"],
      ["gateway", "Gateway"],
      ["locks", "Locks"],
      ["workspaces", "Workspaces"],
      ["events", "Events"],
      ["core", "Core"]
    ];
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
    const arr = (value) => Array.isArray(value) ? value : [];
    const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const time = (value) => value ? new Date(value).toLocaleString() : "";
    const pill = (label, cls) => '<span class="pill ' + esc(cls || label || "") + '">' + esc(label || "unknown") + '</span>';
    const skillPills = (skills) => {
      const items = Array.from(new Set(arr(skills).filter(Boolean)));
      return items.length ? '<div class="skills">' + items.map((s) => '<span class="pill skill">' + esc(s) + '</span>').join("") + '</div>' : '<span class="subtle">none</span>';
    };
    function metric(label, value) {
      return '<article class="panel metric"><strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></article>';
    }
    function renderTabs() {
      $("tabs").innerHTML = tabs.map(([id, label]) =>
        '<button class="tab ' + (state.activeTab === id ? "active" : "") + '" data-tab="' + id + '">' + esc(label) + '</button>'
      ).join("");
      $("tabs").querySelectorAll("button").forEach((button) => {
        button.onclick = () => { state.activeTab = button.dataset.tab; render(); };
      });
    }
    function panel(title, body, right) {
      return '<section class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2><div class="subtle">' + esc(right || "") + '</div></div><div class="panel-body">' + body + '</div></section>';
    }
    function table(headers, rows) {
      if (!rows.length) return '<div class="empty">No records.</div>';
      return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join("") + '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join("") + '</tr>').join("") +
        '</tbody></table>';
    }
    function renderOverview(s) {
      const sectionRows = arr(s.sections).map((sec) => [
        '<span class="mono">' + esc(sec.id) + '</span>',
        esc(sec.title),
        pill(sec.status, sec.status),
        esc(sec.current_step || ""),
        esc(sec.last_summary || ""),
        esc(sec.verified_at || "")
      ]);
      const runtime = obj(s.runtime);
      const runtimeBody = '<dl class="kv">' +
        '<dt>active</dt><dd>' + pill(runtime.active ? "active" : "idle", runtime.active ? "active" : "pending") + '</dd>' +
        '<dt>pid</dt><dd>' + esc(runtime.pid || "") + '</dd>' +
        '<dt>agent</dt><dd>' + esc(runtime.current_agent || "") + '</dd>' +
        '<dt>section</dt><dd>' + esc(runtime.current_section || "") + '</dd>' +
        '<dt>step</dt><dd>' + esc(runtime.current_step || "") + '</dd>' +
        '<dt>command</dt><dd>' + esc(runtime.command || "") + '</dd>' +
      '</dl>';
      return '<div class="grid two">' +
        panel("Sections", table(["ID", "Title", "Status", "Step", "Summary", "Verified"], sectionRows), arr(s.sections).length + " total") +
        panel("Runtime", runtimeBody, runtime.heartbeat_alive ? "heartbeat live" : "heartbeat unknown") +
      '</div>';
    }
    function renderThreads(s) {
      const threads = arr(s.threads);
      if (!threads.length) return panel("Agent Threads", '<div class="empty">No agent thread events yet.</div>');
      const body = '<div class="thread-board">' + threads.map((t) => {
        const runs = arr(t.runs).slice(-6).reverse();
        return '<article class="thread ' + (t.active ? "active" : "") + '">' +
          '<div class="thread-title"><strong>' + esc(t.title || t.section || t.id) + '</strong>' + pill(t.active ? "active" : t.status, t.active ? "active" : t.status) + '</div>' +
          '<dl class="kv">' +
            '<dt>section</dt><dd class="mono">' + esc(t.section || "") + '</dd>' +
            '<dt>agent</dt><dd>' + esc(t.current_agent || t.last_agent || "") + '</dd>' +
            '<dt>step</dt><dd>' + esc(t.current_step || t.last_step || "") + '</dd>' +
            '<dt>pid</dt><dd>' + esc(t.agent_pid || "") + '</dd>' +
            '<dt>batch</dt><dd>' + esc(t.parallel_batch || "") + '</dd>' +
          '</dl>' +
          '<h3>Skills</h3>' + skillPills(t.skills) +
          '<h3 style="margin-top:10px">Recent Runs</h3>' +
          (runs.length ? runs.map((r) => '<div class="event"><code>' + esc(r.agent || "") + '</code> ' + esc(r.event || "") + '<br><span class="subtle">' + esc(r.step || "") + ' ' + time(r.at) + '</span></div>').join("") : '<div class="empty">No runs.</div>') +
        '</article>';
      }).join("") + '</div>';
      return panel("Agent Threads", body, threads.length + " lanes");
    }
    function renderSkills(s) {
      const rows = arr(s.skill_injections).map((item) => [
        esc(item.at || ""),
        esc(item.section || item.section_id || ""),
        esc(item.agent || item.profile || item.mode || ""),
        skillPills(item.skills || item.injected_skills || item.auto_skills || item.explicit_skills),
        '<pre class="pre">' + esc(JSON.stringify(item.skill_matches || item.matches || {}, null, 2)) + '</pre>'
      ]);
      const sources = arr(obj(s.config).skill_sources).map((source) => [
        esc(source.id || ""),
        esc(source.kind || ""),
        esc(source.path || source.url || ""),
        esc(source.enabled === false ? "disabled" : "enabled")
      ]);
      return '<div class="grid two">' +
        panel("Skill Injections", table(["At", "Section", "Agent", "Skills", "Matches"], rows), rows.length + " events") +
        panel("Skill Sources", table(["ID", "Kind", "Path", "State"], sources), sources.length + " sources") +
      '</div>';
    }
    function renderGateway(s) {
      const gateway = obj(s.gateway);
      const clientRows = Object.values(obj(gateway.clients)).map((client) => [
        esc(client.id), esc(client.pid), esc(client.heartbeat_at), '<pre class="pre">' + esc(JSON.stringify(client.meta || {}, null, 2)) + '</pre>'
      ]);
      const taskRows = arr(gateway.tasks).map((task) => [
        esc(task.id), pill(task.status, task.status), esc(task.from), esc(task.to || ""), esc(task.claimant || ""), esc(task.title)
      ]);
      return '<div class="grid two">' +
        panel("Gateway Clients", table(["ID", "PID", "Heartbeat", "Meta"], clientRows), gateway.active ? "active" : "idle") +
        panel("Gateway Tasks", table(["ID", "Status", "From", "To", "Claimant", "Title"], taskRows), taskRows.length + " tasks") +
      '</div>';
    }
    function renderLocks(s) {
      const locks = obj(s.locks).resources || {};
      const rows = Object.entries(locks).map(([name, info]) => [
        esc(name), esc(info.pid), esc(info.command), esc(info.acquired_at)
      ]);
      const waits = arr(obj(obj(s.gateway).status).waiters).map((w) => [
        esc(w.client_id), esc(w.resource), esc(w.created_at), esc(w.deadline_at)
      ]);
      return '<div class="grid two">' +
        panel("Resource Locks", table(["Resource", "PID", "Command", "Acquired"], rows), rows.length + " held") +
        panel("Gateway Waiters", table(["Client", "Resource", "Created", "Deadline"], waits), waits.length + " waiting") +
      '</div>';
    }
    function workspaceQuery() {
      const params = new URLSearchParams();
      if (state.workspace) params.set("workspace", state.workspace);
      if (state.key) params.set("key", state.key);
      const text = params.toString();
      return text ? "?" + text : "";
    }
    function api(path) {
      const sep = path.includes("?") ? "&" : "?";
      const params = new URLSearchParams();
      if (state.workspace) params.set("workspace", state.workspace);
      if (state.key) params.set("key", state.key);
      if (!state.workspace) params.set("_default", "1");
      return path + sep + params.toString();
    }
    function authHeaders() {
      return state.key ? { "x-tns-dashboard-key": state.key } : {};
    }
    function rememberKey() {
      if (!state.key) return;
      localStorage.setItem("tns-dashboard-key:" + (state.workspace || "default"), state.key);
    }
    function restoreKey() {
      if (state.key) return;
      state.key = localStorage.getItem("tns-dashboard-key:" + (state.workspace || "default")) || localStorage.getItem("tns-dashboard-key:default") || "";
    }
    async function switchWorkspace(workspace, key) {
      state.workspace = workspace || "";
      if (key) state.key = key;
      const next = new URL(location.href);
      if (state.workspace) next.searchParams.set("workspace", state.workspace);
      else next.searchParams.delete("workspace");
      if (state.key) next.searchParams.set("key", state.key);
      else next.searchParams.delete("key");
      history.replaceState(null, "", next);
      rememberKey();
      if (state.stream) state.stream.close();
      await loadWorkspaceList();
      await loadSnapshot();
      startStream();
    }
    async function loadWorkspaceList() {
      try {
        state.workspaces = await (await fetch("/api/workspaces" + (state.key ? "?key=" + encodeURIComponent(state.key) : ""), { cache: "no-store", headers: authHeaders() })).json();
      } catch {
        state.workspaces = null;
      }
    }
    async function initWorkspaceFromForm(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const body = {
        name: form.elements.name.value,
        thread: Number(form.elements.thread.value || 1),
        template: form.elements.template.value,
        task: form.elements.task.value,
        dashboard: true
      };
      const res = await fetch("/api/workspaces/init", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(body)
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        alert(payload.error || "workspace init failed");
        return;
      }
      form.reset();
      await switchWorkspace(payload.workspace, payload.result && payload.result.dashboard && payload.result.dashboard.key);
    }
    function renderWorkspaces(s) {
      const listing = obj(state.workspaces);
      const rows = arr(listing.workspaces).map((item) => [
        esc(item.name),
        '<span class="mono">' + esc(item.workspace) + '</span>',
        esc(item.sections),
        (item.default ? pill("default", "active") : "") + (item.dashboard_enabled ? " " + pill("dashboard", "done") : ""),
        '<button class="tab" data-workspace="' + esc(item.workspace) + '">Open</button>'
      ]);
      const defaultTask = '# Task\\n\\n## Test Section\\nCreate test-output.json with {"ok":true}.\\n\\nAcceptance criteria:\\n- test-output.json exists.\\n- It parses as JSON and ok is true.\\n';
      const form = '<form id="init-form">' +
        '<div class="form-grid">' +
          '<label>Name<input name="name" placeholder="tns-web-test-' + Date.now() + '"></label>' +
          '<label>Thread<input name="thread" type="number" min="1" max="8" value="1"></label>' +
          '<label>Template<select name="template"><option value="blank">blank</option><option value="novel-writing">novel-writing</option></select></label>' +
        '</div>' +
        '<label>task.md<textarea name="task">' + esc(defaultTask) + '</textarea></label>' +
        '<div style="margin-top:10px"><button class="action" type="submit">Init Workspace</button></div>' +
      '</form>';
      const body = '<div class="grid two">' +
        panel("Create Sibling Workspace", form, listing.parent || "") +
        panel("Available Workspaces", table(["Name", "Path", "Sections", "Binding", ""], rows), rows.length + " found") +
      '</div>';
      setTimeout(() => {
        const initForm = document.getElementById("init-form");
        if (initForm) initForm.onsubmit = initWorkspaceFromForm;
        document.querySelectorAll("[data-workspace]").forEach((button) => {
          button.onclick = () => switchWorkspace(button.dataset.workspace);
        });
      }, 0);
      return body;
    }
    function renderEvents(s) {
      const events = [].concat(arr(s.activity), arr(s.gateway_events), arr(s.hook_events), arr(s.lock_events)).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 120);
      const body = '<div class="event-list">' + events.map((event) =>
        '<div class="event"><code>' + esc(event.event || event.hook_event || "event") + '</code> <span class="subtle">' + esc(event.at || "") + '</span><pre class="pre">' + esc(JSON.stringify(event, null, 2)) + '</pre></div>'
      ).join("") + '</div>';
      return panel("Recent Events", body || '<div class="empty">No events.</div>', events.length + " shown");
    }
    function renderCore(s) {
      const bodies = [
        panel("Task Document", '<dl class="kv"><dt>path</dt><dd>' + esc(obj(s.task).path || "") + '</dd><dt>bytes</dt><dd>' + esc(obj(s.task).bytes || 0) + '</dd></dl><pre class="pre">' + esc(obj(s.task).preview || "") + '</pre>'),
        panel("Dashboard Binding", '<pre class="pre">' + esc(JSON.stringify(s.dashboard || {}, null, 2)) + '</pre>'),
        panel("Compiled Program", '<pre class="pre">' + esc(JSON.stringify(s.compiled_program || {}, null, 2)) + '</pre>'),
        panel("Approvals", '<pre class="pre">' + esc(JSON.stringify(s.approvals || {}, null, 2)) + '</pre>'),
        panel("Diagnostics", '<pre class="pre">' + esc(JSON.stringify(s.diagnostics || {}, null, 2)) + '</pre>'),
        panel("Artifacts", '<pre class="pre">' + esc(JSON.stringify(s.artifacts || [], null, 2)) + '</pre>'),
        panel("Reviews", '<pre class="pre">' + esc(JSON.stringify(s.reviews || [], null, 2)) + '</pre>'),
        panel("Exploration", '<pre class="pre">' + esc(JSON.stringify(s.exploration || {}, null, 2)) + '</pre>'),
        panel("Workflow", '<pre class="pre">' + esc(JSON.stringify(obj(s.config).workflow || {}, null, 2)) + '</pre>')
      ];
      return '<div class="grid two">' + bodies.join("") + '</div>';
    }
    function render() {
      const s = state.snapshot;
      renderTabs();
      $("live-dot").className = "status-dot " + (state.connected ? "live" : "");
      if (!s) return;
      $("workspace").textContent = s.workspace;
      $("updated").textContent = "Updated " + time(s.generated_at);
      const statuses = obj(s.section_counts);
      $("summary").innerHTML =
        metric("sections", arr(s.sections).length) +
        metric("done", statuses.done || 0) +
        metric("active threads", arr(s.threads).filter((t) => t.active).length) +
        metric("skills", arr(s.skill_injections).length) +
        metric("gateway tasks", arr(obj(s.gateway).tasks).length) +
        metric("locks", Object.keys(obj(obj(s.locks).resources)).length);
      const views = {
        overview: renderOverview(s),
        threads: renderThreads(s),
        skills: renderSkills(s),
        gateway: renderGateway(s),
        locks: renderLocks(s),
        workspaces: renderWorkspaces(s),
        events: renderEvents(s),
        core: renderCore(s)
      };
      $("views").innerHTML = Object.entries(views).map(([id, html]) => '<div class="view ' + (id === state.activeTab ? "active" : "") + '">' + html + '</div>').join("");
    }
    async function loadSnapshot() {
      const res = await fetch(api("/api/snapshot"), { cache: "no-store", headers: authHeaders() });
      state.snapshot = await res.json();
      render();
    }
    function startStream() {
      if (!window.EventSource) {
        setInterval(loadSnapshot, 2000);
        return;
      }
      const stream = new EventSource("/api/stream" + workspaceQuery());
      state.stream = stream;
      stream.onopen = () => { state.connected = true; render(); };
      stream.onerror = () => { state.connected = false; render(); };
      stream.addEventListener("snapshot", (event) => {
        state.snapshot = JSON.parse(event.data);
        state.connected = true;
        render();
      });
    }
    restoreKey();
    rememberKey();
    loadWorkspaceList().then(loadSnapshot).catch(() => loadSnapshot()).catch(() => {});
    startStream();
  </script>
</body>
</html>`;
