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

### Integration
- Runs alongside `proxy.py` (capturing traffic from the local proxy server).
- Accessible via a local web browser interface.

### Decisions and Reasons
- **Layout:** Use collapsible cards and clean formatting so that bulky tool definitions and long transcripts (which can exceed 90KB) do not clutter the UI.
- **Updates:** Lightweight polling or WebSockets to keep the stream live without performance lag.

### Open Decisions
- Should traffic be persisted in a local database (like SQLite) between sessions, or kept purely in-memory?
- What is the optimal UI layout for pairing tool calls with their future results?