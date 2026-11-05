#!/usr/bin/env python3
"""proxy.py: the naive agent-traffic proxy for Lab 4.

A reverse proxy that prints every request and response and forwards them
unchanged. Standard library only; nothing to install.

    python3 proxy.py                       # listens on http://localhost:8041
    ANTHROPIC_BASE_URL=http://localhost:8041 claude

Everything Claude Code sends to the API now passes through this program and is
printed to the terminal. The proxy changes nothing: headers go through untouched
(a subscription login needs its bearer token and its `anthropic-beta` header),
and the reply is streamed back byte for byte as it arrives.

    python3 proxy.py --port 9000
    python3 proxy.py --upstream https://chatgpt.com/backend-api/codex   # for Codex

Every exchange is also appended to traffic.jsonl (next to this file) so the
dashboard in dashboard/ can show it live. `--log ""` turns that off.
"""

from __future__ import annotations

import argparse
import http.client
import itertools
import json
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

# Headers that describe one hop of the connection, not the message. They are
# never forwarded. `accept-encoding` is dropped too, so the API answers in plain
# text and what we print is readable.
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}

UPSTREAM = "https://api.anthropic.com"

# The traffic log the dashboard reads: one JSON object per line, a "request"
# record when the agent's call arrives and a "response" (or "error") record when
# it finishes. Credentials are cut down the same way as in the printout.
LOG_PATH: Path | None = Path(__file__).resolve().parent / "traffic.jsonl"
LOG_LOCK = threading.Lock()
SEQ = itertools.count(1)
SECRET = {"authorization", "x-api-key", "cookie", "set-cookie"}


def redact(pairs) -> list[list[str]]:
    return [[k, v[:16] + "..." if k.lower() in SECRET else v] for k, v in pairs]


def log(record: dict) -> None:
    """Append one record. Opened per write so the dashboard can rotate the file."""
    if LOG_PATH is None:
        return
    line = json.dumps(record, ensure_ascii=False) + "\n"
    try:
        with LOG_LOCK, open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        print(f"[{stamp()}] !!! cannot write {LOG_PATH}: {e}", flush=True)


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class Tap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # we print our own lines

    def do_POST(self) -> None:
        self.relay()

    def do_GET(self) -> None:
        self.relay()

    def do_HEAD(self) -> None:
        self.relay()

    def relay(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        rid = f"{int(time.time() * 1000):x}-{next(SEQ)}"
        started = time.time()
        log({"type": "request", "id": rid, "ts": started, "method": self.command, "path": self.path,
             "upstream": UPSTREAM, "headers": redact(self.headers.items()),
             "body": body.decode("utf-8", "replace")})

        # 1. Print what the agent sent.
        print(f"\n{'=' * 78}\n[{stamp()}] >>> {self.command} {self.path}", flush=True)
        for name, value in self.headers.items():
            if name.lower() in ("authorization", "x-api-key"):
                value = value[:16] + "..."
            print(f"    {name}: {value}")
        if body:
            try:
                print(json.dumps(json.loads(body), indent=2, ensure_ascii=False))
            except ValueError:
                print(body.decode("utf-8", "replace"))

        # 2. Forward it, headers intact.
        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        # Connect with a short timeout (a lost SYN must not stall the agent for
        # minutes); the long timeout is for reading a slow stream.
        upstream = conn_cls(target.netloc, timeout=10)
        try:
            upstream.connect()
        except OSError as e:
            print(f"\n[{stamp()}] !!! cannot reach {UPSTREAM}: {e}", flush=True)
            log({"type": "error", "id": rid, "ts": time.time(), "error": f"cannot reach {UPSTREAM}: {e}"})
            self.send_error(502, f"proxy: cannot reach {UPSTREAM}: {e}")
            self.close_connection = True
            return
        upstream.sock.settimeout(600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP}
        try:
            upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
            reply = upstream.getresponse()
        except OSError as e:
            print(f"\n[{stamp()}] !!! upstream failed: {e}", flush=True)
            log({"type": "error", "id": rid, "ts": time.time(), "error": f"upstream failed: {e}"})
            self.send_error(502, f"proxy: upstream failed: {e}")
            self.close_connection = True
            return
        first_byte = time.time()

        # 3. Stream the reply back as it arrives, printing it on the way.
        print(f"\n[{stamp()}] <<< {reply.status} {reply.reason}", flush=True)
        self.send_response(reply.status, reply.reason)
        for name, value in reply.getheaders():
            if name.lower() not in SKIP and name.lower() != "content-encoding":
                self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        chunks: list[bytes] = []
        failure = None
        try:
            if self.command != "HEAD":
                while chunk := reply.read1(4096):  # read1: pass on each chunk as it lands, don't wait for 4096 bytes
                    chunks.append(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    sys.stdout.write(chunk.decode("utf-8", "replace"))
                    sys.stdout.flush()
        except OSError as e:  # the agent hung up, or the upstream stream broke
            failure = f"stream interrupted: {e}"
            raise
        finally:
            self.close_connection = True
            ended = time.time()
            log({"type": "response", "id": rid, "ts": ended, "status": reply.status, "reason": reply.reason,
                 "headers": redact(reply.getheaders()), "body": b"".join(chunks).decode("utf-8", "replace"),
                 "ttfb_ms": round((first_byte - started) * 1000), "duration_ms": round((ended - started) * 1000),
                 "error": failure})
        if self.command != "HEAD":
            print(f"\n[{stamp()}] --- done", flush=True)


def main() -> None:
    global UPSTREAM, LOG_PATH
    parser = argparse.ArgumentParser(description="Print and forward an agent's API traffic.")
    parser.add_argument("--port", type=int, default=8041)
    parser.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    parser.add_argument("--log", default=str(LOG_PATH), help='traffic log for the dashboard ("" to disable)')
    args = parser.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    LOG_PATH = Path(args.log) if args.log else None
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Tap)
    print(f"proxy listening on http://localhost:{args.port}  ->  {UPSTREAM}")
    print(f"run the agent with:  ANTHROPIC_BASE_URL=http://localhost:{args.port} claude")
    if LOG_PATH:
        print(f"logging traffic to {LOG_PATH}  (view it: python3 dashboard/server.py)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
