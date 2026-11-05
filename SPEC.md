# Proxy Traffic Browser Dashboard SPEC

### Intended Behavior
A real-time web dashboard that connects to the proxy server, captures incoming HTTP requests and responses between the agent and the model provider, and displays them cleanly in the browser in reverse chronological order (newest first).

### Core Features & What the Dashboard Should Show
- **Live Stream:** Every request sent by the harness and every reply from the model, updating in real-time.
- **Request Breakdown:** Clear separation of:
  - System instructions (in full)
  - Tool definitions
  - The conversation history so far
  - The new message
- **Tool Mapping:** Tool calls displayed right beside their corresponding results (even though results arrive in later requests).
- **Model Replies:** Model text output alongside any tool calls it requests.
- **Statistics & Drill-down:** Metrics such as tokens per request, cost, execution time, and tool usage — with the ability to click/open every message to drill down into its full details.
- **UX & Filtering:** Long texts collapsible, JSON formats readable, easy error-spotting, and tool-based filtering.

### Visual Hierarchy: important is bigger and higher
The page has a lot of numbers. They must not all look equally important. Everything on the
page belongs to one of three levels, and the level decides its size and position:

- **Level 1 (biggest, at the top): what happened.** The conversation itself: your prompt,
  the model's reply text, the tool calls and their results, and whether the request
  succeeded or failed. Large text, strong colour, always visible.
- **Level 2 (medium, below it): the few numbers that matter.** At most 4 headline numbers,
  shown as large tiles with a plain-words label: **total tokens**, **estimated cost**,
  **time**, **tool calls**. Each tile may show a small "vs previous" change (↑ / ↓).
- **Level 3 (small, at the bottom or collapsed): details.** Everything else: cache read
  and cache write, time to first byte, request and response size, message and tool counts,
  parameters, headers, raw JSON. Small grey text, or inside a collapsed "Details" section.

The same rule applies everywhere: the global statistics bar at the top of the page (4 big
tiles, the rest in a small "more" line), each row in the request list (preview text big,
numbers small), and the detail pane of one request (conversation first, numbers next,
details last).

### Colours
Colour carries meaning, so the eye can sort the page before reading it. Each kind of
message has one colour, a label and an icon, used the same way in the list, the detail
pane and the graphs:

| Kind | Label | Colour |
|---|---|---|
| Your prompt | YOU | blue |
| Model text reply | MODEL | green |
| Model thinking | THINKING | light green, collapsed |
| Tool call | TOOL CALL · name | orange |
| Tool result | RESULT · name | amber (red if the tool failed) |
| System instructions | SYSTEM | purple |
| Text added by the harness (system-reminders, CLAUDE.md) | HARNESS | grey, collapsed |
| Error (HTTP or API) | ERROR | red |

- Each row in the request list gets a coloured left edge for its role: **new prompt**
  (blue), **tool loop** (orange), **final answer** (green), **side request** (grey, dimmed),
  **error** (red).
- Colours must work in light and dark mode, and colour is never the only signal: labels or
  icons say the same thing.

### Graphs Tab
A third tab, next to Traffic and Tool calls, shows how the numbers change from one prompt
to the next, so trends are seen instead of read:

- **Tokens per request:** stacked bars, split into new input, cache read, cache write and
  output (same colours in every chart, with a legend).
- **Cost:** per request as bars, plus a running total line.
- **Time:** per request, split into waiting for the first byte and the rest.
- **Request size:** how the request grows as the conversation gets longer.
- **Tool calls:** how many calls per prompt, coloured per tool.
- The x-axis is the request number in order; requests that belong to the same user prompt
  are grouped, with the prompt's first words as the group label. A toggle switches between
  "per request" and "per prompt" (summed).
- Hovering a bar shows its exact values; clicking it opens that request in the Traffic tab.
- Side requests are left out unless "hide side calls" is off.
- Charts may use a charting library (for example Chart.js loaded from a CDN) so they are
  interactive and easy to read. They update live as new requests arrive.

### Acceptance Checks
1. Without reading any numbers, you can tell in the list which rows are your prompts, tool
   loops, final answers, side requests and errors, by colour alone (and by label).
2. In the detail pane of a request with a tool call, the conversation is at the top in large
   text; the 4 headline numbers come next; cache/size/header details are small and at the
   bottom or collapsed.
3. The statistics bar at the top shows exactly 4 big tiles; the other totals are small.
4. The Graphs tab shows the five charts above for a session of at least two prompts, and
   they grow live when a new request arrives.
5. Clicking a bar in a chart opens that request in the Traffic tab.
6. All colours are readable in both light and dark mode.

### Integration
- Runs alongside `proxy.py` (capturing traffic from the local proxy server).
- Accessible via a local web browser interface.

### Decisions and Reasons
- **Layout:** Use collapsible cards and clean formatting so that bulky tool definitions and long transcripts (which can exceed 90KB) do not clutter the UI.
- **Updates:** Lightweight polling or WebSockets to keep the stream live without performance lag.

### Open Decisions
- Should traffic be persisted in a local database (like SQLite) between sessions, or kept purely in-memory?
- What is the optimal UI layout for pairing tool calls with their future results?