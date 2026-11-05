// Proxy traffic dashboard. Vanilla JS, no build step. Everything the API sent
// is rendered with textContent, never innerHTML: prompts are untrusted text.
"use strict";

const S = {
  ex: new Map(),        // id -> exchange summary
  tools: new Map(),     // tool_use id -> call/result pair (previews)
  rows: new Map(),      // id -> row element
  selected: null,
  detail: null,
  tab: "traffic",
  f: { q: "", tool: "", model: "", errors: false, aux: true },
  firstLoad: true,
};
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fmtTok = (n) => n == null ? "–" : n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k" : (n / 1e6).toFixed(2) + "M";
const fmtCost = (c) => c == null ? "–" : c === 0 ? "$0" : c < 0.01 ? "$" + c.toFixed(4) : "$" + c.toFixed(c < 10 ? 3 : 2);
const fmtMs = (ms) => ms == null ? "–" : ms < 1000 ? ms + " ms" : ms < 60000 ? (ms / 1000).toFixed(1) + " s" : Math.floor(ms / 60000) + "m " + Math.round(ms % 60000 / 1000) + "s";
const fmtBytes = (b) => b == null ? "–" : b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(2) + " MB";
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour12: false }) : "";
const shortModel = (m) => (m || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
const inTokens = (u) => u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
const asBlocks = (c) => c == null ? [] : typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [c];
const textOf = (blocks) => blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");

function copyBtn(get) {
  return h("button", { class: "ghost", title: "copy to clipboard", onclick: (e) => {
    e.preventDefault(); e.stopPropagation();
    navigator.clipboard?.writeText(get()).then(() => { e.target.textContent = "copied"; setTimeout(() => (e.target.textContent = "copy"), 1200); });
  } }, "copy");
}

// Long text collapses to its head with a "show all" toggle.
function longText(str, { limit = 1500, prose = false } = {}) {
  str = str == null ? "" : String(str);
  const pre = h("pre", { class: "txt" + (prose ? " prose" : "") });
  if (str.length <= limit) { pre.textContent = str || "(empty)"; return pre; }
  let open = false;
  const btn = h("button", { class: "ghost" });
  const info = h("span", { class: "muted" });
  const paint = () => {
    pre.textContent = open ? str : str.slice(0, limit) + " …";
    btn.textContent = open ? "Collapse" : "Show all";
    info.textContent = `${str.length.toLocaleString()} chars · ${fmtBytes(new Blob([str]).size)}`;
  };
  btn.onclick = () => { open = !open; paint(); };
  paint();
  return h("div", {}, pre, h("div", { class: "more" }, btn, info, copyBtn(() => str)));
}

// <details> whose body is built the first time it opens: a 90 KB transcript
// costs nothing until someone looks at it.
function lazy(cls, summaryKids, render, open = false) {
  const d = h("details", { class: cls });
  d.append(h("summary", {}, summaryKids));
  let done = false;
  const go = () => { if (!done && d.open) { done = true; d.append(h("div", { class: "body" }, render())); } };
  d.addEventListener("toggle", go);
  if (open) { d.open = true; go(); }
  return d;
}

// Collapsible JSON tree.
function jsonView(v, depth = 0) {
  const wrap = depth === 0 ? h("div", { class: "json" }) : null;
  const node = jsonNode(v, depth);
  if (!wrap) return node;
  wrap.append(node);
  return wrap;
}
function jsonNode(v, depth) {
  if (v === null) return h("span", { class: "b" }, "null");
  if (typeof v === "string") {
    if (v.length > 240 || v.includes("\n")) return longText(v, { limit: 800 });
    return h("span", { class: "s" }, JSON.stringify(v));
  }
  if (typeof v === "number") return h("span", { class: "n" }, String(v));
  if (typeof v === "boolean") return h("span", { class: "b" }, String(v));
  const arr = Array.isArray(v);
  const keys = arr ? v.map((_, i) => i) : Object.keys(v);
  if (!keys.length) return h("span", {}, arr ? "[]" : "{}");
  const size = JSON.stringify(v).length;
  const label = (arr ? `[${keys.length} items]` : `{${keys.length} keys}`) + (size > 2000 ? ` · ${fmtBytes(size)}` : "");
  const d = h("details", {});
  d.append(h("summary", {}, label));
  let done = false;
  const go = () => {
    if (done || !d.open) return;
    done = true;
    const kids = h("div", { class: "kids" });
    for (const k of keys) kids.append(h("div", {}, h("span", { class: "k" }, arr ? `${k}: ` : `${k}: `), jsonNode(v[k], depth + 1)));
    d.append(kids);
  };
  d.addEventListener("toggle", go);
  if (depth < 2 && size < 6000) { d.open = true; go(); }
  return d;
}

// ------------------------------------------------------------ filtering
function matches(s) {
  const f = S.f;
  if (f.aux && s.kind !== "messages") return false;
  if (f.errors && !s.error) return false;
  if (f.model && s.model !== f.model) return false;
  if (f.tool && !s.tool_calls.some((c) => c.name === f.tool) && !s.tool_results.some((r) => r.name === f.tool)) return false;
  if (f.q) {
    const hay = [s.model, s.path, s.reply_preview, s.new_preview, s.error, s.stop_reason,
      ...s.tool_calls.map((c) => c.name), ...s.tool_results.map((r) => r.name),
      ...s.tool_calls.map((c) => S.tools.get(c.id)?.brief)].join(" ").toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}
function pairMatches(t) {
  const f = S.f;
  if (f.tool && t.name !== f.tool) return false;
  if (f.errors && !t.is_error) return false;
  if (f.q && !`${t.name} ${t.brief} ${t.result || ""}`.toLowerCase().includes(f.q)) return false;
  return true;
}

// ------------------------------------------------------------ list
function statusPill(s) {
  if (s.pending) return h("span", { class: "pill wait" }, "live");
  if (s.error) return h("span", { class: "pill bad" }, s.status && s.status >= 400 ? `✕ ${s.status}` : "✕ error");
  if (s.stop_reason === "refusal") return h("span", { class: "pill warn" }, "refusal");
  if (s.stop_reason === "max_tokens") return h("span", { class: "pill warn" }, "max_tokens");
  return h("span", { class: "pill ok" }, String(s.status ?? "ok"));
}

function rowContent(s) {
  const right = h("span", { class: "right" });
  if (s.kind === "messages" && s.usage) right.append(h("span", { title: "input (incl. cache) → output tokens" }, `${fmtTok(inTokens(s.usage))} → ${fmtTok(s.usage.output_tokens)}`));
  if (s.cost != null) right.append(h("span", { title: "estimated cost" }, fmtCost(s.cost)));
  right.append(h("span", { title: "total time" }, s.pending ? "…" : fmtMs(s.duration_ms)));

  const l1 = h("div", { class: "l1" },
    h("span", { class: "seq" }, "#" + s.seq), statusPill(s),
    h("span", { class: "model" }, s.kind === "messages" ? shortModel(s.model) : `${s.method} ${s.path}`),
    h("span", { class: "muted" }, fmtTime(s.ts)), right);

  const prev = h("div", { class: "prev" });
  if (s.error && !s.pending) prev.append(h("span", { class: "who" }, "error: "), s.error);
  else if (s.reply_preview) prev.append(h("span", { class: "who" }, "reply: "), s.reply_preview);
  else if (s.new_preview) prev.append(h("span", { class: "who" }, s.new_role + ": "), s.new_preview);
  else if (s.tool_results.length) prev.append(h("span", { class: "who" }, `${s.tool_results.length} tool result(s)`));
  else if (s.pending) prev.append(h("span", { class: "who" }, "waiting for the model…"));

  const chips = h("div", { class: "chips" });
  for (const r of s.tool_results) chips.append(h("span", { class: "chip res" + (r.is_error ? " bad" : "") }, r.name || "?"));
  for (const c of s.tool_calls) {
    const t = S.tools.get(c.id);
    chips.append(h("span", { class: "chip call" + (t?.is_error ? " bad" : ""), title: t?.brief || "" }, c.name));
  }
  return [l1, prev, chips.childNodes.length ? chips : null];
}

function upsertRow(s, isNew) {
  let row = S.rows.get(s.id);
  if (!row) {
    row = h("div", { class: "row", onclick: () => select(s.id) });
    row.dataset.id = s.id;
    S.rows.set(s.id, row);
    const rows = $("rows");
    // newest first; arrivals are almost always the newest
    const after = [...rows.children].find((r) => S.ex.get(r.dataset.id).seq < s.seq);
    rows.insertBefore(row, after || null);
    if (isNew) row.classList.add("new");
  }
  row.replaceChildren(...rowContent(s).filter(Boolean));
  row.classList.toggle("err", !!s.error);
  row.classList.toggle("sel", S.selected === s.id);
  row.hidden = !matches(s);
}

function rebuildList() {
  $("rows").replaceChildren();
  S.rows.clear();
  [...S.ex.values()].sort((a, b) => b.seq - a.seq).forEach((s) => upsertRow(s, false));
  applyFilters();
}

function applyFilters() {
  let shown = 0;
  for (const [id, row] of S.rows) { const ok = matches(S.ex.get(id)); row.hidden = !ok; shown += ok; }
  $("shown").textContent = S.ex.size ? `${shown} of ${S.ex.size}` : "";
  $("empty").hidden = S.ex.size > 0;
  renderStats();
  if (S.tab === "tools") renderTools();
}

// ------------------------------------------------------------ stats
let statsTimer = null;
function renderStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    const list = [...S.ex.values()].filter(matches);
    const done = list.filter((s) => !s.pending && s.duration_ms != null);
    let inp = 0, out = 0, read = 0, cost = 0, priced = 0, calls = 0;
    for (const s of list) {
      if (s.kind !== "messages") continue;
      inp += inTokens(s.usage); out += s.usage?.output_tokens || 0; read += s.usage?.cache_read_input_tokens || 0;
      if (s.cost != null) { cost += s.cost; priced++; }
      calls += s.tool_calls.length;
    }
    const errs = list.filter((s) => s.error).length;
    const avg = done.length ? Math.round(done.reduce((a, s) => a + s.duration_ms, 0) / done.length) : null;
    const tile = (label, value, title, extra = {}) => h("div", { class: "tile " + (extra.cls || ""), title, onclick: extra.onclick }, h("b", {}, value), h("span", {}, label));
    $("stats").replaceChildren(
      tile("requests", list.length),
      tile("errors", errs, "click to show errors only", { cls: "click" + (errs ? " alert" : ""), onclick: () => { $("errors").checked = !$("errors").checked; readFilters(); } }),
      tile("input tokens", fmtTok(inp), "fresh + cache write + cache read"),
      tile("output tokens", fmtTok(out)),
      tile("cache hit", inp ? Math.round(read / inp * 100) + "%" : "–", "share of input tokens served from the prompt cache"),
      tile("est. cost", fmtCost(priced ? cost : null), "list-price estimate from the usage the API reported"),
      tile("avg time", fmtMs(avg), "mean total request time"),
      tile("tool calls", calls),
    );
  }, 60);
}

// ------------------------------------------------------------ select options
function refreshOptions() {
  const fill = (sel, values, label) => {
    const cur = sel.value;
    sel.replaceChildren(h("option", { value: "" }, label), ...values.map(([v, n]) => h("option", { value: v }, `${v} (${n})`)));
    sel.value = values.some(([v]) => v === cur) ? cur : "";
  };
  const tc = new Map();
  for (const t of S.tools.values()) if (t.name) tc.set(t.name, (tc.get(t.name) || 0) + 1);
  fill($("tool"), [...tc].sort((a, b) => b[1] - a[1]), "All tools");
  const mc = new Map();
  for (const s of S.ex.values()) if (s.model && s.kind === "messages") mc.set(s.model, (mc.get(s.model) || 0) + 1);
  fill($("model"), [...mc].sort((a, b) => b[1] - a[1]), "All models");
}
let optTimer = null;
const scheduleOptions = () => { clearTimeout(optTimer); optTimer = setTimeout(refreshOptions, 300); };

// ------------------------------------------------------------ detail
async function select(id) {
  S.selected = id;
  if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
  for (const [rid, row] of S.rows) row.classList.toggle("sel", rid === id);
  await loadDetail(id);
}

async function loadDetail(id, keepOpen) {
  const pane = $("detail");
  const opened = keepOpen ? [...pane.querySelectorAll(":scope > details.sec")].map((d) => d.open) : null;
  const scroll = pane.scrollTop;
  const res = await fetch(`/api/exchange/${encodeURIComponent(id)}`);
  if (!res.ok || S.selected !== id) return;
  S.detail = await res.json();
  pane.replaceChildren(...renderDetail(S.detail));
  if (opened) {
    pane.querySelectorAll(":scope > details.sec").forEach((d, i) => { if (opened[i] != null && d.open !== opened[i]) d.open = opened[i]; });
    pane.scrollTop = scroll;
  } else pane.scrollTop = 0;
}

function renderDetail(d) {
  const s = d.summary, u = s.usage || {};
  const out = [];
  out.push(h("div", { class: "dhead" },
    h("h2", {}, `#${s.seq} · ${s.method} ${s.path}`), statusPill(s),
    h("span", { class: "muted" }, new Date(s.ts * 1000).toLocaleString()),
    s.upstream ? h("span", { class: "muted" }, "→ " + d.upstream) : null));
  if (s.error) out.push(h("div", { class: "errbox" }, s.error));

  const m = (label, value, title) => h("div", { title }, h("span", {}, label), h("b", {}, value));
  out.push(h("div", { class: "meta" },
    m("model", s.model || "–"),
    m("total time", s.pending ? "in flight…" : fmtMs(s.duration_ms)),
    m("first byte", fmtMs(s.ttfb_ms), "time until the API started answering"),
    m("input tokens", fmtTok(u.input_tokens), "uncached input"),
    m("cache read", fmtTok(u.cache_read_input_tokens)),
    m("cache write", fmtTok(u.cache_creation_input_tokens)),
    m("output tokens", fmtTok(u.output_tokens)),
    m("est. cost", fmtCost(s.cost)),
    m("stop reason", s.stop_reason || "–"),
    m("request size", fmtBytes(s.req_bytes)),
    m("response size", fmtBytes(s.resp_bytes)),
    m("messages / tools", `${s.n_messages} / ${s.n_tools}`)));

  const reply = d.message?.content || [];
  if (d.message || s.pending) {
    const calls = reply.filter((b) => b.type === "tool_use" || b.type === "server_tool_use").length;
    out.push(lazy("sec", ["Model reply", h("span", { class: "muted" }, `${reply.length} block(s)${calls ? ` · ${calls} tool call(s)` : ""}`)],
      () => reply.length ? h("div", {}, reply.map((b) => blockView(b, "assistant", true))) : h("p", { class: "muted" }, s.pending ? "The model is still answering…" : "No content."), true));
  } else if (d.resp_raw != null) {
    out.push(lazy("sec", ["Response body", h("span", { class: "muted" }, fmtBytes(s.resp_bytes))], () => rawBody(d.resp_raw), true));
  }

  if (d.new_message) {
    const blocks = asBlocks(d.new_message.content);
    const nres = blocks.filter((b) => b.type === "tool_result").length;
    out.push(lazy("sec", ["New message", h("span", { class: "role " + d.new_message.role }, d.new_message.role),
      h("span", { class: "muted" }, nres ? `${nres} tool result(s) paired with the calls that asked for them` : `${blocks.length} block(s)`)],
      () => h("div", {}, blocks.map((b) => blockView(b, d.new_message.role, true))), true));
  }

  if (d.system) {
    const chars = d.system.reduce((a, b) => a + (b.text || "").length, 0);
    out.push(lazy("sec", ["System instructions", h("span", { class: "muted" }, `${d.system.length} block(s) · ${chars.toLocaleString()} chars`)],
      () => h("div", {}, d.system.map((b, i) => h("div", {},
        h("div", { class: "label" }, `block ${i + 1}${b.cache_control ? " · cache_control: " + JSON.stringify(b.cache_control) : ""}`),
        b.type === "text" ? longText(b.text, { limit: 4000 }) : jsonView(b))))));
  }

  if (d.tools) {
    const size = JSON.stringify(d.tools).length;
    out.push(lazy("sec", ["Tool definitions", h("span", { class: "muted" }, `${d.tools.length} tools · ${fmtBytes(size)}`)],
      () => h("div", {}, d.tools.map((t) => lazy("sub", [h("b", { class: "mono" }, t.name || t.type), h("span", { class: "prev" }, (t.description || t.type || "").split("\n")[0])],
        () => h("div", {}, t.description ? longText(t.description, { limit: 1200 }) : null,
          h("div", { class: "label" }, "definition"), jsonView(Object.fromEntries(Object.entries(t).filter(([k]) => k !== "description")))))))));
  }

  if (d.history) {
    out.push(lazy("sec", ["Conversation history", h("span", { class: "muted" }, `${d.history.length} earlier message(s)`)],
      () => h("div", {}, d.history.map((msg, i) => messageView(msg, i)))));
  }

  if (d.params) out.push(lazy("sec", ["Request parameters", h("span", { class: "muted" }, Object.keys(d.params).join(", "))], () => jsonView(d.params)));
  if (d.req_raw != null) out.push(lazy("sec", ["Request body", h("span", { class: "muted" }, "not JSON")], () => longText(d.req_raw, { limit: 4000 })));

  out.push(lazy("sec", ["Headers"], () => h("div", {},
    h("div", { class: "label" }, "request"), kv(d.req_headers),
    h("div", { class: "label" }, `response${d.reason ? " · " + s.status + " " + d.reason : ""}`), kv(d.resp_headers))));

  if (d.message) {
    out.push(lazy("sec", ["Raw", h("span", { class: "muted" }, `rebuilt message · ${d.events} stream events`)], () => {
      const box = h("div", {}, h("div", { class: "label" }, "message rebuilt from the stream"), jsonView(d.message));
      const btn = h("button", { class: "btn", onclick: async () => {
        btn.disabled = true;
        const raw = await (await fetch(`/api/raw/${encodeURIComponent(s.id)}`)).text();
        btn.replaceWith(h("div", { class: "label" }, "response bytes as received"), longText(raw, { limit: 6000 }));
      } }, `Load raw response (${fmtBytes(d.resp_raw_len)})`);
      box.append(h("div", { class: "more" }, btn));
      return box;
    }));
  }
  return out;
}

function kv(pairs) {
  return h("div", { class: "kv" }, (pairs || []).flatMap(([k, v]) => [h("span", {}, k), h("span", {}, v)]));
}
function rawBody(text) {
  try { return jsonView(JSON.parse(text)); } catch { return longText(text, { limit: 6000 }); }
}

function messageView(msg, i) {
  const blocks = asBlocks(msg.content);
  const text = textOf(blocks).replace(/\s+/g, " ").trim();
  const tu = blocks.filter((b) => b.type === "tool_use").map((b) => b.name);
  const tr = blocks.filter((b) => b.type === "tool_result").length;
  const preview = text ? text.slice(0, 160) : tu.length ? "→ " + tu.join(", ") : tr ? `↩ ${tr} tool result(s)` : `${blocks.length} block(s)`;
  return lazy("sub", [h("span", { class: "muted mono" }, "#" + (i + 1)), h("span", { class: "role " + msg.role }, msg.role), h("span", { class: "prev" }, preview)],
    () => h("div", {}, blocks.map((b) => blockView(b, msg.role, false))));
}

function blockView(b, role, open) {
  switch (b.type) {
    case "text":
      return longText(b.text, { limit: role === "assistant" ? 6000 : 2500, prose: role === "assistant" });
    case "thinking":
      return lazy("sub", [h("i", {}, "thinking"), h("span", { class: "prev" }, b.thinking ? `${b.thinking.length} chars` : "(content not returned)")],
        () => b.thinking ? longText(b.thinking, { limit: 4000 }) : h("p", { class: "muted" }, "The API returned this thinking block without its text."));
    case "redacted_thinking":
      return h("div", { class: "label" }, "redacted thinking block");
    case "tool_use": case "server_tool_use":
      return pairView(b.id, { name: b.name, input: b.input }, open);
    case "tool_result":
      return pairView(b.tool_use_id, { result: b }, open);
    case "image":
      return h("div", { class: "label" }, `[image · ${b.source?.media_type || b.source?.type || ""}${b.source?.data ? " · " + fmtBytes(b.source.data.length * 0.75) : ""}]`);
    default:
      return h("div", {}, h("div", { class: "label" }, b.type || "block"), jsonView(b));
  }
}

// ------------------------------------------------------------ tool pairs
// A call and its result side by side. The result usually lives in a later
// request; the server matches them by tool_use_id and keeps both cards live.
function pairView(id, known, open) {
  const wrap = h("div", { class: "pairslot" });
  wrap.dataset.tool = id;
  wrap._known = known;
  wrap._open = open;
  paintPair(wrap);
  return wrap;
}

function paintPair(wrap) {
  const id = wrap.dataset.tool, known = wrap._known, t = S.tools.get(id) || {};
  const name = known.name || t.name || "?";
  const isErr = known.result ? !!known.result.is_error : !!t.is_error;
  const hasRes = !!known.result || t.has_result;
  const status = !hasRes ? h("span", { class: "pill wait" }, "awaiting result") : isErr ? h("span", { class: "pill bad" }, "✕ error") : h("span", { class: "pill ok" }, "ok");
  const prev = wrap.querySelector(":scope > details");
  const keep = prev ? prev.open : wrap._open;
  wrap.replaceChildren(lazy("sub pairsum", [h("span", { class: "name" }, name), h("span", { class: "prev mono" }, t.brief || briefOf(known.input)), status,
    t.wait_ms != null ? h("span", { class: "muted", title: "from the end of the reply that asked for it to the request that carried the result" }, fmtMs(t.wait_ms)) : null],
    () => pairBody(id, known, t, name, isErr, hasRes), keep));
}

function briefOf(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"])
    if (typeof input[k] === "string" && input[k]) return input[k].split("\n")[0].slice(0, 160);
  return JSON.stringify(input).slice(0, 160);
}

function goTo(exId) {
  if (!exId) return;
  if (S.tab !== "traffic") setTab("traffic");
  const row = S.rows.get(exId);
  if (row) { row.hidden = false; row.scrollIntoView({ block: "nearest" }); }
  select(exId);
}

function pairBody(id, known, t, name, isErr, hasRes) {
  const pair = h("div", { class: "pair" + (isErr ? " err" : "") });
  // call side
  const call = h("div", { class: "call" });
  call.append(h("h4", {}, h("span", { class: "name" }, name),
    t.call_seq ? h("a", { onclick: () => goTo(t.call_ex) }, `asked in #${t.call_seq}`) : null,
    h("span", { class: "muted mono" }, id)));
  let input = known.input !== undefined ? known.input : t.input;
  if (input !== undefined && input !== null) call.append(inputView(input));
  else if (t.input_text) call.append(longText(t.input_text), fullLoader(id, call, "input"));
  else call.append(h("p", { class: "waiting" }, "call not captured"));
  // result side
  const res = h("div", { class: "res" });
  res.append(h("h4", {}, h("span", { class: "name" }, "result"),
    !hasRes ? null : isErr ? h("span", { class: "pill bad" }, "✕ is_error") : h("span", { class: "pill ok" }, "ok"),
    t.result_seq ? h("a", { onclick: () => goTo(t.result_ex) }, `arrived in #${t.result_seq}`) : null,
    t.wait_ms != null ? h("span", { class: "muted" }, "after " + fmtMs(t.wait_ms)) : null));
  if (known.result) res.append(resultView(known.result));
  else if (t.has_result) {
    res.append(longText(t.result, { limit: 2500 }));
    if (t.result_len > (t.result || "").length) res.append(fullLoader(id, res, "result"));
  } else res.append(h("p", { class: "waiting" }, "Not back yet: the harness sends it in its next request."));
  pair.append(call, res);
  return pair;
}

function fullLoader(id, box, which) {
  const b = h("button", { class: "btn", onclick: async () => {
    b.disabled = true;
    const full = await (await fetch(`/api/tool/${encodeURIComponent(id)}`)).json();
    box.querySelectorAll("pre.txt, .more, .json").forEach((n) => n.remove());
    box.append(which === "input" ? inputView(full.input) : longText(full.result, { limit: 2500 }));
    b.remove();
  } }, `Load full ${which}`);
  return h("div", { class: "more" }, b);
}

function inputView(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return jsonView(input);
  const box = h("div", {});
  for (const [k, v] of Object.entries(input)) {
    box.append(h("div", { class: "label" }, k));
    box.append(typeof v === "string" ? longText(v, { limit: 1200 }) : jsonView(v, 1));
  }
  return box;
}

function resultView(b) {
  const parts = asBlocks(b.content);
  if (!parts.length) return h("p", { class: "muted" }, "(empty result)");
  return h("div", {}, parts.map((p) => p.type === "text" ? longText(p.text, { limit: 2500 }) :
    p.type === "image" ? h("div", { class: "label" }, `[image · ${p.source?.media_type || ""}]`) : jsonView(p)));
}

function refreshPair(id) {
  document.querySelectorAll(`.pairslot[data-tool="${CSS.escape(id)}"]`).forEach(paintPair);
}

// ------------------------------------------------------------ tools tab
let toolsTimer = null;
function renderTools() {
  clearTimeout(toolsTimer);
  toolsTimer = setTimeout(() => {
    const all = [...S.tools.values()].filter((t) => t.name);
    // usage table: one bar per tool, a single hue (it's one measure)
    const by = new Map();
    for (const t of all) {
      const e = by.get(t.name) || { n: 0, err: 0, wait: [], pending: 0 };
      e.n++; if (t.is_error) e.err++; if (!t.has_result) e.pending++; if (t.wait_ms != null) e.wait.push(t.wait_ms);
      by.set(t.name, e);
    }
    const rows = [...by].sort((a, b) => b[1].n - a[1].n);
    const max = Math.max(1, ...rows.map(([, e]) => e.n));
    $("usage").replaceChildren(h("h3", {}, "Tool usage"), rows.length ? h("table", {},
      h("tr", {}, h("th", {}, "tool"), h("th", {}, "calls"), h("th", {}), h("th", {}, "errors"), h("th", {}, "pending"), h("th", { title: "median time from the reply asking for the tool to the request carrying its result" }, "median turnaround")),
      rows.map(([name, e]) => {
        const med = e.wait.length ? e.wait.sort((a, b) => a - b)[Math.floor(e.wait.length / 2)] : null;
        return h("tr", { class: S.f.tool === name ? "on" : "" },
          h("td", { class: "name", title: "filter by this tool", onclick: () => { $("tool").value = S.f.tool === name ? "" : name; readFilters(); } }, name),
          h("td", { class: "num" }, e.n),
          h("td", {}, h("div", { class: "track", title: `${name}: ${e.n} calls` }, h("div", { class: "fill", style: `width:${(e.n / max * 100).toFixed(1)}%` }))),
          h("td", { class: "num errs" + (e.err ? " has" : "") }, e.err),
          h("td", { class: "num" }, e.pending),
          h("td", { class: "num" }, fmtMs(med)));
      })) : h("p", { class: "muted" }, "No tool calls yet."));

    const list = all.filter(pairMatches).sort((a, b) => (b.call_ts || b.result_ts || 0) - (a.call_ts || a.result_ts || 0));
    const shown = list.slice(0, 400);
    $("pairs").replaceChildren(...shown.map((t) => {
      const d = lazy("prow" + (t.is_error ? " err" : ""), [
        h("span", { class: "t" }, fmtTime(t.call_ts || t.result_ts)),
        h("span", { class: "name" }, t.name),
        h("span", { class: "brief" }, t.brief),
        !t.has_result ? h("span", { class: "pill wait" }, "awaiting") : t.is_error ? h("span", { class: "pill bad" }, "✕ error") : h("span", { class: "pill ok" }, "ok"),
        h("span", { class: "t" }, t.wait_ms != null ? fmtMs(t.wait_ms) : ""),
      ], () => pairBody(t.id, {}, t, t.name, t.is_error, t.has_result));
      return d;
    }), list.length > shown.length ? h("p", { class: "muted" }, `Showing the newest ${shown.length} of ${list.length}. Narrow with the filters.`) : "");
    // pairBody renders a bare .pair: give it the row's spacing
    $("pairs").querySelectorAll(".prow > .body").forEach((b) => (b.style.padding = "0"));
  }, 80);
}

// ------------------------------------------------------------ wiring
function readFilters() {
  S.f = { q: $("q").value.trim().toLowerCase(), tool: $("tool").value, model: $("model").value,
          errors: $("errors").checked, aux: $("aux").checked };
  applyFilters();
}
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("traffic").hidden = tab !== "traffic";
  $("tools").hidden = tab !== "tools";
  if (tab === "tools") renderTools();
}

document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
let qTimer = null;
$("q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(readFilters, 150); });
["tool", "model", "errors", "aux"].forEach((id) => $(id).addEventListener("change", readFilters));
$("clear").onclick = async () => {
  if (!confirm("Archive the current traffic log and start a fresh one? Nothing is deleted.")) return;
  const r = await (await fetch("/api/clear", { method: "POST" })).json();
  if (r.archived) alert("Archived to " + r.archived);
};
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || S.tab !== "traffic") return;
  if (e.key !== "j" && e.key !== "k") return;
  const vis = [...$("rows").children].filter((r) => !r.hidden);
  const i = vis.findIndex((r) => r.dataset.id === S.selected);
  const next = vis[e.key === "j" ? Math.min(vis.length - 1, i + 1) : Math.max(0, i - 1)];
  if (next) { next.scrollIntoView({ block: "nearest" }); select(next.dataset.id); }
});

function connect() {
  const es = new EventSource("/api/stream");
  const live = $("live");
  es.onopen = () => { live.classList.remove("off"); live.querySelector("b").textContent = "live"; };
  es.onerror = () => { live.classList.add("off"); live.querySelector("b").textContent = "reconnecting…"; };
  es.addEventListener("reset", (e) => {
    const d = JSON.parse(e.data);
    S.ex.clear(); S.tools.clear();
    d.exchanges.forEach((s) => S.ex.set(s.id, s));
    d.tools.forEach((t) => S.tools.set(t.id, t));
    if (S.selected && !S.ex.has(S.selected)) { S.selected = null; $("detail").replaceChildren(h("p", { class: "empty" }, "Select a request.")); }
    rebuildList(); refreshOptions();
    const want = decodeURIComponent(location.hash.slice(1));
    if (!S.selected && want && S.ex.has(want)) select(want);
  });
  es.addEventListener("exchange", (e) => {
    const s = JSON.parse(e.data);
    const isNew = !S.ex.has(s.id);
    S.ex.set(s.id, s);
    upsertRow(s, isNew);
    $("shown").textContent = `${[...S.rows.values()].filter((r) => !r.hidden).length} of ${S.ex.size}`;
    $("empty").hidden = true;
    renderStats(); scheduleOptions();
    if (S.selected === s.id && !isNew) loadDetail(s.id, true);
  });
  es.addEventListener("tool", (e) => {
    const t = JSON.parse(e.data);
    S.tools.set(t.id, t);
    refreshPair(t.id);
    // a result changes the chips of the row whose reply asked for it
    if (t.call_ex && S.ex.has(t.call_ex)) upsertRow(S.ex.get(t.call_ex), false);
    if (S.tab === "tools") renderTools();
    scheduleOptions();
  });
}
connect();
