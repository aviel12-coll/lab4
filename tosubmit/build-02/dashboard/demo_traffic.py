#!/usr/bin/env python3
"""dashboard/demo_traffic.py: write made-up traffic in proxy.py's traffic.jsonl format.

For trying the dashboard without an API key or a running agent:

    python3 dashboard/demo_traffic.py --out demo.jsonl          # write it all at once
    python3 dashboard/demo_traffic.py --out demo.jsonl --live   # one exchange every ~2 s
    python3 dashboard/server.py --log demo.jsonl

The records have exactly the fields proxy.py writes: a "request" record, then a
"response" record (SSE body, ttfb_ms, duration_ms) or an "error" record.
"""

from __future__ import annotations

import argparse
import itertools
import json
import random
import time
from pathlib import Path

SEQ = itertools.count(1)
MODEL = "claude-sonnet-4-5-20250929"
SIDE_MODEL = "claude-haiku-4-5-20251001"

SYSTEM = [
    {"type": "text", "text": "x-anthropic-billing-header: cc_version=demo"},
    {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
     + "You are an interactive CLI tool that helps users with software engineering tasks.\n" * 40,
     "cache_control": {"type": "ephemeral"}},
]
TOOLS = [
    {"name": n, "description": d + "\n" + "Usage notes: ...\n" * 10,
     "input_schema": {"type": "object", "properties": props, "required": list(props)}}
    for n, d, props in [
        ("Bash", "Executes a given bash command.", {"command": {"type": "string"}, "description": {"type": "string"}}),
        ("Read", "Reads a file from the local filesystem.", {"file_path": {"type": "string"}}),
        ("Edit", "Performs exact string replacements in files.", {"file_path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}),
        ("Grep", "A powerful search tool built on ripgrep.", {"pattern": {"type": "string"}}),
        ("Task", "Launch a new agent to handle complex, multi-step tasks.", {"description": {"type": "string"}, "prompt": {"type": "string"}, "subagent_type": {"type": "string"}}),
    ]
]
REMINDER = ("<system-reminder>\nAs you answer the user's questions, you can use the following context:\n"
            "# claudeMd\nContents of /project/CLAUDE.md:\n- Use pytest for tests.\n- Keep functions small.\n</system-reminder>")


def sse(blocks: list[dict], usage: dict, stop: str, model: str = MODEL) -> str:
    out = []

    def ev(name, data):
        out.append(f"event: {name}\ndata: {json.dumps(data)}\n\n")

    ev("message_start", {"type": "message_start", "message": {
        "id": f"msg_demo{random.randrange(10**8)}", "type": "message", "role": "assistant", "model": model,
        "content": [], "stop_reason": None,
        "usage": {"input_tokens": usage["input"], "cache_creation_input_tokens": usage.get("cw", 0),
                  "cache_read_input_tokens": usage.get("cr", 0), "output_tokens": 1}}})
    for i, b in enumerate(blocks):
        if b["type"] == "text":
            ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
            for k in range(0, len(b["text"]), 40):
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"][k:k + 40]}})
        elif b["type"] == "thinking":
            ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "thinking", "thinking": ""}})
            ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "thinking_delta", "thinking": b["thinking"]}})
            ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "signature_delta", "signature": "abc"}})
        else:
            ev("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}})
            js = json.dumps(b["input"])
            for k in range(0, len(js), 25):
                ev("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": js[k:k + 25]}})
        ev("content_block_stop", {"type": "content_block_stop", "index": i})
    ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                         "usage": {"output_tokens": usage["output"]}})
    ev("message_stop", {"type": "message_stop"})
    return "".join(out)


class Session:
    def __init__(self, out: Path, live: bool):
        self.out, self.live = out, live
        self.messages: list[dict] = []
        self.t = time.time() - (0 if live else 3600)
        self.ids = itertools.count(1)
        self.cache = 0

    def write(self, rec: dict) -> None:
        with open(self.out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def tick(self, seconds: float) -> None:
        if self.live:
            time.sleep(min(seconds, 2.5))
            self.t = time.time()
        else:
            self.t += seconds

    def exchange(self, body: dict, reply: str | None, *, status=200, path="/v1/messages?beta=true",
                 ttfb=900, dur=3000, fail: str | None = None) -> None:
        rid = f"{int(self.t * 1000):x}-{next(SEQ)}"
        headers = [["host", "localhost:8041"], ["content-type", "application/json"],
                   ["authorization", "Bearer sk-ant-oat01-..."], ["anthropic-version", "2023-06-01"],
                   ["anthropic-beta", "claude-code-20250219,interleaved-thinking-2025-05-14"],
                   ["user-agent", "claude-cli/2.0 (external, cli)"]]
        self.write({"type": "request", "id": rid, "ts": self.t, "method": "POST", "path": path,
                    "upstream": "https://api.anthropic.com", "headers": headers, "body": json.dumps(body)})
        self.tick(dur / 1000)
        if fail:
            self.write({"type": "error", "id": rid, "ts": self.t, "error": fail})
            return
        ctype = "text/event-stream" if body.get("stream") and status == 200 else "application/json"
        self.write({"type": "response", "id": rid, "ts": self.t, "status": status,
                    "reason": {200: "OK", 529: "", 400: "Bad Request"}.get(status, ""),
                    "headers": [["content-type", ctype], ["request-id", f"req_demo{random.randrange(10**8)}"],
                                ["anthropic-ratelimit-unified-status", "allowed"]],
                    "body": reply or "", "ttfb_ms": ttfb, "duration_ms": dur, "error": None})

    def main_call(self, blocks: list[dict], stop: str, out_tokens: int, **kw) -> None:
        size = len(json.dumps(self.messages)) // 4
        new = max(size - self.cache, 50)
        body = {"model": MODEL, "max_tokens": 32000, "stream": True, "system": SYSTEM, "tools": TOOLS,
                "messages": self.messages, "metadata": {"user_id": "demo"}, "thinking": {"type": "enabled", "budget_tokens": 4000}}
        usage = {"input": 4 if self.cache else 3, "cw": new, "cr": self.cache + 9000, "output": out_tokens}
        self.cache += new
        self.exchange(body, sse(blocks, usage, stop), ttfb=random.randint(700, 2200), dur=random.randint(2500, 9000), **kw)
        if stop:
            self.messages.append({"role": "assistant", "content": blocks})

    def side(self, prompt: str, answer: str, **kw) -> None:
        body = {"model": SIDE_MODEL, "max_tokens": 512, "stream": True,
                "system": [{"type": "text", "text": "Analyze if this message indicates a new conversation topic."}],
                "messages": [{"role": "user", "content": prompt}]}
        self.exchange(body, sse([{"type": "text", "text": answer}], {"input": 120, "output": 20}, "end_turn", SIDE_MODEL),
                      ttfb=300, dur=600, **kw)

    def user(self, text: str, first: bool = False) -> None:
        content = ([{"type": "text", "text": REMINDER}] if first else []) + [{"type": "text", "text": text}]
        self.messages.append({"role": "user", "content": content})

    def results(self, items: list[tuple[str, str, bool]]) -> None:
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": text, **({"is_error": True} if err else {})}
            for tid, text, err in items]})

    def tool(self, name: str, inp: dict) -> dict:
        return {"type": "tool_use", "id": f"toolu_demo{next(self.ids):04d}", "name": name, "input": inp}


def run(out: Path, live: bool) -> None:
    s = Session(out, live)
    body = {"model": SIDE_MODEL, "max_tokens": 1, "messages": [{"role": "user", "content": "quota"}]}
    s.exchange(body, json.dumps({"id": "msg_q", "type": "message", "role": "assistant", "model": SIDE_MODEL,
                                 "content": [{"type": "text", "text": "Hi"}], "stop_reason": "max_tokens",
                                 "usage": {"input_tokens": 8, "output_tokens": 1}}), ttfb=250, dur=260)
    s.tick(4)

    # Prompt 1: read, run tests (one fails), fix, answer.
    s.user("The tests in tests/test_parser.py are failing. Can you find out why and fix it?", first=True)
    s.side("The tests in tests/test_parser.py are failing.", '{"isNewTopic": true, "title": "Fix parser tests"}')
    a = s.tool("Bash", {"command": "python -m pytest tests/test_parser.py -q", "description": "Run the parser tests"})
    s.main_call([{"type": "thinking", "thinking": "Let me run the tests first to see the failure."},
                 {"type": "text", "text": "I'll run the failing tests first."}, a], "tool_use", 80)
    s.tick(3)
    s.results([(a["id"], "F.\n=== FAILURES ===\ntest_parse_empty: AssertionError: expected [] got None\n1 failed, 1 passed", False)])
    b = s.tool("Read", {"file_path": "/project/src/parser.py"})
    c = s.tool("Grep", {"pattern": "def parse"})
    s.main_call([b, c], "tool_use", 60)
    s.tick(1)
    code = "\n".join(f"{i:>4}\t" + line for i, line in enumerate(
        ["def parse(text):", "    if not text:", "        return None", "    return text.split(',')"] + ["    # ..."] * 60, 1))
    s.results([(b["id"], code, False), (c["id"], "src/parser.py:1:def parse(text):", False)])
    d = s.tool("Edit", {"file_path": "/project/src/parser.py", "old_string": "        return None", "new_string": "        return []"})
    s.main_call([{"type": "text", "text": "`parse` returns `None` for empty input but the test expects `[]`. Fixing that."}, d], "tool_use", 140)
    s.tick(1)
    s.results([(d["id"], "<tool_use_error>File has been modified since read</tool_use_error>", True)])
    e = s.tool("Edit", {"file_path": "/project/src/parser.py", "old_string": "        return None", "new_string": "        return []"})
    s.main_call([{"type": "text", "text": "The file changed under me; retrying the edit."}, e], "tool_use", 90)
    s.tick(1)
    s.results([(e["id"], "The file /project/src/parser.py has been updated.", False)])
    f = s.tool("Bash", {"command": "python -m pytest tests/test_parser.py -q", "description": "Re-run the tests"})
    s.main_call([f], "tool_use", 50)
    s.tick(3)
    s.results([(f["id"], "..\n2 passed in 0.03s", False)])
    s.main_call([{"type": "text", "text": "Fixed. `parse()` returned `None` for empty input while the test expects an empty list. "
                  "I changed the early return in `src/parser.py` to `return []`, and both tests now pass."}], "end_turn", 220)
    s.tick(20)

    # Prompt 2: delegate to a subagent, hit an overloaded error, retry, answer.
    s.user("Now look through the rest of the repo for other functions that return None on empty input.")
    s.side("Now look through the rest of the repo", '{"isNewTopic": false}')
    g = s.tool("Task", {"description": "Find None-on-empty returns", "subagent_type": "Explore",
                         "prompt": "Search the repository for functions that return None when given empty input. Report file:line for each."})
    s.main_call([{"type": "text", "text": "I'll have an explore agent sweep the repo."}, g], "tool_use", 120)
    main_messages = s.messages
    s.messages = [{"role": "user", "content": g["input"]["prompt"]}]
    h = s.tool("Grep", {"pattern": "return None"})
    s.main_call([h], "tool_use", 40)
    s.tick(1)
    s.results([(h["id"], "src/parser.py:3:        return []\nsrc/config.py:12:        return None\nsrc/io.py:40:    return None", False)])
    s.main_call([{"type": "text", "text": "Found two: src/config.py:12 (load_config on empty path) and src/io.py:40 (read_rows on empty file)."}], "end_turn", 90)
    s.messages = main_messages
    s.results([(g["id"], [{"type": "text", "text": "Found two: src/config.py:12 (load_config on empty path) and src/io.py:40 (read_rows on empty file)."}], False)])
    body = {"model": MODEL, "max_tokens": 32000, "stream": True, "system": SYSTEM, "tools": TOOLS, "messages": s.messages}
    s.exchange(body, json.dumps({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
               status=529, ttfb=400, dur=410)
    s.tick(2)
    s.main_call([{"type": "text", "text": "Two more functions do this:\n\n- `src/config.py:12` `load_config` returns `None` for an empty path\n"
                  "- `src/io.py:40` `read_rows` returns `None` for an empty file\n\nWant me to change both to return empty values too?"}], "end_turn", 180)
    s.tick(15)

    # Prompt 3: short question answered directly.
    s.user("No, leave them. What's the test command again?")
    s.exchange({"model": MODEL, "messages": s.messages, "tools": TOOLS}, json.dumps({"input_tokens": 5120}),
               path="/v1/messages/count_tokens?beta=true", ttfb=150, dur=160)
    s.main_call([{"type": "text", "text": "`python -m pytest tests/ -q`"}], "end_turn", 20)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", default="demo-traffic.jsonl")
    p.add_argument("--live", action="store_true", help="write slowly, like a real session")
    a = p.parse_args()
    run(Path(a.out), a.live)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
