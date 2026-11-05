# Proxy traffic dashboard

A live browser view of everything that passes through `proxy.py`, built to `SPEC.md`.
Python standard library and plain HTML/JS: nothing to install, no build step.

```sh
python3 proxy.py                                   # terminal 1: proxy on :8041, writes traffic.jsonl
python3 dashboard/server.py                        # terminal 2: dashboard on http://localhost:8042
ANTHROPIC_BASE_URL=http://localhost:8041 claude    # terminal 3: the agent
```

Options: `proxy.py --log PATH` (or `--log ""` to turn logging off), `server.py --port N --log PATH`.

## How it fits together

`proxy.py` still prints and forwards exactly as before. It also appends a `request`
record to `traffic.jsonl` when a call arrives, and a `response` (or `error`) record when
the reply finishes. Credential headers are cut to 16 characters, as in its printout.

`dashboard/server.py` tails that file and, for each exchange:

- splits the request into **system instructions**, **tool definitions**, **conversation history** and the **new message** (the last one);
- rebuilds the streamed reply (SSE) into content blocks: text, thinking, tool calls;
- reads usage and turns it into an **estimated cost** using list prices (`PRICES` in `server.py`; unknown models show no cost);
- pairs every `tool_use` with the `tool_result` that arrives in a later request, matched on `tool_use_id`.

It pushes updates to the browser with Server-Sent Events. The page fetches an exchange's
full body only when you open it, so transcripts of 90 KB or more don't slow down the list.

## The page

- **Traffic**: requests newest first. In-flight calls show `live`. Errors get a red edge and a `✕`. Chips show the tool calls a reply made (`→`) and the results a request carried (`↩`).
- **Detail**: metrics (tokens, cache read/write, cost, total time, time to first byte, sizes), then collapsible sections: reply, new message, system, tools, history, parameters, headers, raw. Long text is collapsed, and JSON is shown as a collapsible tree.
- **Tool pairing**: each call is shown as a two-column card, the call on the left and its result on the right. It has links to the request that asked for the call and the request that carried the result, plus the turnaround time between them. A card waiting for its result updates in place when the result arrives.
- **Tool calls** tab: usage per tool (calls, errors, pending, median turnaround) and every call/result pair.
- **Filters**: text search, tool, model, errors only, and hide side calls (`count_tokens`, probes). The stat tiles total whatever the filters show. Press `j`/`k` to move through the list. The URL hash links to the selected request.

## Open decisions in the spec, as resolved here

- **Persistence**: the JSONL log is the store, so history survives restarts with no database. **Clear** renames it to `traffic-<date>.jsonl` and starts fresh; nothing is deleted. The logs hold full prompts, so `.gitignore` excludes them.
- **Pairing layout**: the result is shown under the call, side by side, wherever the call appears: in the reply that made it, in the request that returned it, and in the history.

Only the Anthropic Messages format is broken down. Other upstreams (e.g. `--upstream` for Codex) still appear, with their raw request and response bodies.
