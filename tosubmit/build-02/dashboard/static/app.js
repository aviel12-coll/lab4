"use strict";
/* Agent traffic dashboard. Polls /api/state once a second (only changes are sent),
   renders the request list, the detail pane, the tool-call table and the charts. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  gen: 0, version: 0,
  ex: new Map(),        // id -> exchange summary
  order: [],            // summaries by request number
  tools: new Map(),     // tool_use id -> tool summary
  groups: {},
  selected: null, detail: null, detailVer: -1,
  tab: "traffic", graphMode: "request",
  toolChip: "", expandedTool: null,
  dirty: { tools: true, graphs: true },
};

const ROLE = {
  prompt: { label: "New prompt", icon: "›" },
  tool:   { label: "Tool loop", icon: "⚙" },
  answer: { label: "Final answer", icon: "✓" },
  side:   { label: "Side request", icon: "↪" },
  error:  { label: "Error", icon: "✕" },
};
const KIND = {
  you: { label: "YOU", icon: "›" }, model: { label: "MODEL", icon: "◆" },
  thinking: { label: "THINKING", icon: "…" }, tool_call: { label: "TOOL CALL", icon: "⚙" },
  tool_result: { label: "RESULT", icon: "↩" }, system: { label: "SYSTEM", icon: "§" },
  harness: { label: "HARNESS", icon: "⌁" }, error: { label: "ERROR", icon: "✕" }, other: { label: "BLOCK", icon: "·" },
};
// Categorical chart palette (fixed order, light / dark steps).
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark:  ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  other: "#898781",
};

/* ------------------------------------------------------------------ formatting */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtNum(n) {
  n = n || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, "") + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString();
}
function fmtCost(c) {
  c = c || 0;
  if (c === 0) return "$0";
  if (c < 0.01) return "$" + c.toFixed(4);
  if (c < 10) return "$" + c.toFixed(3);
  return "$" + c.toFixed(2);
}
function fmtMs(ms) {
  if (ms == null) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + " s";
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
function fmtBytes(b) {
  b = b || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(2) + " MB";
}
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const shortModel = (m) => (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const squash = (s, n = 140) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function inputSummary(inp) {
  if (inp && typeof inp === "object" && !Array.isArray(inp)) {
    for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill", "notebook_path"]) {
      if (typeof inp[k] === "string" && inp[k].trim()) return squash(inp[k], 160);
    }
    return squash(JSON.stringify(inp), 160);
  }
  return squash(String(inp ?? ""), 160);
}

function jsonHtml(v) {
  const s = typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? String(v));
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="j-key">${esc(m[1])}</span>${m[2]}` : `<span class="j-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="j-lit">${m[3]}</span>`;
    else out += `<span class="j-num">${m[4]}</span>`;
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}
function maybeJson(text) {
  const t = (text || "").trim();
  if (!/^[\[{]/.test(t) || t.length > 2e6) return null;
  try { return JSON.parse(t); } catch { return null; }
}
/** Long text gets cut to a few lines with a "show all" button. */
function clamp(innerHtml, text, cls = "msg-body") {
  const lines = (text || "").split("\n").length;
  const long = lines > 14 || (text || "").length > 1400;
  return `<div class="${cls}${long ? " clamp closed" : ""}">${innerHtml}</div>` +
    (long ? `<button class="more-btn" data-clamp>Show all (${plural(lines, "line")}, ${fmtNum((text || "").length)} chars)</button>` : "");
}
function textBlock(text, { code = false } = {}) {
  const j = maybeJson(text);
  if (j !== null) return clamp(`<pre class="json">${jsonHtml(j)}</pre>`, JSON.stringify(j, null, 2));
  return clamp(esc(text), text, code ? "msg-body code" : "msg-body");
}
const badge = (kind, extra = "", cls = "") =>
  `<span class="badge k-${kind} ${cls}">${KIND[kind].icon} ${KIND[kind].label}${extra ? " · " + esc(extra) : ""}</span>`;
const roleBadge = (role) => `<span class="badge r-${role}">${ROLE[role].icon} ${ROLE[role].label}</span>`;

/* ------------------------------------------------------------------ theme */
const THEMES = ["system", "light", "dark"];
function currentTheme() { return document.documentElement.dataset.theme || "system"; }
function isDark() {
  const t = currentTheme();
  return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}
function setTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", t); } catch {}
  $("#themeBtn").textContent = { system: "◐ System", light: "☀ Light", dark: "☾ Dark" }[t];
  rebuildCharts();
}
$("#themeBtn").addEventListener("click", () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % 3]));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => rebuildCharts());
$("#themeBtn").textContent = { system: "◐ System", light: "☀ Light", dark: "☾ Dark" }[currentTheme()];
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ------------------------------------------------------------------ polling */
async function poll() {
  try {
    const r = await fetch(`/api/state?gen=${state.gen}&since=${state.version}`, { cache: "no-store" });
    const s = await r.json();
    $("#liveDot").className = "live-dot on";
    $("#liveDot").title = "live: polling every second";
    apply(s);
  } catch (e) {
    $("#liveDot").className = "live-dot off";
    $("#liveDot").title = "cannot reach the dashboard server";
  }
  setTimeout(poll, 1000);
}

function apply(s) {
  if (s.full) {
    if (state.gen && s.generation !== state.gen) { state.selected = null; state.detail = null; }
    state.ex.clear(); state.tools.clear();
  }
  const changed = s.full || s.version !== state.version;
  state.gen = s.generation;
  state.version = s.version;
  state.groups = s.groups || {};
  for (const e of s.exchanges) state.ex.set(e.id, e);
  for (const t of s.tools) state.tools.set(t.id, t);
  $("#logPath").textContent = s.log_exists ? s.log : `waiting for ${s.log} (start proxy.py)`;
  if (!changed) return;
  state.order = [...state.ex.values()].sort((a, b) => a.n - b.n);
  state.dirty.tools = state.dirty.graphs = true;
  renderStats();
  renderToolOptions();
  renderList();
  if (state.tab === "tools") renderTools();
  if (state.tab === "graphs") renderGraphs();
  if (!state.selected && state.order.length) select(state.order[state.order.length - 1].id);
  else if (state.selected) {
    const sel = state.ex.get(state.selected);
    const touched = s.tools.some((t) => sel && (t.call_n === sel.n || t.result_n === sel.n));
    if (sel && (sel.ver !== state.detailVer || touched)) loadDetail(sel.id, true);
    if (!sel) { state.selected = null; $("#detail").innerHTML = `<div class="empty">Select a request.</div>`; }
  }
  if (!state.order.length) $("#detail").innerHTML = `<div class="empty">No traffic yet. Start <code>python3 proxy.py</code>, then run the agent with <code>ANTHROPIC_BASE_URL=http://localhost:8041</code>. Requests appear here as they happen.</div>`;
}

/* ------------------------------------------------------------------ global stats */
function groupSums(rows) {
  const map = new Map();
  for (const e of rows) {
    if (!map.has(e.group)) map.set(e.group, { group: e.group, label: e.group_label, rows: [], tokens: 0, cost: 0, time: 0, calls: 0 });
    const g = map.get(e.group);
    g.rows.push(e); g.tokens += e.tokens; g.cost += e.cost; g.time += e.duration_ms || 0; g.calls += e.calls.length;
  }
  return [...map.values()];
}
function deltaHtml(cur, prev, fmt, { relative = true, judged = true, what = "previous" } = {}) {
  if (prev == null) return `<span>first ${what === "previous" ? "request" : what}</span>`;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return `= same as ${what}`;
  const arrow = d > 0 ? "↑" : "↓";
  const cls = judged ? (d > 0 ? "up" : "down") : "";
  const amount = relative && prev ? Math.round((Math.abs(d) / prev) * 100) + "%" : fmt(Math.abs(d));
  return `<span class="${cls}">${arrow} ${amount}</span> vs ${what}`;
}
function tile(label, value, sub) {
  return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="delta">${sub || "&nbsp;"}</div></div>`;
}
function renderStats() {
  const all = state.order.filter((e) => !e.pending);
  const sum = (f) => all.reduce((a, e) => a + (f(e) || 0), 0);
  const groups = groupSums(all.filter((e) => !e.side));
  const last = groups[groups.length - 1], prev = groups[groups.length - 2];
  const sub = (key, fmt, judged = true) => last
    ? `this prompt ${fmt(last[key])} · ${deltaHtml(last[key], prev ? prev[key] : null, fmt, { judged, what: prev ? "previous prompt" : "prompt", relative: key !== "calls" })}`
    : "";
  $("#globalTiles").innerHTML =
    tile("Total tokens", fmtNum(sum((e) => e.tokens)), sub("tokens", fmtNum)) +
    tile("Estimated cost", fmtCost(sum((e) => e.cost)), sub("cost", fmtCost)) +
    tile("Time waiting for the model", fmtMs(sum((e) => e.duration_ms)), sub("time", fmtMs)) +
    tile("Tool calls", fmtNum(sum((e) => e.calls.length)), sub("calls", fmtNum, false));
  const ttfbs = all.filter((e) => e.ttfb_ms != null);
  const bits = [
    ["requests", state.order.length], ["prompts", groups.length], ["side requests", all.filter((e) => e.side).length],
    ["errors", state.order.filter((e) => e.role === "error").length],
    ["input", fmtNum(sum((e) => e.usage.input))], ["output", fmtNum(sum((e) => e.usage.output))],
    ["cache read", fmtNum(sum((e) => e.usage.cache_read))], ["cache write", fmtNum(sum((e) => e.usage.cache_write))],
    ["avg time to first byte", fmtMs(ttfbs.length ? ttfbs.reduce((a, e) => a + e.ttfb_ms, 0) / ttfbs.length : null)],
    ["sent", fmtBytes(sum((e) => e.req_bytes))], ["received", fmtBytes(sum((e) => e.resp_bytes))],
  ];
  $("#globalMore").innerHTML = "More: " + bits.map(([k, v]) => `${k} <b>${v}</b>`).join(" · ") +
    ` · <span title="Prices come from dashboard/pricing.json">cost is an estimate</span>`;
}

/* ------------------------------------------------------------------ request list */
$("#roleLegend").innerHTML = Object.keys(ROLE).map(roleBadge).join("");

function renderToolOptions() {
  const names = toolNames();
  const sel = $("#toolFilter"), cur = sel.value, key = names.join("\u0000");
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.innerHTML = `<option value="">all tools</option>` + names.map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
}
function toolNames() {
  // In order of first use, so colours follow the tool and never get reshuffled.
  const seen = new Map();
  for (const t of [...state.tools.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))) if (t.name && t.name !== "?" && !seen.has(t.name)) seen.set(t.name, 1);
  return [...seen.keys()];
}
function toolColor(name) {
  const i = toolNames().indexOf(name);
  const pal = isDark() ? PALETTE.dark : PALETTE.light;
  return i >= 0 && i < pal.length ? pal[i] : PALETTE.other;
}

function filteredRows() {
  const q = $("#search").value.trim().toLowerCase();
  const tool = $("#toolFilter").value;
  const hideSide = $("#hideSide").checked, errorsOnly = $("#errorsOnly").checked;
  return state.order.filter((e) =>
    (!hideSide || !e.side) &&
    (!errorsOnly || e.role === "error" || e.failed_results > 0) &&
    (!tool || e.calls.includes(tool) || e.results.includes(tool)) &&
    (!q || (e.preview + " " + e.sub + " " + e.calls.join(" ")).toLowerCase().includes(q)));
}

function rowHtml(e) {
  const nums = [];
  if (e.pending) nums.push(`<span class="spinner" aria-hidden="true"></span> running ${fmtMs(Date.now() - e.ts * 1000)}`);
  else {
    nums.push(`${fmtNum(e.tokens)} tokens`, fmtCost(e.cost), fmtMs(e.duration_ms));
    if (e.calls.length) nums.push(plural(e.calls.length, "tool call"));
  }
  nums.push(shortModel(e.model) || `${e.method} ${e.path}`);
  const extra = [];
  if (e.subagent) extra.push(`<span class="badge plain">subagent</span>`);
  if (e.role === "prompt" && !e.pending && !e.calls.length) extra.push(`<span class="badge plain">✓ answered directly</span>`);
  if (e.failed_results) extra.push(`<span class="badge k-tool_result failed">✕ ${plural(e.failed_results, "failed result")}</span>`);
  if (e.status && e.status >= 400 && e.role === "error") extra.push(`<span class="badge plain">HTTP ${e.status}</span>`);
  return `<li class="req r-${e.role}${e.id === state.selected ? " selected" : ""}" data-id="${esc(e.id)}" tabindex="0">
    <div class="req-head">${roleBadge(e.role)}${extra.join("")}<span class="muted small">#${e.n} · ${fmtTime(e.ts)}</span></div>
    <div class="req-preview">${esc(e.preview || "(empty)")}</div>
    ${e.sub ? `<div class="req-sub">${esc(e.sub)}</div>` : ""}
    <div class="req-nums">${nums.map((x) => `<span>${x}</span>`).join("")}</div>
  </li>`;
}

function renderList() {
  const rows = filteredRows().reverse();
  let html = "", lastGroup = null;
  for (const e of rows) {
    if (e.group !== lastGroup) {
      const g = groupSums(state.order.filter((x) => x.group === e.group))[0];
      html += `<li class="group-sep">Prompt: “${esc(e.group_label || "…")}” · ${plural(g.rows.length, "request")} · ${fmtNum(g.tokens)} tokens · ${fmtCost(g.cost)}</li>`;
      lastGroup = e.group;
    }
    html += rowHtml(e);
  }
  $("#reqList").innerHTML = html || `<li class="empty">${state.order.length ? "Nothing matches the filters." : "No requests yet."}</li>`;
}
["#search", "#toolFilter", "#hideSide", "#errorsOnly"].forEach((s) => $(s).addEventListener("input", renderList));

$("#reqList").addEventListener("click", (ev) => {
  const li = ev.target.closest(".req");
  if (li) select(li.dataset.id);
});
$("#reqList").addEventListener("keydown", (ev) => {
  const li = ev.target.closest(".req");
  if (!li) return;
  if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(li.dataset.id); }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const items = $$(".req", $("#reqList"));
    const next = items[items.indexOf(li) + (ev.key === "ArrowDown" ? 1 : -1)];
    if (next) { next.focus(); select(next.dataset.id); }
  }
});

function select(id) {
  state.selected = id;
  $$(".req.selected").forEach((el) => el.classList.remove("selected"));
  const li = $(`.req[data-id="${CSS.escape(id)}"]`);
  if (li) li.classList.add("selected");
  loadDetail(id, false);
}

/* ------------------------------------------------------------------ detail pane */
async function loadDetail(id, keepScroll) {
  let d;
  try {
    const r = await fetch("/api/exchange/" + encodeURIComponent(id), { cache: "no-store" });
    if (!r.ok) return;
    d = await r.json();
  } catch { return; }
  if (state.selected !== id) return;
  const pane = $("#detail");
  const scroll = pane.scrollTop;
  const open = keepScroll ? $$("details[data-key]", pane).filter((x) => x.open).map((x) => x.dataset.key) : [];
  const expanded = keepScroll ? $$(".clamp:not(.closed)", pane).map((x) => x.closest("[data-key]")?.dataset.key).filter(Boolean) : [];
  state.detail = d;
  state.detailVer = d.summary.ver;
  renderDetail(d);
  for (const key of open) { const el = $(`details[data-key="${CSS.escape(key)}"]`, pane); if (el) { el.open = true; fillLazy(el); } }
  for (const key of expanded) { const el = $(`[data-key="${CSS.escape(key)}"] .clamp.closed`, pane); if (el) toggleClamp(el.nextElementSibling); }
  pane.scrollTop = keepScroll ? scroll : 0;
}

function previousOf(s) {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const e = state.order[i];
    if (e.n < s.n && e.side === s.side && !e.pending && e.role !== "error") return e;
  }
  return null;
}

function callCard(p, key) {
  const where = p.call_n ? `<button class="link" data-open-n="${p.call_n}">asked in #${p.call_n}</button>` : `<span class="small">asked before the proxy started</span>`;
  const inp = p.input;
  return `<div class="msg k-tool_call" data-key="${key}-call">
    <div class="msg-head">${badge("tool_call", p.name)}${where}</div>
    <div class="call-summary">${esc(inputSummary(inp))}</div>
    ${inp != null && typeof inp === "object" && (Object.keys(inp).length > 1 || JSON.stringify(inp).length > 150) ? clamp(`<pre class="json">${jsonHtml(inp)}</pre>`, JSON.stringify(inp, null, 2), "msg-body code") : ""}
  </div>`;
}
function resultCard(p, key, ctx) {
  if (p.kind === "tool_call" && (p.result == null)) {
    const msg = ctx === "reply" ? "Waiting for the result. It is sent back in the next request." : "No result captured.";
    return `<div class="msg pending" data-key="${key}-res"><div class="msg-head"><span class="badge r-pending">↩ RESULT · ${esc(p.name)}</span></div><div class="small">${msg}</div></div>`;
  }
  const text = p.kind === "tool_call" ? p.result : p.text;
  const failed = !!p.is_error;
  const where = p.result_n ? `<button class="link" data-open-n="${p.result_n}">sent back in #${p.result_n}</button>` : "";
  const wait = p.wait_ms != null ? `<span class="small">tool ran ${fmtMs(p.wait_ms)}</span>` : "";
  return `<div class="msg k-tool_result${failed ? " failed" : ""}" data-key="${key}-res">
    <div class="msg-head">${badge("tool_result", (p.name || "?") + (failed ? " · ✕ failed" : ""), failed ? "failed" : "")}${where}${wait}</div>
    ${textBlock(text || "(empty result)", { code: true })}
  </div>`;
}

function partsHtml(parts, ctx, keyPrefix) {
  let html = "";
  parts.forEach((p, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (p.kind) {
      case "you":
        html += `<div class="msg k-you" data-key="${key}"><div class="msg-head">${badge("you")}</div>${textBlock(p.text)}</div>`; break;
      case "model":
        html += `<div class="msg k-model" data-key="${key}"><div class="msg-head">${badge("model")}</div>${textBlock(p.text)}</div>`; break;
      case "thinking":
        html += `<details class="card k-thinking" data-key="${key}"><summary>${badge("thinking")}<span class="small muted">${fmtNum(p.text.length)} chars · ${esc(squash(p.text, 80))}</span></summary><div class="card-body">${textBlock(p.text)}</div></details>`; break;
      case "harness":
        html += `<details class="inline-harness" data-key="${key}"><summary>${badge("harness")}<span>${esc(squash(p.text.replace(/<\/?[\w-]+>/g, " "), 110))}</span></summary>${clamp(esc(p.text), p.text)}</details>`; break;
      case "tool_call":
        html += `<div class="pair">${callCard(p, key)}${resultCard(p, key, ctx)}</div>`; break;
      case "tool_result":
        html += `<div class="pair">${p.input !== undefined || p.call_n ? callCard({ ...p, input: p.input }, key) : `<div class="msg pending"><div class="small">Call not captured.</div></div>`}${resultCard(p, key, ctx)}</div>`; break;
      default:
        html += `<div class="msg k-other" data-key="${key}"><div class="msg-head">${badge("other")}</div>${textBlock(p.text, { code: true })}</div>`;
    }
  });
  return html;
}

function renderDetail(d) {
  const s = d.summary;
  let status;
  if (s.pending) status = `<span class="d-status wait"><span class="spinner"></span> Waiting for the reply…</span>`;
  else if (s.error) status = `<span class="d-status bad">✕ Failed: ${esc(s.error)}</span>`;
  else status = `<span class="d-status ok">✓ ${esc(s.status)} ${esc(s.reason || "")}</span><span class="muted small">${esc(s.stop_reason || "")}</span>`;

  const newParts = d.new.parts.length
    ? partsHtml(d.new.parts, "new", "new")
    : `<div class="msg k-other"><div class="msg-body small">${d.body_is_json ? "No messages in this request." : `No JSON body: ${esc(s.method)} ${esc(s.path)}`}</div></div>`;
  let reply = "";
  if (s.error) reply += `<div class="msg k-error"><div class="msg-head">${badge("error")}${s.status ? `<span class="small">HTTP ${esc(s.status)}</span>` : ""}</div><div class="msg-body">${esc(s.error)}</div></div>`;
  if (s.pending) reply += `<div class="msg pending"><div class="msg-head"><span class="spinner"></span> waiting for the model…</div></div>`;
  reply += partsHtml(d.reply, "reply", "reply");
  if (!s.pending && !s.error && !d.reply.length) reply += `<div class="msg k-other"><div class="msg-body small">The reply had no message content (see Details for the raw response).</div></div>`;

  const p = previousOf(s);
  const tiles = s.pending ? "" : `<div class="d-section-title">The numbers</div><div class="d-tiles">
    ${tile("Total tokens", fmtNum(s.tokens), deltaHtml(s.tokens, p?.tokens, fmtNum))}
    ${tile("Estimated cost", fmtCost(s.cost), deltaHtml(s.cost, p?.cost, fmtCost))}
    ${tile("Time", fmtMs(s.duration_ms), deltaHtml(s.duration_ms, p?.duration_ms, fmtMs))}
    ${tile("Tool calls", s.calls.length, deltaHtml(s.calls.length, p ? p.calls.length : null, String, { relative: false, judged: false }))}
  </div>`;

  const sysChars = d.system.reduce((a, t) => a + t.length, 0);
  const kinds = {};
  d.history.forEach((m) => m.parts.forEach((x) => (kinds[x.kind] = (kinds[x.kind] || 0) + 1)));
  const histSummary = Object.entries(kinds).map(([k, n]) => `${n} ${(KIND[k] || KIND.other).label.toLowerCase()}`).join(", ");
  const breakdown = `<div class="d-section-title">What the harness sent</div>
    <details class="card k-system" data-key="sys" data-lazy="system"><summary>${badge("system")}<span class="small muted">${plural(d.system.length, "block")} · ${fmtNum(sysChars)} chars, shown in full</span></summary><div class="card-body"></div></details>
    <details class="card" data-key="tools" data-lazy="tools"><summary><span class="badge plain">⚙ Tool definitions</span><span class="small muted">${plural(d.tools.length, "tool")}${d.tools.length ? ": " + esc(squash(d.tools.map((t) => t.name).join(", "), 120)) : ""}</span></summary><div class="card-body"></div></details>
    <details class="card" data-key="hist" data-lazy="history"><summary><span class="badge plain">☰ Conversation so far</span><span class="small muted">${plural(d.history.length, "earlier message")}${histSummary ? " · " + histSummary : ""}</span></summary><div class="card-body"></div></details>`;

  const u = s.usage, raw = d.usage_raw || {};
  const kv = [
    ["New input tokens", fmtNum(u.input)], ["Cache read", fmtNum(u.cache_read)],
    ["Cache write", `${fmtNum(u.cache_write)}${u.cache_write_1h ? ` (1h: ${fmtNum(u.cache_write_1h)})` : ""}`],
    ["Output tokens", fmtNum(u.output)], ["Time to first byte", fmtMs(s.ttfb_ms)], ["Total time", fmtMs(s.duration_ms)],
    ["Request size", fmtBytes(s.req_bytes)], ["Response size", fmtBytes(s.resp_bytes)],
    ["Messages", s.n_messages], ["Tools offered", s.n_tools], ["Stop reason", s.stop_reason || "–"],
    ["Model", s.model || "–"], ["Endpoint", `${s.method} ${s.path}`], ["Upstream", d.upstream || "–"],
    ["Message id", d.message_id || "–"], ["Proxy record id", s.id],
  ];
  if (raw.service_tier) kv.push(["Service tier", raw.service_tier]);
  if (d.proxy_error) kv.push(["Proxy error", d.proxy_error]);
  const hdrs = (h) => `<table class="hdr-table">${h.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const details = `<details class="card details-l3" data-key="l3"><summary><span class="badge plain">Details</span><span class="small muted">cache, sizes, timing, parameters, headers, raw JSON</span></summary><div class="card-body">
      <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <details class="card" data-key="params"><summary>Parameters</summary><div class="card-body"><pre class="json">${jsonHtml(d.params)}</pre></div></details>
      <details class="card" data-key="usage"><summary>Usage as reported by the API</summary><div class="card-body"><pre class="json">${jsonHtml(raw)}</pre></div></details>
      <details class="card" data-key="reqh"><summary>Request headers (${d.request_headers.length})</summary><div class="card-body">${hdrs(d.request_headers)}</div></details>
      <details class="card" data-key="resh"><summary>Response headers (${d.response_headers.length})</summary><div class="card-body">${hdrs(d.response_headers)}</div></details>
      <details class="card" data-key="rawreq" data-lazy="raw-request"><summary>Raw request body (${fmtBytes(s.req_bytes)})</summary><div class="card-body"></div></details>
      <details class="card" data-key="rawres" data-lazy="raw-response"><summary>Raw response body (${fmtBytes(s.resp_bytes)})</summary><div class="card-body"></div></details>
    </div></details>`;

  $("#detail").innerHTML = `
    <div class="d-head">${roleBadge(s.role)}${s.subagent ? `<span class="badge plain">subagent</span>` : ""}${status}</div>
    <div class="d-meta">#${s.n} · ${fmtTime(s.ts)} · ${esc(shortModel(s.model) || s.method + " " + s.path)} · prompt “${esc(s.group_label)}”</div>
    <div class="d-section-title">${d.new.role === "user" ? "Sent this turn" : "Last message sent"}</div>
    ${newParts}
    <div class="d-section-title">Model reply</div>
    ${reply}
    ${tiles}
    ${breakdown}
    ${details}`;
}

async function fillLazy(el) {
  const kind = el.dataset.lazy, body = $(".card-body", el), d = state.detail;
  if (!kind || el.dataset.filled || !d) return;
  el.dataset.filled = "1";
  if (kind === "system") {
    body.innerHTML = d.system.map((t, i) => `<div class="msg k-system"><div class="msg-head">${badge("system", `block ${i + 1}`)}<span class="small">${fmtNum(t.length)} chars</span></div><div class="msg-body">${esc(t)}</div></div>`).join("") || `<p class="muted">No system instructions.</p>`;
  } else if (kind === "tools") {
    body.innerHTML = d.tools.map((t, i) => `<div class="tool-def"><h4>${esc(t.name)}</h4>${clamp(esc(t.description), t.description, "msg-body small")}
      <details class="card" data-key="tool-${i}"><summary class="small">Input schema</summary><div class="card-body"><pre class="json">${jsonHtml(t.schema)}</pre></div></details></div>`).join("") || `<p class="muted">No tools offered.</p>`;
  } else if (kind === "history") {
    body.innerHTML = d.history.map((m, i) => `<div class="small muted" style="margin-top:10px">message ${i + 1} · ${esc(m.role)}</div>${partsHtml(m.parts, "history", "h" + i)}`).join("") || `<p class="muted">This is the first message.</p>`;
  } else if (kind.startsWith("raw-")) {
    body.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await fetch(`/api/raw/${encodeURIComponent(d.summary.id)}?part=${kind.slice(4)}`);
      const { text } = await r.json();
      body.innerHTML = text ? clamp(kind === "raw-request" && maybeJson(text) !== null ? jsonHtml(text) : esc(text), text, "json") : `<p class="muted">(empty)</p>`;
    } catch { body.innerHTML = `<p class="muted">Could not load.</p>`; }
  }
}
document.addEventListener("toggle", (ev) => { if (ev.target.matches?.("details[data-lazy]") && ev.target.open) fillLazy(ev.target); }, true);

function toggleClamp(btn) {
  if (!btn || !btn.matches("[data-clamp]")) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  const closed = btn.previousElementSibling.classList.toggle("closed");
  btn.textContent = closed ? btn.dataset.label : "Show less";
}
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-clamp]");
  if (btn) { toggleClamp(btn); return; }
  const link = ev.target.closest("[data-open-n]");
  if (link) {
    ev.preventDefault();
    ev.stopPropagation();
    const e = state.order.find((x) => x.n === Number(link.dataset.openN));
    if (e) openRequest(e.id);
  }
});

function openRequest(id) {
  const e = state.ex.get(id);
  if (!e) return;
  switchTab("traffic");
  // Make sure the row is not hidden by a filter.
  if (e.side && $("#hideSide").checked) $("#hideSide").checked = false;
  if ($("#errorsOnly").checked && e.role !== "error" && !e.failed_results) $("#errorsOnly").checked = false;
  if (!filteredRows().includes(e)) { $("#search").value = ""; $("#toolFilter").value = ""; }
  renderList();
  select(id);
  const li = $(`.req[data-id="${CSS.escape(id)}"]`);
  if (li) li.scrollIntoView({ block: "center" });
}

/* ------------------------------------------------------------------ tabs */
function switchTab(tab) {
  state.tab = tab;
  $$(".tabs button").forEach((b) => { b.classList.toggle("active", b.dataset.tab === tab); b.setAttribute("aria-selected", b.dataset.tab === tab); });
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + tab));
  if (tab === "tools") renderTools();
  if (tab === "graphs") renderGraphs();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

$("#clearBtn").addEventListener("click", async () => {
  if (!confirm("Archive traffic.jsonl (it is renamed, not deleted) and start with an empty dashboard?")) return;
  const r = await fetch("/api/clear", { method: "POST" });
  const { archived } = await r.json();
  if (archived) alert("Archived to " + archived);
  state.selected = null;
});

/* ------------------------------------------------------------------ tool calls tab */
function renderTools() {
  if (!state.dirty.tools) return;
  state.dirty.tools = false;
  const all = [...state.tools.values()].filter((t) => t.call_n || t.result_n).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const counts = {};
  all.forEach((t) => (counts[t.name] = (counts[t.name] || 0) + 1));
  const chip = (name, label, n) => `<button class="chip${state.toolChip === name ? " active" : ""}" data-chip="${esc(name)}">${name ? `<span class="dot" style="background:${toolColor(name)}"></span>` : ""}${esc(label)} <span class="n">${n}</span></button>`;
  const failedN = all.filter((t) => t.is_error).length;
  $("#toolChips").innerHTML = chip("", "All tools", all.length) + toolNames().filter((n) => counts[n]).map((n) => chip(n, n, counts[n])).join("") +
    (failedN ? `<span class="badge k-error">✕ ${plural(failedN, "failed")}</span>` : "");
  const failedOnly = $("#toolErrorsOnly").checked;
  const rows = all.filter((t) => (!state.toolChip || t.name === state.toolChip) && (!failedOnly || t.is_error));
  $("#toolEmpty").hidden = rows.length > 0;
  $("#toolEmpty").textContent = all.length ? "No tool calls match." : "No tool calls yet.";
  $("#toolRows").innerHTML = rows.map((t) => {
    const status = t.result_summary == null ? `<span class="badge r-pending">… waiting</span>` : t.is_error ? `<span class="badge k-error">✕ failed</span>` : `<span class="badge k-tool_result">↩ result</span>`;
    const res = t.result_summary == null ? "" : `<div>${esc(t.result_summary || "(empty)")}</div><div class="small muted">${fmtNum(t.result_chars)} chars</div>`;
    const reqs = [t.call_n ? `<button class="link" data-open-n="${t.call_n}">#${t.call_n}</button>` : "–", t.result_n ? `<button class="link" data-open-n="${t.result_n}">#${t.result_n}</button>` : "…"].join(" → ");
    const row = `<tr class="row${t.is_error ? " failed" : ""}" data-tool="${esc(t.id)}">
      <td class="when">${fmtTime(t.ts)}</td>
      <td><span class="badge k-tool_call">⚙ ${esc(t.name)}</span></td>
      <td class="call-cell">${esc(t.input_summary)}</td>
      <td class="res-cell">${status}${res}</td>
      <td class="num">${t.wait_ms != null ? fmtMs(t.wait_ms) : "–"}</td>
      <td class="when">${reqs}</td></tr>`;
    return row + (state.expandedTool === t.id ? `<tr class="expand"><td colspan="6" id="toolExpand">Loading…</td></tr>` : "");
  }).join("");
  if (state.expandedTool) fillToolExpand(state.expandedTool);
}
async function fillToolExpand(id) {
  try {
    const t = await (await fetch("/api/tool/" + encodeURIComponent(id))).json();
    const cell = $("#toolExpand");
    if (!cell || state.expandedTool !== id) return;
    const p = { kind: "tool_call", name: t.name, input: t.input, result: t.result, is_error: t.is_error, call_n: t.call_n, result_n: t.result_n, wait_ms: t.wait_ms };
    cell.innerHTML = `<div class="pair">${callCard(p, "tx")}${resultCard(p, "tx", "reply")}</div>`;
  } catch {}
}
$("#toolChips").addEventListener("click", (ev) => {
  const c = ev.target.closest("[data-chip]");
  if (!c) return;
  state.toolChip = c.dataset.chip; state.dirty.tools = true; renderTools();
});
$("#toolErrorsOnly").addEventListener("input", () => { state.dirty.tools = true; renderTools(); });
$("#toolRows").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-open-n], [data-clamp]")) return;
  const tr = ev.target.closest("tr.row");
  if (!tr) return;
  state.expandedTool = state.expandedTool === tr.dataset.tool ? null : tr.dataset.tool;
  state.dirty.tools = true; renderTools();
});

/* ------------------------------------------------------------------ graphs */
const charts = {};
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  state.graphMode = b.dataset.mode;
  $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
  state.dirty.graphs = true; renderGraphs();
}));
$("#graphHideSide").addEventListener("input", () => { state.dirty.graphs = true; renderGraphs(); });

/** Rows for the charts: one per request, or one per prompt (summed). */
function graphData() {
  const rows = state.order.filter((e) => !e.pending && !($("#graphHideSide").checked && e.side));
  const names = toolNames();
  const point = (e) => ({
    id: e.id, group: e.group, groupLabel: e.group_label, label: `#${e.n}`, n: 1,
    input: e.usage.input, cacheRead: e.usage.cache_read, cacheWrite: e.usage.cache_write, output: e.usage.output,
    cost: e.cost, ttfb: (e.ttfb_ms || 0) / 1000, rest: Math.max(0, (e.duration_ms || 0) - (e.ttfb_ms || 0)) / 1000,
    size: e.req_bytes / 1024, msgs: e.n_messages,
    tools: Object.fromEntries(names.map((t) => [t, e.calls.filter((c) => c === t).length])),
    title: e.preview,
  });
  let pts = rows.map(point);
  if (state.graphMode === "prompt") {
    const m = new Map();
    for (const p of pts) {
      if (!m.has(p.group)) { m.set(p.group, { ...p, tools: { ...p.tools }, label: squash(p.groupLabel, 24), title: p.groupLabel }); continue; }
      const g = m.get(p.group);
      for (const k of ["input", "cacheRead", "cacheWrite", "output", "cost", "ttfb", "rest", "n"]) g[k] += p[k];
      g.size = Math.max(g.size, p.size); g.msgs = Math.max(g.msgs, p.msgs);
      for (const t of names) g.tools[t] += p.tools[t];
    }
    pts = [...m.values()];
  }
  let run = 0;
  pts.forEach((p) => { run += p.cost; p.total = run; });
  return { pts, names };
}

/* Shaded bands + the prompt's first words above each run of requests from the same prompt. */
const groupBands = {
  id: "groupBands",
  beforeDatasetsDraw(chart) {
    const pts = chart.$pts;
    if (!pts || !pts.length || state.graphMode !== "request") return;
    const { ctx, chartArea: a, scales: { x } } = chart;
    const step = pts.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : a.right - a.left;
    let start = 0, band = 0;
    ctx.save();
    for (let i = 1; i <= pts.length; i++) {
      if (i < pts.length && pts[i].group === pts[start].group) continue;
      const x0 = Math.max(a.left, x.getPixelForValue(start) - step / 2), x1 = Math.min(a.right, x.getPixelForValue(i - 1) + step / 2);
      if (band % 2 === 0) { ctx.fillStyle = cssVar("--surface-2"); ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top); }
      ctx.fillStyle = cssVar("--muted"); ctx.font = "11px system-ui, -apple-system, sans-serif"; ctx.textBaseline = "bottom";
      let label = "“" + (pts[start].groupLabel || "…");
      const room = x1 - x0 - 6;
      if (room > 20) {
        while (label.length > 2 && ctx.measureText(label + "…”").width > room) label = label.slice(0, -1);
        ctx.fillText(label + (label.length < (pts[start].groupLabel || "").length + 1 ? "…”" : "”"), x0 + 3, a.top - 3);
      }
      ctx.strokeStyle = cssVar("--line-2"); ctx.lineWidth = 1;
      if (start > 0) { ctx.beginPath(); ctx.moveTo(x0 + 0.5, a.top); ctx.lineTo(x0 + 0.5, a.bottom); ctx.stroke(); }
      start = i; band++;
    }
    ctx.restore();
  },
};

function chartOptions(yFormat, { legend = true, stacked = true } = {}) {
  const muted = cssVar("--muted"), grid = cssVar("--line"), ink2 = cssVar("--ink-2");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    layout: { padding: { top: state.graphMode === "request" ? 16 : 4 } },
    interaction: { mode: "index", intersect: false },
    onClick(ev, _els, chart) {
      const els = chart.getElementsAtEventForMode(ev, "index", { intersect: false }, false);
      const p = els.length && chart.$pts[els[0].index];
      if (p) openRequest(p.id);
    },
    onHover(ev, els, chart) { chart.canvas.style.cursor = els.length ? "pointer" : "default"; },
    plugins: {
      legend: { display: legend, position: "top", align: "end", labels: { color: ink2, usePointStyle: true, pointStyle: "rectRounded", boxWidth: 10, boxHeight: 10, font: { size: 12 } } },
      tooltip: {
        callbacks: {
          title: (items) => { const p = items[0].chart.$pts[items[0].dataIndex]; return [`${p.label}${p.n > 1 ? ` · ${p.n} requests` : ""}`, squash(p.title, 70)]; },
          label: (it) => ` ${it.dataset.label}: ${yFormat(it.raw)}`,
          footer: (items) => items.length > 1 ? `Total: ${yFormat(items.reduce((a, i) => a + (i.raw || 0), 0))}` : "",
        },
        itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
      },
    },
    scales: {
      x: { stacked, grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkip: true, font: { size: 11 } }, border: { color: cssVar("--line-2") } },
      y: { stacked, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, font: { size: 11 }, callback: (v) => yFormat(v) } },
    },
  };
}
const barDs = (label, data, color, top) => ({
  type: "bar", label, data, backgroundColor: color, maxBarThickness: 24,
  borderColor: cssVar("--surface"), borderWidth: { top: 2, left: 0, right: 0, bottom: 0 }, borderSkipped: "start",
  borderRadius: top ? { topLeft: 4, topRight: 4 } : 0,
});

function upsertChart(key, canvasId, config, pts) {
  let ch = charts[key];
  if (!ch) {
    ch = charts[key] = new Chart($("#" + canvasId), { type: "bar", ...config, plugins: [groupBands] });
  } else {
    ch.data = config.data;
    ch.options = config.options;
  }
  ch.$pts = pts;
  ch.update("none");
}

function renderGraphs() {
  if (!state.dirty.graphs) return;
  if (typeof Chart === "undefined") {
    $("#graphs").hidden = true; $("#graphsEmpty").hidden = false;
    $("#graphsEmpty").textContent = "The charting library (Chart.js from cdnjs.cloudflare.com) could not be loaded. Check the internet connection and reload.";
    return;
  }
  state.dirty.graphs = false;
  const { pts, names } = graphData();
  const empty = !pts.length;
  $("#graphs").hidden = empty; $("#graphsEmpty").hidden = !empty;
  if (empty) { $("#graphsEmpty").textContent = "No finished requests yet. Charts fill in as traffic arrives."; return; }
  const pal = isDark() ? PALETTE.dark : PALETTE.light;
  const labels = pts.map((p) => p.label);
  const col = (k) => pts.map((p) => p[k]);
  const sec = (v) => (v || 0).toFixed(v >= 10 ? 0 : 1) + " s";

  upsertChart("tokens", "chTokens", { data: { labels, datasets: [
    barDs("New input", col("input"), pal[0]), barDs("Cache read", col("cacheRead"), pal[1]),
    barDs("Cache write", col("cacheWrite"), pal[2]), barDs("Output", col("output"), pal[3], true),
  ] }, options: chartOptions(fmtNum) }, pts);

  upsertChart("cost", "chCost", { data: { labels, datasets: [barDs("Cost", col("cost"), pal[0], true)] },
    options: chartOptions(fmtCost, { legend: false }) }, pts);
  const totalOpts = chartOptions(fmtCost, { legend: false, stacked: false });
  totalOpts.layout.padding.top = 4;
  upsertChart("costTotal", "chCostTotal", { data: { labels, datasets: [{
    type: "line", label: "Running total", data: col("total"), borderColor: pal[0], backgroundColor: pal[0] + "1a", fill: true,
    borderWidth: 2, pointRadius: pts.length > 40 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: pal[0], pointBorderColor: cssVar("--surface"), pointBorderWidth: 2, tension: 0,
  }] }, options: totalOpts }, pts);

  upsertChart("time", "chTime", { data: { labels, datasets: [
    barDs("Waiting for first byte", col("ttfb"), pal[0]), barDs("Rest of the reply", col("rest"), pal[1], true),
  ] }, options: chartOptions(sec) }, pts);

  const sizeOpts = chartOptions((v) => fmtBytes((v || 0) * 1024), { legend: false, stacked: false });
  sizeOpts.plugins.tooltip.callbacks.afterBody = (items) => `Messages in the conversation: ${items[0].chart.$pts[items[0].dataIndex].msgs}`;
  upsertChart("size", "chSize", { data: { labels, datasets: [{
    type: "line", label: state.graphMode === "prompt" ? "Largest request" : "Request body", data: col("size"),
    borderColor: pal[0], backgroundColor: pal[0] + "1a", fill: true, borderWidth: 2,
    pointRadius: pts.length > 40 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: pal[0], pointBorderColor: cssVar("--surface"), pointBorderWidth: 2,
  }] }, options: sizeOpts }, pts);

  const toolOpts = chartOptions((v) => String(Math.round(v || 0)));
  toolOpts.scales.y.ticks.precision = 0;
  toolOpts.plugins.tooltip.filter = (it) => it.raw > 0;
  const used = names.filter((t) => pts.some((p) => p.tools[t]));
  upsertChart("tools", "chTools", { data: { labels, datasets: used.map((t, i) => barDs(t, pts.map((p) => p.tools[t]), toolColor(t), i === used.length - 1)) },
    options: toolOpts }, pts);
}

function rebuildCharts() {
  for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
  state.dirty.graphs = state.dirty.tools = true;
  if (state.tab === "graphs") renderGraphs();
  if (state.tab === "tools") renderTools();
}

// Keep "running 12 s" timers moving for pending rows.
setInterval(() => { if (state.order.some((e) => e.pending)) renderList(); }, 1000);

poll();
