#!/usr/bin/env python3
"""dashboard/server.py: a live browser view of the traffic proxy.py captures.

    python3 proxy.py                 # terminal 1: the proxy, writes traffic.jsonl
    python3 dashboard/server.py      # terminal 2: open http://localhost:8042
    ANTHROPIC_BASE_URL=http://localhost:8041 claude    # terminal 3: the agent

The server tails the proxy's JSONL log, reconstructs each exchange (the request
split into system / tools / history / new message, the streamed reply rebuilt
into content blocks, usage and cost), pairs every tool call with the result
that arrives in a later request, and pushes it all to the browser over
Server-Sent Events. Standard library only; nothing to install.

The log is the persistence: restart either program and the history is still
there. "Clear" in the UI archives the log to traffic-<date>.jsonl and starts
fresh; nothing is deleted.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DEFAULT_LOG = HERE.parent / "traffic.jsonl"
PREVIEW = 3000  # characters of a tool input/result sent in the live feed; the rest on demand

# ---------------------------------------------------------------- pricing
# USD per million tokens: (input, output, cache read). Cache writes are billed
# at 1.25x input (5-minute TTL) or 2x input (1-hour TTL). Anthropic first-party
# list prices as of 2026-10; an unknown model shows no cost rather than a guess.
PRICES: dict[str, tuple[float, float, float | None]] = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-mythos-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, None),
    "claude-mythos-5": (10.0, 50.0, None),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, None),
    "claude-opus-4-8": (5.0, 25.0, None),
    "claude-opus-4-7": (5.0, 25.0, None),
    "claude-opus-4-6": (5.0, 25.0, None),
    "claude-opus-4-5": (5.0, 25.0, None),
    "claude-opus-4-1": (15.0, 75.0, None),
    "claude-opus-4": (15.0, 75.0, None),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, None),
    "claude-sonnet-4-6": (3.0, 15.0, None),
    "claude-sonnet-4-5": (3.0, 15.0, None),
    "claude-sonnet-4": (3.0, 15.0, None),
    "claude-3-7-sonnet": (3.0, 15.0, None),
    "claude-haiku-5-5": (0.10, 0.50, None),
    "claude-haiku-4-5": (1.0, 5.0, None),
    "claude-3-5-haiku": (0.80, 4.0, None),
}
_BY_LENGTH = sorted(PRICES, key=len, reverse=True)


def cost_of(model: str | None, usage: dict | None) -> float | None:
    if not model or not usage:
        return None
    name = re.sub(r"\[.*?\]", "", model.lower()).removeprefix("anthropic.")
    key = next((k for k in _BY_LENGTH if name.startswith(k)), None)
    if key is None:
        return None
    inp, out, read = PRICES[key]
    fresh = usage.get("input_tokens") or 0
    cached = usage.get("cache_read_input_tokens") or 0
    written = usage.get("cache_creation_input_tokens") or 0
    split = usage.get("cache_creation") or {}
    w1h = split.get("ephemeral_1h_input_tokens") or 0
    w5m = split.get("ephemeral_5m_input_tokens", written - w1h) or 0
    if key == "claude-haiku-5-5" and fresh + cached + written > 100_000:
        inp, out = 0.50, 2.50  # long-prompt tier
    if read is None:
        read = inp * 0.1
    total = (fresh * inp + w5m * inp * 1.25 + w1h * inp * 2 + cached * read
             + (usage.get("output_tokens") or 0) * out) / 1e6
    if usage.get("speed") == "fast":
        total *= 2
    return total


# ---------------------------------------------------------------- parsing

def parse_json(text: str):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def as_blocks(content) -> list[dict]:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b if isinstance(b, dict) else {"type": "text", "text": str(b)} for b in content]
    return [{"type": "text", "text": json.dumps(content)}]


def plain_text(blocks: list[dict]) -> str:
    return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def result_text(block: dict) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    parts = []
    for b in as_blocks(content):
        if b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif b.get("type") == "image":
            parts.append(f"[image {b.get('source', {}).get('media_type', '')}]")
        else:
            parts.append(json.dumps(b, ensure_ascii=False))
    return "\n".join(parts)


def parse_sse(text: str) -> tuple[dict | None, str | None, int]:
    """Rebuild a Messages API reply from its event stream."""
    message: dict | None = None
    blocks: dict[int, dict] = {}
    partial: dict[int, str] = {}
    error = None
    count = 0
    for chunk in re.split(r"\r?\n\r?\n", text):
        data = [ln[5:].lstrip() for ln in chunk.splitlines() if ln.startswith("data:")]
        if not data:
            continue
        ev = parse_json("\n".join(data))
        if not isinstance(ev, dict):
            continue
        count += 1
        kind = ev.get("type")
        if kind == "message_start":
            message = dict(ev.get("message") or {})
        elif kind == "content_block_start":
            blocks[ev.get("index", len(blocks))] = dict(ev.get("content_block") or {})
        elif kind == "content_block_delta":
            i, d = ev.get("index", 0), ev.get("delta") or {}
            b = blocks.setdefault(i, {"type": "text", "text": ""})
            dt = d.get("type")
            if dt == "text_delta":
                b["text"] = b.get("text", "") + d.get("text", "")
            elif dt == "input_json_delta":
                partial[i] = partial.get(i, "") + d.get("partial_json", "")
            elif dt == "thinking_delta":
                b["thinking"] = b.get("thinking", "") + d.get("thinking", "")
            elif dt == "signature_delta":
                b["signature"] = b.get("signature", "") + d.get("signature", "")
            elif dt == "citations_delta":
                b.setdefault("citations", []).append(d.get("citation"))
        elif kind == "content_block_stop":
            i = ev.get("index", 0)
            if i in partial:
                parsed = parse_json(partial[i]) if partial[i] else {}
                blocks[i]["input"] = parsed if parsed is not None else {"_unparsed": partial[i]}
        elif kind == "message_delta":
            message = message or {}
            for k, v in (ev.get("delta") or {}).items():
                message[k] = v
            if ev.get("usage"):
                message["usage"] = {**(message.get("usage") or {}), **ev["usage"]}
        elif kind == "error":
            err = ev.get("error") or {}
            error = f"{err.get('type', 'error')}: {err.get('message', '')}"
    for i, raw in partial.items():  # stream cut off mid tool call
        if "input" not in blocks.get(i, {}) or blocks[i].get("input") == {}:
            parsed = parse_json(raw)
            blocks[i]["input"] = parsed if parsed is not None else {"_unparsed": raw}
    if message is not None:
        message["content"] = [blocks[i] for i in sorted(blocks)]
    return message, error, count


def tool_brief(name: str, args) -> str:
    """One line that says what a tool call does."""
    if not isinstance(args, dict):
        return ""
    for key in ("command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"):
        if isinstance(args.get(key), str) and args[key]:
            return args[key].strip().splitlines()[0][:160]
    s = json.dumps(args, ensure_ascii=False)
    return s[:160]


def clip(text: str, n: int = PREVIEW) -> tuple[str, bool]:
    return (text, False) if len(text) <= n else (text[:n], True)


# ---------------------------------------------------------------- store

class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.listeners: list[queue.Queue] = []
        self.reset_state()

    def reset_state(self) -> None:
        self.exchanges: dict[str, dict] = {}
        self.tools: dict[str, dict] = {}
        self.seq = 0

    # -- fan-out
    def subscribe(self) -> tuple[queue.Queue, dict]:
        q: queue.Queue = queue.Queue()
        with self.lock:
            self.listeners.append(q)
            snap = {"exchanges": [self.summary(e) for e in self.exchanges.values()],
                    "tools": [self.tool_view(t) for t in self.tools.values()]}
        return q, snap

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            if q in self.listeners:
                self.listeners.remove(q)

    def publish(self, event: str, data) -> None:
        msg = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        for q in list(self.listeners):
            q.put(msg)

    def reset(self) -> None:
        with self.lock:
            self.reset_state()
            for q in list(self.listeners):
                q.put("event: reset\ndata: {\"exchanges\": [], \"tools\": []}\n\n")

    # -- ingest
    def ingest(self, rec: dict) -> None:
        kind, rid = rec.get("type"), rec.get("id")
        if not rid:
            return
        with self.lock:
            if kind == "request":
                self.seq += 1
                ex = {"seq": self.seq, "id": rid, "ts": rec.get("ts"), "method": rec.get("method"),
                      "path": rec.get("path") or "", "upstream": rec.get("upstream"),
                      "req_headers": rec.get("headers") or [], "req_text": rec.get("body") or "",
                      "pending": True, "status": None, "message": None, "error": None,
                      "resp_headers": [], "resp_text": "", "events": 0}
                ex["req"] = parse_json(ex["req_text"]) if ex["req_text"] else None
                self.exchanges[rid] = ex
                changed = self.scan_request(ex)
            else:
                ex = self.exchanges.get(rid)
                if ex is None:
                    return
                ex["pending"] = False
                ex["end_ts"] = rec.get("ts")
                if kind == "error":
                    ex["error"] = rec.get("error") or "proxy error"
                    ex["duration_ms"] = round(((rec.get("ts") or 0) - (ex["ts"] or 0)) * 1000)
                    changed = []
                else:
                    self.apply_response(ex, rec)
                    changed = self.scan_reply(ex)
            ex.pop("_summary", None)
            self.publish("exchange", self.summary(ex))
            for tid in changed:
                self.publish("tool", self.tool_view(self.tools[tid]))

    def apply_response(self, ex: dict, rec: dict) -> None:
        ex.update(status=rec.get("status"), reason=rec.get("reason"), resp_headers=rec.get("headers") or [],
                  resp_text=rec.get("body") or "", ttfb_ms=rec.get("ttfb_ms"), duration_ms=rec.get("duration_ms"))
        body = ex["resp_text"]
        ctype = next((v for k, v in ex["resp_headers"] if k.lower() == "content-type"), "")
        error = rec.get("error")
        if "event-stream" in ctype or body.lstrip().startswith(("event:", "data:")):
            message, sse_error, ex["events"] = parse_sse(body)
            error = sse_error or error
        else:
            parsed = parse_json(body) if body else None
            message = parsed if isinstance(parsed, dict) and parsed.get("type") == "message" else None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                err = parsed["error"]
                error = f"{err.get('type', 'error')}: {err.get('message', '')}"
            ex["json"] = parsed
        if (ex["status"] or 0) >= 400 and not error:
            error = f"HTTP {ex['status']} {ex.get('reason') or ''}".strip()
        ex["message"], ex["error"] = message, error

    def tool_entry(self, tid: str) -> dict:
        t = self.tools.get(tid)
        if t is None:
            t = self.tools[tid] = {"id": tid, "name": None, "input": None, "call_ex": None, "call_seq": None,
                                   "call_ts": None, "call_end": None, "result": None, "is_error": False,
                                   "result_ex": None, "result_seq": None, "result_ts": None}
        return t

    def scan_request(self, ex: dict) -> list[str]:
        """Record tool calls and results the conversation history carries."""
        req = ex["req"]
        if not isinstance(req, dict) or not isinstance(req.get("messages"), list):
            return []
        changed = []
        for msg in req["messages"]:
            if not isinstance(msg, dict):
                continue
            for b in as_blocks(msg.get("content")):
                if b.get("type") in ("tool_use", "server_tool_use") and b.get("id"):
                    t = self.tool_entry(b["id"])
                    if t["name"] is None:
                        t.update(name=b.get("name"), input=b.get("input"))
                        changed.append(b["id"])
                elif b.get("type") == "tool_result" and b.get("tool_use_id"):
                    t = self.tool_entry(b["tool_use_id"])
                    if t["result_ex"] is None:
                        t.update(result=result_text(b), is_error=bool(b.get("is_error")),
                                 result_ex=ex["id"], result_seq=ex["seq"], result_ts=ex["ts"])
                        changed.append(b["tool_use_id"])
        return list(dict.fromkeys(changed))

    def scan_reply(self, ex: dict) -> list[str]:
        changed = []
        for b in (ex["message"] or {}).get("content") or []:
            if b.get("type") in ("tool_use", "server_tool_use") and b.get("id"):
                t = self.tool_entry(b["id"])
                t.update(name=b.get("name"), input=b.get("input"), call_ex=ex["id"], call_seq=ex["seq"],
                         call_ts=ex["ts"], call_end=ex.get("end_ts"))
                changed.append(b["id"])
        return changed

    # -- views
    def summary(self, ex: dict) -> dict:
        if "_summary" in ex:
            return ex["_summary"]
        req = ex["req"] if isinstance(ex["req"], dict) else {}
        msgs = req.get("messages") if isinstance(req.get("messages"), list) else []
        message = ex["message"] or {}
        usage = message.get("usage") or None
        model = message.get("model") or req.get("model")
        path = ex["path"].split("?")[0]
        kind = ("count_tokens" if path.endswith("/count_tokens") else
                "messages" if path.endswith("/messages") else "other")
        content = message.get("content") or []
        calls = [{"id": b["id"], "name": b.get("name")} for b in content
                 if b.get("type") in ("tool_use", "server_tool_use") and b.get("id")]
        last = msgs[-1] if msgs and isinstance(msgs[-1], dict) else {}
        last_blocks = as_blocks(last.get("content"))
        results = [{"id": b.get("tool_use_id"), "name": (self.tools.get(b.get("tool_use_id")) or {}).get("name"),
                    "is_error": bool(b.get("is_error"))} for b in last_blocks if b.get("type") == "tool_result"]
        reply = plain_text(content).strip()
        if not reply and calls:
            reply = " · ".join(f"{b.get('name')}({tool_brief(b.get('name'), b.get('input'))[:60]})"
                               for b in content if b.get("type") in ("tool_use", "server_tool_use"))
        said = plain_text([b for b in last_blocks if not b.get("text", "").lstrip().startswith("<system-reminder>")])
        system = as_blocks(req.get("system"))
        if kind == "count_tokens" and isinstance(ex.get("json"), dict):
            usage = {"input_tokens": ex["json"].get("input_tokens")}
        s = {
            "id": ex["id"], "seq": ex["seq"], "ts": ex["ts"], "method": ex["method"], "path": ex["path"],
            "kind": kind, "pending": ex["pending"], "status": ex["status"], "error": ex["error"],
            "model": model, "stream": bool(req.get("stream")), "duration_ms": ex.get("duration_ms"),
            "ttfb_ms": ex.get("ttfb_ms"), "usage": usage,
            "cost": cost_of(model, usage) if kind == "messages" else None,
            "stop_reason": message.get("stop_reason"),
            "n_messages": len(msgs), "n_tools": len(req.get("tools") or []),
            "system_chars": sum(len(b.get("text", "")) for b in system),
            "req_bytes": len(ex["req_text"].encode("utf-8", "replace")),
            "resp_bytes": len(ex["resp_text"].encode("utf-8", "replace")),
            "tool_calls": calls, "tool_results": results,
            "reply_preview": reply[:240], "new_preview": said.strip()[:240],
            "new_role": last.get("role"),
        }
        ex["_summary"] = s
        return s

    def tool_view(self, t: dict, full: bool = False) -> dict:
        v = {k: t[k] for k in ("id", "name", "call_ex", "call_seq", "call_ts", "is_error",
                               "result_ex", "result_seq", "result_ts")}
        v["brief"] = tool_brief(t["name"] or "", t["input"])
        v["has_result"] = t["result_ex"] is not None
        if t["result_ts"] and t["call_end"]:
            v["wait_ms"] = round((t["result_ts"] - t["call_end"]) * 1000)
        inp = json.dumps(t["input"], ensure_ascii=False, indent=2) if t["input"] is not None else ""
        res = t["result"] or ""
        if full:
            v["input"], v["result"], v["clipped"] = t["input"], res, False
        else:
            input_short, a = clip(inp)
            v["input"] = t["input"] if not a else None
            v["input_text"] = input_short if a else None
            v["result"], b = clip(res)
            v["clipped"] = a or b
        v["result_len"] = len(res)
        return v

    def detail(self, rid: str) -> dict | None:
        with self.lock:
            ex = self.exchanges.get(rid)
            if ex is None:
                return None
            req = ex["req"]
            d = {"summary": self.summary(ex), "req_headers": ex["req_headers"], "resp_headers": ex["resp_headers"],
                 "reason": ex.get("reason"), "message": ex["message"], "upstream": ex.get("upstream"),
                 "events": ex["events"]}
            if isinstance(req, dict):
                msgs = req.get("messages") if isinstance(req.get("messages"), list) else []
                d["system"] = as_blocks(req.get("system"))
                d["tools"] = req.get("tools") or []
                d["history"] = msgs[:-1]
                d["new_message"] = msgs[-1] if msgs else None
                d["params"] = {k: v for k, v in req.items() if k not in ("system", "tools", "messages")}
            else:
                d["req_raw"] = ex["req_text"]
            if ex["message"] is None:
                d["resp_raw"] = ex["resp_text"]
            else:
                d["resp_raw_len"] = len(ex["resp_text"])
            return d

    def raw_response(self, rid: str) -> str | None:
        with self.lock:
            ex = self.exchanges.get(rid)
            return None if ex is None else ex["resp_text"]

    def tool_full(self, tid: str) -> dict | None:
        with self.lock:
            t = self.tools.get(tid)
            return None if t is None else self.tool_view(t, full=True)


# ---------------------------------------------------------------- log tailing

class Tail(threading.Thread):
    def __init__(self, store: Store, path: Path) -> None:
        super().__init__(daemon=True)
        self.store, self.path = store, path
        self.offset, self.buf = 0, b""
        self.lock = threading.Lock()

    def restart(self) -> None:
        self.offset, self.buf = 0, b""
        self.store.reset()

    def run(self) -> None:
        while True:
            with self.lock:
                self.step()
            time.sleep(0.25)

    def step(self) -> None:
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            if self.offset:
                self.restart()
            return
        if size < self.offset:  # truncated or replaced
            self.restart()
        if size == self.offset:
            return
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(size - self.offset)
        self.offset += len(data)
        *lines, self.buf = (self.buf + data).split(b"\n")
        for line in lines:
            rec = parse_json(line.decode("utf-8", "replace"))
            if isinstance(rec, dict):
                self.store.ingest(rec)

    def archive(self) -> str | None:
        with self.lock:
            target = None
            if self.path.exists() and self.path.stat().st_size:
                target = self.path.with_name(f"{self.path.stem}-{datetime.now():%Y%m%d-%H%M%S}.jsonl")
                self.path.rename(target)
            self.restart()
            return str(target) if target else None


# ---------------------------------------------------------------- http

def make_handler(store: Store, tail: Tail):
    files = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
             "/style.css": ("style.css", "text/css")}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

        def send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, data, code: int = 200) -> None:
            self.send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json")

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path in files:
                name, ctype = files[path]
                return self.send(200, (STATIC / name).read_bytes(), ctype)
            if path == "/api/stream":
                return self.stream()
            m = re.fullmatch(r"/api/(exchange|raw|tool)/(.+)", path)
            if m:
                key = unquote(m.group(2))
                if m.group(1) == "raw":
                    raw = store.raw_response(key)
                    return self.send(200, raw.encode(), "text/plain") if raw is not None else self.send_json(None, 404)
                data = store.detail(key) if m.group(1) == "exchange" else store.tool_full(key)
                return self.send_json(data, 200 if data is not None else 404)
            self.send_json({"error": "not found"}, 404)

        def do_POST(self) -> None:
            if urlsplit(self.path).path == "/api/clear":
                return self.send_json({"archived": tail.archive()})
            self.send_json({"error": "not found"}, 404)

        def stream(self) -> None:
            q, snap = store.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                self.wfile.write(f"event: reset\ndata: {json.dumps(snap, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=15)
                    except queue.Empty:
                        msg = ": keepalive\n\n"
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                store.unsubscribe(q)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Live dashboard for proxy.py's traffic log.")
    parser.add_argument("--port", type=int, default=8042)
    parser.add_argument("--log", default=str(DEFAULT_LOG), help="the traffic log proxy.py writes")
    args = parser.parse_args()
    store = Store()
    tail = Tail(store, Path(args.log))
    tail.step()  # load what is already there before the first browser connects
    tail.start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, tail))
    server.daemon_threads = True
    print(f"dashboard on http://localhost:{args.port}  reading {args.log}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
