#!/usr/bin/env python3
"""dashboard/server.py: live browser dashboard for the traffic that proxy.py records.

    python3 proxy.py                    # terminal 1: the proxy, writes traffic.jsonl
    python3 dashboard/server.py         # terminal 2: this, open http://localhost:8042

Standard library only. The server tails traffic.jsonl (the file proxy.py appends to),
pairs each "request" record with its "response"/"error" record, parses the Anthropic
Messages API bodies (JSON requests, SSE or JSON replies), links every tool call to the
tool result that arrives in a later request, and serves small JSON summaries that the
page in static/ polls once a second. Full bodies are only sent when a request is opened.

    python3 dashboard/server.py --port 9000 --log /path/to/traffic.jsonl
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DEFAULT_LOG = HERE.parent / "traffic.jsonl"
PRICING_FILE = HERE / "pricing.json"

# Text the harness (not the person) puts into user messages.
HARNESS_TAGS = (
    "system-reminder", "command-name", "command-message", "command-args",
    "local-command-stdout", "local-command-stderr", "local-command-caveat",
    "user-prompt-submit-hook",
)
HARNESS_RE = re.compile(r"<(%s)>[\s\S]*?</\1>" % "|".join(HARNESS_TAGS))
HARNESS_PREFIXES = ("[Request interrupted by user",)
AGENT_TOOLS = {"Task", "Agent"}  # tools that start a subagent; their input has a "prompt"


# --------------------------------------------------------------------------- pricing

DEFAULT_PRICING = {
    "cache_read": 0.1, "cache_write_5m": 1.25, "cache_write_1h": 2.0,
    "models": [], "default": {"input": 3, "output": 15},
}


def load_pricing() -> dict:
    try:
        data = json.loads(PRICING_FILE.read_text(encoding="utf-8"))
        return {**DEFAULT_PRICING, **data}
    except (OSError, ValueError):
        return DEFAULT_PRICING


PRICING = load_pricing()


def price_for(model: str | None) -> dict:
    for entry in PRICING.get("models", []):
        if re.search(entry["match"], model or "", re.I):
            return entry
    return PRICING["default"]


def estimate_cost(model: str | None, u: dict) -> float:
    p = price_for(model)
    inp, out = p["input"], p["output"]
    dollars = (u["input"] * inp + u["output"] * out
               + u["cache_read"] * inp * PRICING["cache_read"]
               + u["cache_write_5m"] * inp * PRICING["cache_write_5m"]
               + u["cache_write_1h"] * inp * PRICING["cache_write_1h"])
    return dollars / 1_000_000


# --------------------------------------------------------------------------- parsing helpers

def squash(text: str, n: int = 240) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def blocks_of(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def split_user_text(text: str) -> list[tuple[str, str]]:
    """Cut a user text block into ("you", ...) and ("harness", ...) pieces."""
    out, pos = [], 0
    for m in HARNESS_RE.finditer(text):
        before = text[pos:m.start()].strip()
        if before:
            out.append(("you", before))
        out.append(("harness", m.group(0).strip()))
        pos = m.end()
    rest = text[pos:].strip()
    if rest:
        out.append(("you", rest))
    return [("harness" if k == "you" and t.startswith(HARNESS_PREFIXES) else k, t) for k, t in out]


def result_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                pieces.append(b.get("text", ""))
            elif isinstance(b, dict) and b.get("type") == "image":
                pieces.append("[image]")
            else:
                pieces.append(json.dumps(b, ensure_ascii=False, indent=2))
        return "\n".join(pieces)
    return json.dumps(content, ensure_ascii=False, indent=2)


def message_parts(msg: dict) -> list[dict]:
    """One API message -> a list of typed parts the page knows how to colour."""
    role = msg.get("role")
    parts: list[dict] = []
    for b in blocks_of(msg.get("content")):
        t = b.get("type", "")
        if t == "text":
            if role == "user":
                parts += [{"kind": k, "text": s} for k, s in split_user_text(b.get("text", ""))]
            else:
                parts.append({"kind": "model", "text": b.get("text", "")})
        elif t == "thinking":
            parts.append({"kind": "thinking", "text": b.get("thinking", "")})
        elif t == "redacted_thinking":
            parts.append({"kind": "thinking", "text": "[redacted thinking]"})
        elif t in ("tool_use", "server_tool_use"):
            parts.append({"kind": "tool_call", "id": b.get("id"), "name": b.get("name", "?"),
                          "input": b.get("input", {})})
        elif t == "tool_result" or t.endswith("_tool_result"):
            parts.append({"kind": "tool_result", "id": b.get("tool_use_id"),
                          "text": result_text(b.get("content")), "is_error": bool(b.get("is_error"))})
        elif t in ("image", "document"):
            parts.append({"kind": "you" if role == "user" else "model", "text": f"[{t}]"})
        else:
            parts.append({"kind": "other", "text": json.dumps(b, ensure_ascii=False, indent=2)})
    return parts


def input_summary(name: str, inp) -> str:
    if isinstance(inp, dict):
        for key in ("command", "file_path", "path", "pattern", "url", "query", "description",
                    "prompt", "skill", "notebook_path"):
            if isinstance(inp.get(key), str) and inp[key].strip():
                return squash(inp[key], 140)
        return squash(json.dumps(inp, ensure_ascii=False), 140)
    return squash(str(inp), 140)


def norm_usage(raw: dict | None) -> dict:
    raw = raw or {}
    cc = raw.get("cache_creation") or {}
    write = raw.get("cache_creation_input_tokens") or 0
    w1h = cc.get("ephemeral_1h_input_tokens") or 0
    w5m = cc.get("ephemeral_5m_input_tokens")
    if w5m is None:
        w5m = max(write - w1h, 0)
    return {"input": raw.get("input_tokens") or 0, "output": raw.get("output_tokens") or 0,
            "cache_read": raw.get("cache_read_input_tokens") or 0,
            "cache_write": write or (w5m + w1h), "cache_write_5m": w5m, "cache_write_1h": w1h}


def header(pairs, name: str) -> str:
    for k, v in pairs or []:
        if k.lower() == name:
            return v
    return ""


def parse_response(body: str, headers) -> dict:
    """An SSE stream or a JSON body -> content blocks, usage, stop reason, error."""
    res = {"blocks": [], "usage": {}, "stop_reason": None, "model": None, "error": None,
           "message_id": None, "streamed": False}
    text = (body or "").replace("\r\n", "\n")
    if "text/event-stream" in header(headers, "content-type") or text.lstrip().startswith(("event:", "data:")):
        res["streamed"] = True
        blocks: dict[int, dict] = {}
        usage: dict = {}
        for chunk in text.split("\n\n"):
            data_lines = [ln[5:].lstrip() for ln in chunk.split("\n") if ln.startswith("data:")]
            if not data_lines:
                continue
            try:
                data = json.loads("\n".join(data_lines))
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            t = data.get("type")
            if t == "message_start":
                msg = data.get("message") or {}
                res["model"], res["message_id"] = msg.get("model"), msg.get("id")
                usage.update({k: v for k, v in (msg.get("usage") or {}).items() if v is not None})
            elif t == "content_block_start":
                blk = dict(data.get("content_block") or {})
                if blk.get("type") in ("tool_use", "server_tool_use"):
                    blk["_json"] = ""
                blocks[data.get("index", len(blocks))] = blk
            elif t == "content_block_delta":
                blk = blocks.setdefault(data.get("index", 0), {"type": "text", "text": ""})
                d = data.get("delta") or {}
                dt = d.get("type")
                if dt == "text_delta":
                    blk["text"] = blk.get("text", "") + d.get("text", "")
                elif dt == "input_json_delta":
                    blk["_json"] = blk.get("_json", "") + d.get("partial_json", "")
                elif dt == "thinking_delta":
                    blk["thinking"] = blk.get("thinking", "") + d.get("thinking", "")
            elif t == "message_delta":
                res["stop_reason"] = (data.get("delta") or {}).get("stop_reason") or res["stop_reason"]
                usage.update({k: v for k, v in (data.get("usage") or {}).items() if v is not None})
            elif t == "error":
                res["error"] = data.get("error") or data
        for blk in blocks.values():
            if "_json" in blk:
                raw = blk.pop("_json")
                try:
                    blk["input"] = json.loads(raw) if raw.strip() else (blk.get("input") or {})
                except ValueError:
                    blk["input"] = raw
        res["blocks"] = [blocks[i] for i in sorted(blocks)]
        res["usage"] = usage
        return res
    try:
        obj = json.loads(text) if text.strip() else None
    except ValueError:
        obj = None
    if isinstance(obj, dict):
        if obj.get("type") == "error" or ("error" in obj and "content" not in obj):
            res["error"] = obj.get("error") or obj
        else:
            res["blocks"] = blocks_of(obj.get("content"))
            res["usage"] = obj.get("usage") or {}
            res["stop_reason"] = obj.get("stop_reason")
            res["model"] = obj.get("model")
            res["message_id"] = obj.get("id")
    return res


def error_message(err) -> str:
    if isinstance(err, dict):
        inner = err.get("error") if isinstance(err.get("error"), dict) else err
        kind, msg = inner.get("type", ""), inner.get("message", "")
        return f"{kind}: {msg}".strip(": ") or json.dumps(err)
    return str(err)


# --------------------------------------------------------------------------- the store

class Exchange:
    """One request record plus (once it arrives) its response or error record."""

    def __init__(self, n: int, rec: dict):
        self.n, self.id, self.req = n, rec.get("id"), rec
        self.resp: dict | None = None
        self.fail: dict | None = None
        self.ver = 0
        self.group = 0
        self.subagent = False
        try:
            body = json.loads(rec.get("body") or "")
        except ValueError:
            body = None
        self.body = body if isinstance(body, dict) else None
        self.messages = [m for m in (self.body or {}).get("messages", []) if isinstance(m, dict)]
        self.tools = (self.body or {}).get("tools") or []
        path = urlsplit(rec.get("path") or "").path.rstrip("/")
        is_messages = rec.get("method") == "POST" and path.endswith("/messages") and self.body is not None
        self.side = not is_messages or not self.tools
        self.new_parts = message_parts(self.messages[-1]) if self.messages else []
        self.prompt_text = self._prompt_text()
        self.reply: dict = {"blocks": [], "usage": {}, "stop_reason": None, "model": None, "error": None}
        self._summary = None

    def _prompt_text(self) -> str:
        """The person's words this request is answering (last user text in the history)."""
        for msg in reversed(self.messages):
            if msg.get("role") != "user":
                continue
            you = [p["text"] for p in message_parts(msg) if p["kind"] == "you"]
            if you:
                return "\n".join(you)
        return ""

    @property
    def model(self) -> str:
        return (self.body or {}).get("model") or self.reply.get("model") or ""

    def error_text(self) -> str:
        if self.fail:
            return self.fail.get("error") or "proxy error"
        if self.resp:
            if self.reply.get("error"):
                return error_message(self.reply["error"])
            if (self.resp.get("status") or 0) >= 400:
                return f"HTTP {self.resp.get('status')} {self.resp.get('reason', '')}".strip()
            if self.resp.get("error"):
                return self.resp["error"]
        return ""

    def reply_parts(self) -> list[dict]:
        return message_parts({"role": "assistant", "content": self.reply["blocks"]})

    def role(self) -> str:
        if self.error_text():
            return "error"
        if self.side:
            return "side"
        if self.subagent:
            return "tool"
        kinds = {p["kind"] for p in self.new_parts}
        if self.messages and self.messages[-1].get("role") == "user" and "you" in kinds and "tool_result" not in kinds:
            return "prompt"
        if self.resp is None:
            return "tool"
        if not any(b.get("type") in ("tool_use",) for b in self.reply["blocks"]):
            return "answer"
        return "tool"


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.generation = 0
        self.reset()

    def reset(self) -> None:
        self.generation += 1
        self.offset = 0
        self.inode = None
        self.partial = b""
        self.version = 0
        self.exchanges: dict[str, Exchange] = {}
        self.order: list[Exchange] = []
        self.tools: dict[str, dict] = {}       # tool_use id -> call + result
        self.groups: dict[str, int] = {}       # prompt text -> group number
        self.group_labels: dict[int, str] = {}
        self.last_main_group = 0

    def bump(self) -> int:
        self.version += 1
        return self.version

    # ---- reading the log

    def refresh(self) -> None:
        with self.lock:
            try:
                st = os.stat(self.path)
            except OSError:
                if self.offset or self.order:
                    self.reset()
                return
            if (self.inode is not None and st.st_ino != self.inode) or st.st_size < self.offset:
                self.reset()
            self.inode = st.st_ino
            if st.st_size == self.offset:
                return
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = f.read()
            self.offset += len(data)
            data = self.partial + data
            lines = data.split(b"\n")
            self.partial = lines.pop()  # incomplete last line (or b"")
            for line in lines:
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    self.ingest(rec)

    def ingest(self, rec: dict) -> None:
        typ, rid = rec.get("type"), rec.get("id")
        if typ == "request":
            ex = Exchange(len(self.order) + 1, rec)
            self.exchanges[rid] = ex
            self.order.append(ex)
            self.link_request(ex)
            ex.ver = self.bump()
        elif typ in ("response", "error") and rid in self.exchanges:
            ex = self.exchanges[rid]
            if typ == "response":
                ex.resp = rec
                ex.reply = parse_response(rec.get("body"), rec.get("headers"))
                self.link_reply(ex)
            else:
                ex.fail = rec
            ex._summary = None
            ex.ver = self.bump()

    def tool(self, tid: str) -> dict:
        if tid not in self.tools:
            self.tools[tid] = {"id": tid, "name": "?", "input": None, "call_n": None, "call_ts": None,
                               "result_n": None, "result_ts": None, "result": None, "is_error": False,
                               "ver": 0}
        return self.tools[tid]

    def link_request(self, ex: Exchange) -> None:
        # Calls the model made before the proxy was running are only visible in the history.
        for msg in ex.messages:
            for p in message_parts(msg):
                if p["kind"] == "tool_call" and p["id"] and p["id"] not in self.tools:
                    t = self.tool(p["id"])
                    t.update(name=p["name"], input=p["input"], ver=self.bump())
                elif p["kind"] == "tool_result" and p["id"]:
                    t = self.tool(p["id"])
                    if t["result_n"] is None:
                        t.update(result_n=ex.n, result_ts=ex.req.get("ts"), result=p["text"],
                                 is_error=p["is_error"], ver=self.bump())
                        self.touch(t["call_n"])
        # Group: requests answering the same prompt belong together.
        if ex.side:
            ex.group = self.last_main_group or self.new_group("side:" + str(ex.n), "(side calls)")
            return
        parent = None
        if ex.prompt_text:
            for t in self.tools.values():
                if t["name"] in AGENT_TOOLS and isinstance(t["input"], dict) \
                        and (t["input"].get("prompt") or "").strip() == ex.prompt_text.strip():
                    parent = t
                    break
        if parent and parent["call_n"]:
            ex.subagent = True
            ex.group = self.order[parent["call_n"] - 1].group
        else:
            key = ex.prompt_text.strip()[:4000] or f"(no prompt {ex.n})"
            ex.group = self.groups.get(key) or self.new_group(key, squash(ex.prompt_text, 60) or "(no prompt)")
        self.last_main_group = ex.group

    def new_group(self, key: str, label: str) -> int:
        g = len(self.group_labels) + 1
        self.groups[key] = g
        self.group_labels[g] = label
        return g

    def link_reply(self, ex: Exchange) -> None:
        for b in ex.reply["blocks"]:
            if b.get("type") in ("tool_use", "server_tool_use") and b.get("id"):
                t = self.tool(b["id"])
                t.update(name=b.get("name", "?"), input=b.get("input"), call_n=ex.n,
                         call_ts=ex.resp.get("ts"), ver=self.bump())

    def touch(self, n: int | None) -> None:
        if n:
            ex = self.order[n - 1]
            ex._summary = None
            ex.ver = self.bump()

    # ---- what the page gets

    def summary(self, ex: Exchange) -> dict:
        if ex._summary is not None:
            return ex._summary
        usage = norm_usage(ex.reply.get("usage"))
        reply = ex.reply_parts()
        calls = [p for p in reply if p["kind"] == "tool_call"]
        results = [p for p in ex.new_parts if p["kind"] == "tool_result"]
        reply_text = "\n".join(p["text"] for p in reply if p["kind"] == "model")
        you_text = "\n".join(p["text"] for p in ex.new_parts if p["kind"] == "you")
        role, err = ex.role(), ex.error_text()
        call_line = " · ".join(f"{c['name']}: {input_summary(c['name'], c['input'])}" for c in calls)
        result_names = [self.tools.get(r["id"], {}).get("name", "?") for r in results]
        failed_results = sum(1 for r in results if r["is_error"])
        reply_line = squash(reply_text) or call_line
        if role == "prompt":
            preview, sub = you_text, reply_line
        elif role == "error":
            preview, sub = err, squash(you_text) or (("after " + ", ".join(result_names)) if result_names else "")
        elif role == "side":
            first = ex.messages[-1] if ex.messages else {}
            text = "\n".join(p["text"] for p in message_parts(first) if p["kind"] in ("you", "other")) if first else ""
            preview, sub = (text or f"{ex.req.get('method')} {ex.req.get('path')}"), reply_line
        elif role == "answer":
            preview, sub = reply_text or "(empty reply)", ("after results from " + ", ".join(result_names)) if result_names else ""
        else:
            preview = call_line or squash(reply_text) or (
                ("sending results: " + ", ".join(result_names)) if ex.resp is None and result_names
                else "…" if ex.resp is None else "(no output)")
            sub = ("results: " + ", ".join(result_names)) if result_names else (squash(you_text) if ex.subagent else "")
        if ex.resp is None and not ex.fail:
            sub = "waiting for the reply…"
        resp = ex.resp or {}
        ex._summary = {
            "n": ex.n, "id": ex.id, "ver": ex.ver, "ts": ex.req.get("ts"),
            "end_ts": (ex.resp or ex.fail or {}).get("ts"),
            "method": ex.req.get("method"), "path": ex.req.get("path"), "model": ex.model,
            "status": resp.get("status"), "reason": resp.get("reason"),
            "pending": ex.resp is None and ex.fail is None,
            "role": role, "side": ex.side, "subagent": ex.subagent, "error": err,
            "group": ex.group, "group_label": self.group_labels.get(ex.group, ""),
            "preview": squash(preview, 400), "sub": squash(sub, 300),
            "calls": [c["name"] for c in calls], "results": result_names,
            "failed_results": failed_results,
            "usage": usage,
            "tokens": usage["input"] + usage["output"] + usage["cache_read"] + usage["cache_write"],
            "cost": estimate_cost(ex.model, usage) if ex.resp else 0.0,
            "ttfb_ms": resp.get("ttfb_ms"), "duration_ms": resp.get("duration_ms"),
            "req_bytes": len((ex.req.get("body") or "").encode("utf-8")),
            "resp_bytes": len((resp.get("body") or "").encode("utf-8")),
            "n_messages": len(ex.messages), "n_tools": len(ex.tools),
            "stop_reason": ex.reply.get("stop_reason"),
            "thinking": any(p["kind"] == "thinking" for p in reply),
        }
        return ex._summary

    def tool_summary(self, t: dict) -> dict:
        wait = None
        if t["call_ts"] and t["result_ts"]:
            wait = max(0, round((t["result_ts"] - t["call_ts"]) * 1000))
        call_ex = self.order[t["call_n"] - 1] if t["call_n"] else None
        return {"id": t["id"], "name": t["name"], "ver": t["ver"],
                "input_summary": input_summary(t["name"], t["input"]),
                "result_summary": squash(t["result"] or "", 200) if t["result"] is not None else None,
                "result_chars": len(t["result"] or ""),
                "call_n": t["call_n"], "result_n": t["result_n"], "is_error": t["is_error"],
                "ts": t["call_ts"] or t["result_ts"], "wait_ms": wait,
                "group": call_ex.group if call_ex else (self.order[t["result_n"] - 1].group if t["result_n"] else 0),
                "side": call_ex.side if call_ex else False}

    def state(self, gen: int, since: int) -> dict:
        self.refresh()
        with self.lock:
            full = gen != self.generation
            since = 0 if full else since
            return {
                "generation": self.generation, "version": self.version, "full": full,
                "log": str(self.path), "log_exists": self.path.exists(),
                "exchanges": [self.summary(e) for e in self.order if e.ver > since],
                "tools": [self.tool_summary(t) for t in self.tools.values() if t["ver"] > since],
                "groups": self.group_labels,
            }

    def pair_info(self, p: dict) -> dict:
        t = self.tools.get(p.get("id") or "")
        if not t:
            return p
        info = dict(p)
        info["name"] = t["name"] if t["name"] != "?" else p.get("name", "?")
        info["call_n"], info["result_n"] = t["call_n"], t["result_n"]
        if p["kind"] == "tool_call":
            info["result"], info["is_error"] = t["result"], t["is_error"]
        else:
            info["input"] = t["input"]
        if t["call_ts"] and t["result_ts"]:
            info["wait_ms"] = max(0, round((t["result_ts"] - t["call_ts"]) * 1000))
        return info

    def detail(self, rid: str) -> dict | None:
        self.refresh()
        with self.lock:
            ex = self.exchanges.get(rid)
            if not ex:
                return None
            body = ex.body or {}
            system = body.get("system")
            if isinstance(system, str):
                system = [system]
            elif isinstance(system, list):
                system = [b.get("text", json.dumps(b)) if isinstance(b, dict) else str(b) for b in system]
            else:
                system = []
            history = [{"role": m.get("role"), "parts": [self.pair_info(p) for p in message_parts(m)]}
                       for m in ex.messages[:-1]]
            params = {k: v for k, v in body.items() if k not in ("messages", "system", "tools")}
            resp = ex.resp or {}
            return {
                "summary": self.summary(ex),
                "new": {"role": ex.messages[-1].get("role") if ex.messages else None,
                        "parts": [self.pair_info(p) for p in ex.new_parts]},
                "reply": [self.pair_info(p) for p in ex.reply_parts()],
                "system": system,
                "tools": [{"name": t.get("name", t.get("type", "?")), "description": t.get("description", ""),
                           "schema": t.get("input_schema", {k: v for k, v in t.items() if k not in ("name", "description")})}
                          for t in ex.tools if isinstance(t, dict)],
                "history": history,
                "params": params,
                "usage_raw": ex.reply.get("usage") or {},
                "request_headers": ex.req.get("headers") or [],
                "response_headers": resp.get("headers") or [],
                "upstream": ex.req.get("upstream"),
                "message_id": ex.reply.get("message_id"),
                "proxy_error": (ex.fail or {}).get("error") or resp.get("error"),
                "body_is_json": ex.body is not None,
            }

    def raw(self, rid: str, part: str) -> str | None:
        with self.lock:
            ex = self.exchanges.get(rid)
            if not ex:
                return None
            if part == "request":
                body = ex.req.get("body") or ""
                try:
                    return json.dumps(json.loads(body), indent=2, ensure_ascii=False)
                except ValueError:
                    return body
            return (ex.resp or {}).get("body") or (ex.fail or {}).get("error") or ""

    def tool_detail(self, tid: str) -> dict | None:
        with self.lock:
            t = self.tools.get(tid)
            return None if t is None else {**self.tool_summary(t), "input": t["input"], "result": t["result"]}

    def clear(self) -> str | None:
        """Archive the log (proxy.py reopens it per write, so it simply starts a new file)."""
        with self.lock:
            archived = None
            if self.path.exists():
                archived = self.path.with_name(f"{self.path.stem}-{datetime.now():%Y%m%d-%H%M%S}{self.path.suffix}")
                os.replace(self.path, archived)
            self.reset()
            return str(archived) if archived else None


# --------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    store: Store

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def send_json(self, obj, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        q = parse_qs(url.query)
        path = url.path
        try:
            if path == "/api/state":
                self.send_json(self.store.state(int(q.get("gen", ["0"])[0]), int(q.get("since", ["0"])[0])))
            elif path.startswith("/api/exchange/"):
                d = self.store.detail(unquote(path.rsplit("/", 1)[1]))
                self.send_json(d if d else {"error": "not found"}, 200 if d else 404)
            elif path.startswith("/api/raw/"):
                text = self.store.raw(unquote(path.rsplit("/", 1)[1]), q.get("part", ["request"])[0])
                self.send_json({"text": text} if text is not None else {"error": "not found"}, 200 if text is not None else 404)
            elif path.startswith("/api/tool/"):
                d = self.store.tool_detail(unquote(path.rsplit("/", 1)[1]))
                self.send_json(d if d else {"error": "not found"}, 200 if d else 404)
            elif path == "/api/pricing":
                self.send_json(PRICING)
            else:
                self.serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self) -> None:
        try:
            if urlsplit(self.path).path == "/api/clear":
                self.send_json({"archived": self.store.clear()})
            else:
                self.send_json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            self.send_json({"error": "not found"}, 404)
            return
        data = target.read_bytes()
        self.send_response(200)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="Live dashboard for proxy.py traffic.")
    parser.add_argument("--port", type=int, default=8042)
    parser.add_argument("--log", default=str(DEFAULT_LOG), help="traffic log written by proxy.py")
    args = parser.parse_args()
    Handler.store = Store(Path(args.log).resolve())
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"dashboard on http://localhost:{args.port}  (reading {Handler.store.path})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
