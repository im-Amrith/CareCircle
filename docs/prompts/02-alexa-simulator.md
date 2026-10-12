# Task: build the CareCircle Alexa+ web simulator (v1)

You are working in the CareCircle repo (Amazon Developer hackathon, Alexa+ track + AWS Builder
mini challenge). Read `README.md`, `server/src/mcp/server.ts`, `server/src/mcp/tools.ts`,
`server/src/mcp/refills.ts` and `docs/friction-log.md` before planning.

## Why this exists

The real Alexa+ add-on tools are partner-only, so judges will see CareCircle through **our own
web simulator that plays the role of Alexa+**. It listens, reasons with an Amazon Bedrock model,
calls our MCP server as a standard MCP client, speaks the answer, and shows cards. The demo video
is recorded in this simulator, so it must look and feel like an Echo device and clearly show the
MCP protocol at work.

## What to build

Two new parts under `alexa-sim/`:

### 1. `alexa-sim/orchestrator` (Python 3.11+, FastAPI)

The "Alexa+ brain".

- **MCP client.**
  - Connects to the CareCircle server at `MCP_URL` (default `http://127.0.0.1:8000/mcp`) over
    Streamable HTTP, using the official MCP Python SDK (`mcp`).
  - Opens one MCP session per profile (`rose`, `sam`, `maya`), sending
    `Authorization: Bearer dev:<profile>`.
  - Sends `initialize` with `clientInfo` name "CareCircle Alexa+ Simulator", and advertises
    elicitation support for both `form` and `url` modes.
- **Agent.** A Strands Agents (`strands-agents`) agent on Amazon Bedrock that gets the MCP tools
  and picks the right one.
  - Model ID comes from `BEDROCK_MODEL_ID` and region from `AWS_REGION` (the account is locked to
    `ap-southeast-2`).
  - Credentials come only from the default AWS credential chain (`aws configure` profile). Never
    hard-code keys and never use a Bedrock API key.
  - System prompt in the voice of Alexa+:
    - Reply in one or two short spoken sentences.
    - Prefer the tool's own `content` text.
    - Never read a URL aloud.
    - Never give medical advice, doses or diagnoses; suggest the doctor or emergency services.
    - Never order anything without a clear yes.
- **Elicitation.** When the MCP server sends `elicitation/create`:
  - Pause the turn and push the request to the browser.
  - Form mode: show the form and speak its message.
  - URL mode: show an "Open secure page" button; never speak the URL.
  - Return the user's reply as `accept`, `decline` or `cancel`.
  - If Strands' MCP client cannot take an elicitation callback in the installed version, open the
    session with the MCP Python SDK's `ClientSession(elicitation_callback=...)` and wrap its tools
    as Strands tools yourself. Log that in the friction log.
- **Protocol log.** Capture every JSON-RPC message sent and received (method, id, direction,
  timing, and the full body, collapsed by default) and stream it to the browser. Intercept at
  the transport layer, not by re-logging tool calls.
- **Speech out.** Amazon Polly neural voice (for example `Joanna` or `Kajal`, whichever works in
  `ap-southeast-2`; check at startup and fall back to browser TTS if Polly fails).
- **API.**
  - `POST /turn` with `{ profile, text }` streams events back over SSE: `transcript`,
    `tool_call` (with `_meta.ui.invoking` text when present), `tool_result` (with
    `structuredContent`), `elicitation`, `speech` (text + audio URL or base64), `rpc` (protocol
    log entries), `done`, `error`.
  - `POST /elicitation/{id}` with `{ action, content }` answers a pending elicitation.
  - `GET /healthz` reports MCP server reachability, Bedrock mode and Polly mode.
- **Mock mode** (`MOCK_AWS=1`, the default when no AWS credentials are found).
  - A small deterministic keyword router replaces Bedrock: "how is", "morning", "status" →
    `get_care_status`; "took" → `log_medication`; "running low", "refill" → `check_refills`;
    "reorder", "order more", "yes" after a low-supply turn → `request_refill`; "feel", "slept",
    "fell" → `log_wellbeing`; "what do I take" → `list_medications`.
  - Browser TTS replaces Polly.
  - Everything else (real MCP server, elicitation, protocol log) stays real.
  - Judges must be able to run the whole demo with no AWS account.
- **Config** via env vars, documented in `alexa-sim/orchestrator/.env.example`. Add `.env` to
  `.gitignore` if it isn't already ignored.

### 2. `alexa-sim/web` (React + Vite + TypeScript)

- **Device picker:**
  - **Echo Show 8**: landscape, 1280×800 frame.
  - **Echo Show 15**: large landscape.
  - **Echo Dot**: no screen. Show only a light ring that animates while listening or speaking,
    plus the transcript.
  - **Phone**: Alexa app style.
- **Profile switcher:** Rose, Sam, Maya. Each keeps its own session and transcript.
- **Alexa button** for push-to-talk using the Web Speech API (Chrome), plus a text box that always
  works.
- **Conversation view:** the user's words, Alexa's spoken reply, and a card under each reply.
- **Native cards rendered from `structuredContent`:**
  - care status: today's doses as taken, due or missed chips, next dose, visit, latest note
  - medication list
  - refill alert
  - refill order status
  - wellbeing note: red flags in a warning style
  - Keep cards simple, large-type and readable at TV/Show distance.
- **MCP Apps hook (later).** If a tool result carries `_meta.ui.resourceUri`, show a placeholder
  "Interactive view" card for now. MCP Apps rendering comes in a later task, so don't build it
  yet.
- **Elicitation UI:** a modal-free inline card in the conversation.
  - Form mode: render the requested fields with Accept, Decline and Cancel.
  - URL mode: an "Open secure page" button that opens the checkout link in a new tab, plus
    Done / Cancel.
- **Protocol panel:** collapsible, on the right on desktop. Lists live JSON-RPC traffic
  (`initialize`, `tools/list`, `tools/call`, `elicitation/create`, responses) with direction
  arrows and timings. This is our proof of MCP depth for judges, so make it clean and legible.
- **Look:** calm and Alexa-like. Dark navy device bezel, cyan accent for the listening ring, large
  sans-serif type. Use no Amazon logos or trademarks: call it "CareCircle simulator", never
  "Alexa app".
- **Proxy:** Vite proxies `/api` to the orchestrator in dev. The MCP server's `ALLOWED_ORIGINS`
  must permit the web origin if the browser ever talks to it directly. It shouldn't; the
  orchestrator does.

## How to run (must work on Windows PowerShell and macOS/Linux)

- **One command from the repo root starts all three processes:** MCP server on 8000,
  orchestrator on 8100, web on 5173.
  - Use an npm workspace script with `concurrently`, or a small Node script. **Not** a Makefile,
    because the developer is on Windows.
  - Python env via `uv` if available, else `python -m venv`. Document both.
- **README:** update with a "Run the simulator" section: prerequisites, mock mode, AWS mode, and
  the demo script lines below.
- **Demo script.** These lines must work in both mock and AWS mode with the clock frozen at 9 am
  IST (`CARECIRCLE_NOW=2026-10-10T03:30:00Z`):
  1. Rose: "Good morning"
  2. Rose: "I took my morning pills"
  3. Sam: "How is Mom today?"
  4. Sam: "Is she running low on anything?" then "Reorder it" then accept the form, then open
     checkout, place the order
  5. Switch to Echo Dot, Sam: "Any updates?"
  6. Rose: "I had a fall in the kitchen"
  7. Rose: "Should I take an extra blood pressure tablet?" → a safe refusal, no tool needed

## Quality bar

- **Orchestrator tests:** pytest in mock mode. Start the real MCP server (from `server/`) as a
  fixture or subprocess, run demo lines 1–4, and assert on tool calls, elicitation handling and
  spoken text. No Bedrock calls in tests.
- **Web:** typechecks and builds with `npm run build`.
- **Existing tests:** all server tests (`cd server && npm test`) still pass.
- **CI:** extend `.github/workflows/test.yml` to run orchestrator tests and the web build.
- **Accessibility:** every button has a label, focus states are visible, text contrast is
  readable in the device frames.
- **No secrets** in code, logs or commits.

## Working method

1. Check installed versions (`python --version`, `node --version`, `aws --version`) and the
   current versions and APIs of `strands-agents`, `mcp` and `boto3` from their docs before
   writing code. Do not rely on memory for these APIs.
2. Propose a short plan (folders, key files, event protocol) and wait for my OK before building.
3. Work on a new branch `feature/simulator`. Commit in small, logical steps with clear messages.
4. Build mock mode end to end first, then switch on Bedrock and Polly.
5. Whenever an Amazon or AWS tool, doc or SDK causes friction (errors, missing docs, confusing
   behaviour), append an entry to `docs/friction-log.md` using its template. This earns judging
   bonus points, so be specific: exact error text, versions, the workaround.
6. When done, push the branch, open a pull request with a summary and screenshots, and tell me:
   how to run it, what works, and anything left undone.

Do not deploy anything to AWS in this task, and do not create AWS resources. The only AWS calls
are Bedrock `Converse`/`ConverseStream` and Polly `SynthesizeSpeech` from my local credentials.
