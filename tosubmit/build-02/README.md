# Agent traffic dashboard

A live browser view of everything the agent sends to the model through `proxy.py`, and every
reply it gets back. You only need Python 3.8+ (standard library). The Graphs tab loads Chart.js
from cdnjs, so it needs an internet connection.

## Run it

```sh
# terminal 1: the proxy (unchanged). It appends every exchange to ./traffic.jsonl
python3 proxy.py

# terminal 2: the dashboard. It tails ./traffic.jsonl
python3 dashboard/server.py            # then open http://localhost:8042

# terminal 3: the agent, pointed at the proxy
ANTHROPIC_BASE_URL=http://localhost:8041 claude
```

Requests show up as soon as the proxy logs them (with a spinner), and fill in when the reply ends.

Options: `python3 dashboard/server.py --port 9000 --log path/to/traffic.jsonl`.
If you started the proxy with `--log somewhere.jsonl`, pass the same path here.

### Try it without an agent

```sh
python3 dashboard/demo_traffic.py --out demo.jsonl          # 3 made-up prompts, ~20 requests
python3 dashboard/server.py --log demo.jsonl
# or watch it arrive live:
python3 dashboard/demo_traffic.py --out demo-live.jsonl --live &  python3 dashboard/server.py --log demo-live.jsonl
```

## What's on the page

- **Top bar:** 4 big tiles (total tokens, estimated cost, time, tool calls), each with "this
  prompt vs previous prompt". Every other total sits in the small "More" line under them.
- **Traffic:** requests newest first, grouped by the prompt they belong to. The coloured left
  edge and the label give the role: blue **New prompt**, orange **Tool loop**, green **Final
  answer**, grey and dimmed **Side request**, red **Error**. Click a row (or use ↑/↓) to open
  it on the right. The detail pane shows, from top to bottom: the conversation (what was sent
  this turn, then the model's reply; each tool call sits next to its result, even though the
  result arrives in a later request), then 4 headline numbers with "vs previous", then
  collapsed cards for the system prompt (in full), the tool definitions and the earlier
  conversation, then a collapsed **Details** card (cache, sizes, TTFB, parameters, headers,
  raw JSON). You can filter by tool, search text, hide side calls, or show errors only.
- **Tool calls:** every tool call with its result, how long the tool took, and links to the
  request that asked for it and the one that sent the result back. Filter by tool or by
  failures, and click a row to see the full input and output.
- **Graphs:** tokens (new input, cache read, cache write, output), cost (plus a running
  total), time (first byte, then the rest), request size, and tool calls per tool. Switch
  between per request and per prompt. Hover a bar for exact values, and click it to open that
  request. The charts update live.
- **Theme:** the ◐ button cycles between system, light and dark.
- **Archive & clear:** renames `traffic.jsonl` to `traffic-YYYYMMDD-HHMMSS.jsonl` and starts
  over. The proxy opens the log for each write, so it just starts a new file.

## How it works

`dashboard/server.py` reads the new lines of the log on each poll. It pairs each `request`
record with its `response`/`error` record by `id` and parses the Messages API bodies (the JSON
request, and the SSE or JSON reply). It links each `tool_use` id to the `tool_result` that
comes back later. The page polls `/api/state` once a second and only gets what changed. Full
bodies are only fetched when you open a request. Traffic is kept in the JSONL file, not in a
database, so restarting the dashboard reloads the whole session.

Costs are **estimates** from `dashboard/pricing.json` (USD per million tokens, matched by model
name). Edit that file if your prices differ.
