# CareCircle: progress and next steps

_Last updated: 2026-10-13_

A quick record of what's built, what you need to do next, and what's still open.

## At a glance

| | |
| --- | --- |
| Repo | https://github.com/im-Amrith/CareCircle |
| `main` | MCP server and refill ordering (PR #1, merged) |
| `feature/simulator` | Alexa+ web simulator: **pushed, PR not opened yet** |
| Tests | 57 server, 10 orchestrator (pytest), web typecheck and build: all passing locally |
| AWS | Bedrock (Nova 2 Lite) and Polly (Kajal) working from your laptop in ap-southeast-2. No AWS resources created. |

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
- Fixes after manual testing:
  - The checkout post was rejected with `Origin: null` (caused by the referrer policy).
  - Inspector warnings about array-valued `type` in the schema.

### 3. Alexa+ web simulator (branch `feature/simulator`, 7 commits)

- **Orchestrator** (`alexa-sim/orchestrator`, Python 3.12 + FastAPI):
  - One MCP session per family member, sent as `Authorization: Bearer dev:<name>`. It advertises both form and URL elicitation.
  - Every JSON-RPC message is captured at the transport layer and streamed to the browser.
  - AWS mode: a Strands agent on Bedrock `global.amazon.nova-2-lite-v1:0`, with Polly neural voice Kajal.
  - Mock mode (`MOCK_AWS=1`, or no AWS credentials): a keyword router and browser speech. No AWS account needed.
  - Fallback: if Bedrock fails, the turn uses the offline router and shows "AWS Bedrock failed, so this turn used the offline router." If Polly fails, the browser speaks instead.
  - A fixed safe refusal for dosing questions.
- **Web app** (`alexa-sim/web`, React + Vite):
  - Show 8, Show 15, Dot and Phone device frames, and a Rose / Sam / Maya switcher.
  - Push-to-talk and a text box.
  - Cards for status, medicines, refills, orders, dose logs and wellbeing (safety alerts in red).
  - The confirmation form and secure page appear inside the conversation.
  - A live MCP protocol panel.
- **One command:** `npm run setup`, then `npm run sim:demo`, `npm run sim` or `npm run sim:mock`.
- **Server fixes found while testing with Nova:**
  - `request_refill` now always asks through the form when the client supports it, so the model can't supply the yes (Nova had sent `confirm: true` on its own).
  - "She mentioned: i had a fall" is now "I had a fall".
- **CI:** now also runs the orchestrator tests (mock mode) and the web build.
- **Docs:**
  - README "Run the simulator" section with the demo script.
  - 6 screenshots in `docs/screenshots/`.
  - Friction log FL-09 (Strands pins `mcp<2.2`) and FL-10 (Nova supplied `confirm: true` for a purchase).
- **Checked:** all 7 demo lines ran in a headless browser in both mock and AWS mode, with no browser errors.

---

## What you need to do

1. **Open the simulator pull request.**
   - Go to https://github.com/im-Amrith/CareCircle/pull/new/feature/simulator
   - Paste the contents of `PR-simulator.md` (in the repo folder, not committed) as the description.
   - Or install the GitHub CLI (`winget install GitHub.cli`, then `gh auth login`) and I can open PRs for you next time.
2. **Check CI** on the Actions tab for `feature/simulator`. The two new jobs (`orchestrator`, `web`) haven't run on GitHub yet.
3. **Try push-to-talk with a real microphone** in Chrome: the round button left of the text box. It's only been tested in code so far.
4. **Do one manual pass of the demo** with `npm run sim:demo` and listen to the Polly voice. The demo script is in the README.
5. **Review the server design change (FL-10)** and merge the PR if you're happy with it.
6. **Decide on device names.** The UI says "Show 8 / Show 15 / Dot / Phone" to stay clear of Amazon trademarks. The brief named the full Echo products; it's a one-line change if you want those.
7. **Tidy two local files that aren't part of any commit:**
   - `msg.json`: your Bedrock test message. Delete it or keep it out of commits.
   - `server/package-lock.json`: npm metadata churn. Revert with `git checkout -- server/package-lock.json`.
8. **Record the demo video** in the simulator (Show 8 or Show 15 frame, protocol panel open).

---

## Left undone / next tasks

### Product

- **MCP Apps UI:** built on `feature/mcp-apps`, not committed yet. `get_care_status` links to a `ui://carecircle/care-dashboard` view with Mark taken buttons. The simulator renders it through a sandbox proxy on the orchestrator's origin. Views can call only `get_care_status` and `log_medication`; Reorder goes back through the conversation and its confirmation. Checked in headless Chrome. The Strands workaround for declaring the extension is FL-11.
- **Appointment coordination** using MCP Tasks.
- **Strands care-team agents.**

### AWS deployment (nothing deployed yet)

- MCP server on AgentCore Runtime (port 8000 is already AgentCore's default).
- Replace dev auth (`Bearer dev:<name>`) with Cognito JWTs.
- Replace the in-memory store with DynamoDB (the store interface is ready for it).
- Set `PUBLIC_URL` so checkout links point at the deployed host.

### Not verified

- **Launcher on macOS / Linux.** It's written to work there but has only been run on Windows. CI covers the tests on Linux, not `npm run sim`.
- **`uv` path in `npm run setup`.** uv isn't installed on your machine, so only the `python -m venv` path has been run.
- **Python 3.11 and 3.13.** Only 3.12 has been used.

### Known limitations

- **Demo data lives in memory.** Restarting the server resets the family; "New chat" resets only one person's conversation.
- **Every session starts with a failed `server/discover` request.** The MCP Python SDK 2.1.1 tries a newer protocol first, then falls back to `initialize`. The protocol panel labels it. A server-side tweak could answer it more gracefully (FL-09).
- **Bedrock wording varies from run to run.** The tool results and cards don't; the README demo lines are checked by meaning, not exact words.
- **Unanswered confirmations time out** after 10 minutes and are treated as "cancel".
- **The checkout is a demo:** no payment is taken and no real order is sent.

---

## Quick reference

```powershell
cd "D:\comp\0.Hackathon\AWS-alexa+"
git checkout feature/simulator
npm run setup          # once
npm run sim:demo       # MCP server :8000, orchestrator :8100, web :5173 (clock frozen at 9 am IST)
npm run sim:mock       # same, with no AWS calls
npm test               # server tests, orchestrator tests, web build
```

Open http://127.0.0.1:5173. Ctrl+C stops all three processes.
