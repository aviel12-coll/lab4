# Spec history: Agent Traffic Dashboard (Lab 4)

David Fridman and Aviel Amselem. From `git log -p SPEC.md` on aviel12-coll/lab4, plus our
build folders and agent sessions. Each reason says where it came from.

## Commits of SPEC.md

**1. `9605bdf` Add SPEC.md (Aviel), 27 lines.**
The first spec: intended behaviour (live dashboard, newest first), the features from the
handout (request parts, tool calls beside results, replies, stats, drill-down, filtering),
two decisions (collapsible cards; "polling or WebSockets") and two open questions
(SQLite or memory; how to pair tool calls with results).
*Reason:* the commit message gives none. Looking deeper: the dashboard itself (`9beb15d`)
was committed *before* the spec, and its README says it resolved both open questions
(JSONL log as storage; call and result side by side) and uses SSE, not polling. So the
spec trailed the code it described. *(Source: commits `9beb15d` and `9605bdf`, README.)*
We chose this draft over David's longer pre-lab draft, and carried ideas from his over
(the colour-per-message-kind table).

**2. `14456ab` Visual hierarchy, colours, Graphs tab, acceptance checks.**
Added: three levels of importance (what happened = biggest and on top; 4 headline numbers
next; details small and collapsed), one colour, label and icon per message kind and per
request role, a Graphs tab (tokens, cost, time, request size, tool calls; grouped by prompt;
click a bar to open the request), and 6 acceptance checks.
*Reason (commit message):* running the existing build on live traffic showed many numbers
at the same size and in the same grey, so it was hard to tell what mattered or tell
message kinds apart. *(Source: commit message; our session reviewing the build.)*

**3. `b079c40` Allow a charting library for the Graphs tab.**
Replaced "no external libraries, plain SVG" with "may use a charting library such as
Chart.js".
*Reason (commit message):* build-01 was drawing every chart by hand, which made it slow.
The rule was added by the agent drafting the spec, not asked for by us.
*Correction:* the message says build-01 "was stopped before it wrote any code"; in fact it
had written `dashboard/server.py` (663 lines) and no page. *(Source: `lab4-builds/build-01`,
`logs/build-01.note`.)*

## Builds

- **build-01** (spec `14456ab`): fresh headless session, stopped after ~4 minutes (above).
- **build-02** (spec `b079c40`): fresh session, empty folder with only SPEC.md and proxy.py.
  ~11 minutes, 2,474 lines, Chart.js. Passed all 6 acceptance checks on live traffic.
  Problems seen: chart legends overlap the prompt labels; harness `role: "system"` text
  labelled MODEL; prices guessed from memory; it wrote an unrequested demo-traffic generator.
- **Rebuild vs edit:** we decided to switch to editing the code after build-02 because a full
  rebuild took ~11 minutes, but the lab ended before an edit cycle. All builds were from
  scratch. *(Source: our agent session.)*

## Findings in the traffic

- One short prompt makes ~6 calls: a `HEAD /api/hello` check, a `quota` probe with
  `max_tokens: 1` (which got **429** while the session still worked), a session-title
  request sent in parallel with the main one, and the main tool loop.
- Each main request is ~110–130 KB for a one-line prompt: a 3-block system prompt
  (~8 KB), 12–14 tools, and CLAUDE.md/memory injected as `<system-reminder>` text in the
  first user message.
- `messages` contains `role: "system"` entries and `tool_addition` blocks (tools added
  mid-conversation), not only user/assistant turns.
- The tool loop is visible: reply ends `stop_reason: tool_use`, the next request resends the
  whole history plus the `tool_result` with the same id.
- Prompt caching: the first request writes ~39–42k tokens to cache, later ones read them, so
  the first request costs ~10× the next (≈ $0.39 vs $0.04 estimated).
- Headless (`claude -p`) traffic differs from interactive: different identity line, fewer
  tools, no title request, and an extra session-state classifier request at the end.
- The harness sends prompts that look like the user's: "The user stepped away… Recap in
  under 40 words" and "[SUGGESTION MODE: Suggest what the user might naturally type
  next…]". A dashboard must not count them as real prompts. *(Source: Aviel's capture.)*
