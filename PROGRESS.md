# CareCircle: progress and next steps

_Last updated: 2026-10-15_

A quick record of what's built, what to test, what you need to do next, and what's still open.

## At a glance

| | |
| --- | --- |
| Repo | https://github.com/im-Amrith/CareCircle |
| `main` | MCP server and refill ordering (PR #1, merged) |
| `feature/simulator` | Alexa+ web simulator: **pushed, PR not opened yet** |
| `feature/mcp-apps` | Interactive care dashboard (MCP Apps), built on top of `feature/simulator`: **3 commits, local only, not pushed** |
| `feature/family-live` | Live family updates, Hindi, accessibility, reminders, evening summary, built on top of `feature/mcp-apps`: **not committed yet** |
| Tests | 70 server, 21 orchestrator (pytest), web typecheck and build: all passing locally |
| AWS | Bedrock (Nova 2 Lite) and Polly (Kajal, English and Hindi) working from your laptop in ap-southeast-2. No AWS resources created. |

---

## Done

### 1. MCP server core (on `main`)

- MCP 2025-11-25 over Streamable HTTP, with 5 voice-first tools, resources and prompts.
- Demo family (Rose, Sam, Maya) with 14 days of made-up history.
- Protocol checks: sessions locked to the user who opened them, Origin and Host checks, version checks, and resuming dropped connections.
- CI on GitHub Actions.

### 2. Refill ordering (PR #1, merged into `main`)

- New tool `request_refill`:
  - It asks before ordering, either with a confirmation form or a spoken question.
  - It creates a one-time checkout link: 256-bit token, stored only as a hash, valid for 15 minutes.
  - It never orders twice for the same request.
- Secure checkout page at `/checkout/<token>`:
  - Place order or cancel; at most one order, even with double clicks.
  - Rejects posts from other sites.
  - Headers: `no-store`, `same-origin` referrer, no framing, no scripts.
  - Never collects card details.
- `get_care_status` and `check_refills` mention refills already on the way ("A refill arrives tomorrow"), and `check_refills` offers "Want me to reorder it?"

### 3. Alexa+ web simulator (branch `feature/simulator`, pushed)

- **Orchestrator** (`alexa-sim/orchestrator`, Python 3.12 + FastAPI): one MCP session per family member; every JSON-RPC message is captured and streamed to the browser.
- **AWS mode:** a Strands agent on Bedrock `global.amazon.nova-2-lite-v1:0`, with Polly neural voice Kajal.
- **Mock mode** (`MOCK_AWS=1`, or no AWS credentials): a keyword router and browser speech. No AWS account needed.
- **Fallback:** if Bedrock fails, the turn uses the offline router and says so. If Polly fails, the browser speaks instead.
- **Web app** (`alexa-sim/web`, React + Vite):
  - Show 8, Show 15, Dot and Phone device frames.
  - Rose / Sam / Maya switcher, push-to-talk, and a text box.
  - Result cards, confirmation forms and the checkout page inside the conversation.
  - A live MCP protocol panel.
- **Server change found while testing with Nova (FL-10):** `request_refill` always asks through the form when the client supports it, so the model can't supply the yes.
- **Docs:** README "Run the simulator" section, 6 screenshots, and friction log entries FL-09 and FL-10.

### 4. MCP Apps: interactive care dashboard (branch `feature/mcp-apps`, new)

On a device with a screen, "Good morning" or "How is Mom today?" now shows a live dashboard instead of a static card. Voice-only devices (Dot) ignore it and just speak, as before.

- **Server** (`server/src/mcp/apps.ts`, `server/ui/care-dashboard.html`):
  - `get_care_status` points to the view `ui://carecircle/care-dashboard` (`text/html;profile=mcp-app`, MCP Apps spec 2026-01-26).
  - The dashboard shows a progress ring, today's doses by time of day with **Mark taken** buttons, supply with a **Reorder** button, visits, and the latest note (red if it's a safety alert).
  - Self-contained: no network access, no external scripts, fonts or styles.
  - Every tool states who may call it. A view can call only `get_care_status` and `log_medication`. `request_refill` is model-only, so **a view can never place an order**; Reorder goes back through the conversation and its confirmation form.
  - `get_care_status` now returns `isToday`; a past day shows read-only, with no buttons.
- **Simulator:**
  - The orchestrator tells the server it can show MCP Apps. Strands' `MCPClient` has no option for this, so it's added to the `initialize` request on its way out (FL-11).
  - It reads each view once per session and serves a sandbox page from its own origin. The view runs in an inner iframe with no origin and a strict Content-Security-Policy.
  - It refuses a view's call to any tool that isn't marked as callable from apps, before anything reaches the server.
  - The web app talks to the view over postMessage (JSON-RPC). The iframe resizes to fit its content, and the view's "say this" requests (`ui/message`) are said in the conversation.
  - If the view doesn't load within 8 seconds, the normal card shows instead.
  - The protocol panel labels the view's calls "· from app view" and the dashboard read as `resources/read`.
  - Fixed a race where the panel could skip the view's calls if you spoke again within 2 seconds.
- **Checked:** in headless Chrome against mock mode, the dashboard loaded, Mark taken logged a dose (ring 0/5 to 1/5), and Reorder led to the confirmation form, with no browser errors.
- **Friction log FL-11:** Strands' `MCPClient` can't declare MCP extensions.

### 5. Family features (branch `feature/family-live`, new)

- **Live updates across devices.** A change feed on the server announces every write (dose, note, order, language, message). Sessions `resources/subscribe` to the new `carecircle://family/{id}/today` and `.../inbox` resources and get `notifications/resources/updated`. The simulator re-reads them and pushes them to the browser over a new events stream, so an open dashboard updates when someone else logs a dose.
- **Family view** in the simulator: two devices side by side (Rose on a Show 8, Sam on a Phone by default), each with its own conversation, input and settings.
- **Safety alerts.** When Rose reports a red flag ("I had a fall"), every other family device lights up yellow and announces it once. Her own device doesn't.
- **Hindi.** `set_language` per person. The server phrases Rose's main replies in Hindi (status, doses, notes, schedules, supplies, reminders, alerts), medicine names unchanged. Hindi red-flag words are detected. Nova replies in Hindi in AWS mode and Polly Kajal speaks `hi-IN`. The mock router understands Hindi and Hinglish. The dashboard follows the host locale.
- **Accessibility.** "Say that again" repeats the last reply slower with no tool call. **Slower speech** (Polly SSML prosody 85%, or browser rate) and **Large text** per person, on by default for Rose; the dashboard scales through MCP Apps host styles.
- **Gentle reminders.** The server works out overdue doses (30 minutes past their time). Rose's device says them once, after 45 quiet seconds (`REMINDER_IDLE_S`) or on **Remind now**. "Yes" logs them.
- **Evening summary.** A `send_daily_summary` tool and an 8:30 pm scheduler (`DIGEST_TIME`). It goes to the family inbox (a message on Sam's and Maya's phones), and to Amazon SNS when `SNS_TOPIC_ARN` is set. If SNS fails, the inbox copy stays.
- **Fixed on the way:** a stray "null" on the dashboard when there was no toast; the dashboard cache now resets with a new session.
- **Checked:** the Family view in headless Chrome (all seven steps, no browser errors), and AWS mode with Nova and Polly in Hindi.
- **Friction log FL-12:** Strands' `MCPClient` has no resource subscriptions, and the MCP SDK already warns that they're removed in 2026-07-28.

---

## What to test (new features)

### Family view (newest)

`git checkout feature/family-live`, `npm run sim:mock` (or `sim:demo`), then click **Family view**.

| # | Do this | Expect |
| --- | --- | --- |
| F1 | Rose: "Good morning"; Sam: "How is Mom today?" | Both see the dashboard. Rose's text is larger. |
| F2 | Tap **Mark taken** on Rose's dashboard | Sam's dashboard updates by itself within a second. |
| F3 | Rose: **Remind now**, then "Yes" | A yellow reminder card and spoken reminder; "Yes" logs the dose and the card goes away. |
| F4 | Rose: "I had a fall in the kitchen" | Sam's phone turns yellow, shows a red alert card and speaks it after Rose's reply finishes. Nothing on Rose's device. |
| F5 | Rose: "Say that again" | The same reply, slower, no tool call in the panel. |
| F6 | Rose: **हिंदी**, then "सुप्रभात" | Hindi reply and a Hindi dashboard; Sam's replies stay English. Try push-to-talk in Hindi too. |
| F7 | Sam: "Send everyone today's summary" | A green message card with the summary on Sam's phone; **Inbox (1)** appears. |
| F8 | Leave Rose's device alone for 45 seconds with a dose overdue | The reminder comes by itself, once. |
| F9 | Switch Sam to **Dot** and repeat F4 | The alert shows in the caption and the ring glows yellow. |
| F10 | **AWS mode:** "Talk to me in Hindi", then ask how she is | Nova answers in Hindi and Polly speaks Hindi. |

### The dashboard (one device)

These work on `feature/mcp-apps` and on `feature/family-live` in **One device** mode. Open http://127.0.0.1:5173 with the protocol panel open. The demo clock is frozen at 9 am IST, Saturday 10 October. On `feature/family-live`, Rose has large text and slower speech on by default.

| # | Do this | Expect |
| --- | --- | --- |
| 1 | Rose, **Show 8**: say "Good morning" | The dashboard appears in the conversation: "Rose · Saturday 10 October", ring 0/5, Metformin and Vitamin D3 with Mark taken, Amlodipine low with Reorder, Maya's 4 pm visit, "Slept badly last night". |
| 2 | Same, on **Show 15** and **Phone** | The layout fits each frame: two columns on wide frames, one column on narrow ones. No inner scrollbars, no cut-off edges. |
| 3 | Switch to **Dot** | No dashboard, no cards: speech only, as before. |
| 4 | Tap **Mark taken** on Metformin | Button shows "Saving…", then a green note "I've logged Metformin for the morning…"; the ring goes to 1/5; Metformin shows "Taken". |
| 5 | Look at the protocol panel | `tools/call log_medication · from app view` and `tools/call get_care_status · from app view` appear, and no new conversation cards. |
| 6 | Then say "How am I doing today?" | The spoken answer and the new dashboard both count Metformin as taken. |
| 7 | Tap **Reorder** on Amlodipine | "Reorder Amlodipine" appears as if Rose said it, then the usual confirmation form. Accept, then use the checkout page. |
| 8 | Tap Reorder while Alexa is still answering | A red note says the assistant is busy; nothing is sent. |
| 9 | As **Sam** and **Maya**: "How is Mom today?" | Each sees Mom's dashboard; Mark taken works for both (all three roles may log doses). |
| 10 | **AWS mode only:** "How was Mom on Thursday?" | If Nova passes a date, the dashboard shows that day read-only: status labels, no buttons. In mock mode the router ignores dates. |
| 11 | Press **Tab** through the dashboard | Each button gets a visible focus ring; Enter activates it. |
| 12 | Click **New chat**, then "Good morning" again | The dashboard loads again; the panel shows a fresh `resources/read` for the new session. |
| 13 | Say "Good morning" twice in one session | Two dashboards in the conversation, and only one `resources/read` (the view is cached per session). |

### Things to watch for

- Any red errors in the browser console (F12).
- Dashboard height jumping or flickering when you tap buttons.
- Dark theme readability on the device frame (the view takes the host's dark theme).
- In AWS mode: does Nova still speak a sensible summary when the dashboard is on screen?

### Still untested from the last round

- **Push-to-talk with a real microphone** in Chrome (the round button left of the text box).
- **One full demo with the Polly voice** (`npm run sim:demo`), following the script in the README.
- **CI on GitHub** for `feature/simulator`: the `orchestrator` and `web` jobs haven't run there yet.

---

## What you need to do

1. **Open the simulator pull request**: https://github.com/im-Amrith/CareCircle/pull/new/feature/simulator, using `PR-simulator.md` (local, not committed) as the description. Or install the GitHub CLI (`winget install GitHub.cli`, then `gh auth login`) and I can open PRs for you.
2. **Run through "What to test"** above, and tell me anything that looks off.
3. **Push `feature/mcp-apps`** (`git push -u origin feature/mcp-apps`) and open its PR **after** the simulator PR, since it builds on that branch. Then `feature/family-live` after that. I can write the PR descriptions.
4. **Optional: email summaries.** Create an SNS topic, subscribe your email, and set `SNS_TOPIC_ARN` (commands in the README's "Evening summary"). This creates an AWS resource, so I haven't done it.
5. **Review the server design change (FL-10)** in the simulator PR and merge it if you're happy with it.
6. **Decide on device names.** The UI says "Show 8 / Show 15 / Dot / Phone" to stay clear of Amazon trademarks; it's a one-line change if you want the full Echo names.
7. **Tidy local files:** `msg.json` (your Bedrock test message) and `PR-simulator.md` are untracked. Delete them or keep them out of commits.
8. **Record the demo video** in **Family view** with the protocol panel open: Mark taken on Rose's display updating Sam's phone, the fall alert, Hindi, then Reorder into the confirmation.

---

## Upcoming features

### Next up (product)

1. **AWS deployment** (below), so judges get a public URL.
2. **The safety story as a demo scene:** Nova trying to say yes for Rose (FL-10) and the server stopping it, shown in the protocol panel.
3. **Screenshots** of the Family view, the Hindi dashboard and the alert for the README.
4. **More views:** a supply and orders view for `check_refills`, and a weekly adherence view for Sam.
5. **Hindi for the rest:** the refill confirmation and checkout page are still English.
6. **Appointment coordination** using MCP Tasks, and **Strands care-team agents**.

### AWS deployment (nothing deployed yet)

- MCP server on AgentCore Runtime (port 8000 is already AgentCore's default).
- Replace dev auth (`Bearer dev:<name>`) with Cognito JWTs.
- Replace the in-memory store with DynamoDB (the store interface is ready for it).
- Set `PUBLIC_URL` so checkout links point at the deployed host.
- The evening summary scheduler runs inside the server; on AgentCore it could move to EventBridge Scheduler calling the same code.

### Not verified

- **Launcher on macOS / Linux.** Only run on Windows; CI covers tests on Linux, not `npm run sim`.
- **`uv` path in `npm run setup`.** Only the `python -m venv` path has been run.
- **Python 3.11 and 3.13.** Only 3.12 has been used.
- **The dashboard in browsers other than Chrome** (Edge, Firefox, Safari).
- **The dashboard in a real Alexa+ client.** No public test harness exists yet (see the friction log's feature requests).

### Known limitations

- **Demo data lives in memory.** Restarting the server resets the family; "New chat" resets only one person's conversation.
- **Every session starts with a failed `server/discover` request** (MCP Python SDK 2.1.1 version probe, FL-09). The protocol panel labels it.
- **Bedrock wording varies from run to run.** The tool results, cards and dashboard don't.
- **Unanswered confirmations time out** after 10 minutes and count as "cancel".
- **The checkout is a demo:** no payment is taken and no real order is sent.
- **Hindi covers the main replies, not everything:** refill confirmations, the checkout page and error messages are English.
- **Reminders need the device open:** the simulator only reminds a device that has a browser listening, and once per dose slot per orchestrator run.
- **The evening scheduler checks once a minute** and sends at most one summary per family per day; with the demo clock frozen at 9 am it never fires, so use "Send everyone today's summary".
- **The sandbox only accepts the simulator's own address** (`127.0.0.1:5173` and `localhost:5173`). Set `WEB_ORIGINS` if you serve the web app elsewhere.

---

## Quick reference

```powershell
cd "D:\comp\0.Hackathon\AWS-alexa+"
git checkout feature/family-live   # newest; feature/mcp-apps or feature/simulator for earlier stages
npm run setup          # once
npm run sim:demo       # MCP server :8000, orchestrator :8100, web :5173 (clock frozen at 9 am IST)
npm run sim:mock       # same, with no AWS calls
npm test               # server tests, orchestrator tests, web build
```

Open http://127.0.0.1:5173. Ctrl+C stops all three processes.
