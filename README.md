# CareCircle

**A family care coordinator for Alexa+.** CareCircle lets an older parent log medicines and how they feel by voice, and gives the rest of the family a one-sentence answer to "How is Mom today?".

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/): **Alexa+ track** (self-hosted MCP server, spec 2025-11-25, Streamable HTTP) and the **AWS Builder** mini challenge.

> CareCircle coordinates care. It never gives medical advice, changes doses or diagnoses. All data in this repo is synthetic.

## Status

| Part | State |
| --- | --- |
| MCP server (`server/`): 6 tools, 2 resource templates, 2 prompts, stateful Streamable HTTP | Working, 54 tests |
| Refill ordering: voice confirmation, form and URL elicitation, secure checkout page | Working |
| Appointment coordination (Tasks), MCP Apps UI | Next |
| Alexa+ web simulator | Next |
| AWS: Bedrock (Nova), AgentCore, Strands care-team agents | After AWS account verification |

## Quick start (no AWS needed)

Requires Node.js 20 or later.

```bash
cd server
npm install
npm run dev
```

The server listens on `http://127.0.0.1:8000/mcp`.

**Try it with MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector
```

Open the URL it prints, choose **Streamable HTTP**, enter `http://127.0.0.1:8000/mcp` and click **Connect**. Under **Tools**, run `get_care_status`.

**Switch family member** by adding a header in Inspector's Authentication section: `Authorization: Bearer dev:rose` (or `dev:sam`, `dev:maya`). With no header you are Sam.

**Freeze the clock** for a repeatable demo, e.g. 9 am in India:

```bash
CARECIRCLE_NOW=2026-10-10T03:30:00Z npm run dev          # macOS / Linux
$env:CARECIRCLE_NOW="2026-10-10T03:30:00Z"; npm run dev  # Windows PowerShell
```

**Run the tests:**

```bash
npm test
```

## What the server exposes

### Tools

| Tool | Say something like | Notes |
| --- | --- | --- |
| `get_care_status` | "How is Mom today?", "Good morning" | Read-only. Doses taken, due and missed, next dose, visits, latest wellbeing note, low supplies |
| `list_medications` | "What do I take tonight?" | Read-only. Optional `when`: morning, noon, evening, night |
| `log_medication` | "I took my morning pills", "I took the blood pressure one" | Idempotent: repeating a call never double-logs. Ambiguous names return options to ask about |
| `check_refills` | "Am I running low on anything?" | Read-only. Days of supply left, when each runs out, and any refill already on its way |
| `request_refill` | "Reorder my blood pressure tablets", "Yes" after a low-supply warning | Asks first, then opens a one-time checkout link. Nothing is ordered until checkout is completed. Asking twice never orders twice |
| `log_wellbeing` | "I slept badly", "I had a fall" | Red-flag words (falls, chest pain, breathing trouble) return safety guidance |

Every tool returns three things:

- `structuredContent`, matching the tool's declared `outputSchema`, for reasoning and on-screen cards.
- A short spoken sentence in `content`, written for screenless Echo devices: no Markdown, tables or URLs.
- Annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`).

### Refill ordering

The order needs two separate yeses: a spoken one, then one on a checkout page.

1. **"Reorder?"** `request_refill` never orders without asking. If the client supports form elicitation, it always asks there (reorder yes/no, delivery or pickup), even if the model already sent `confirm: true`, so the yes comes from the person and not the model. Otherwise it returns `needs_confirmation` with a question for Alexa to speak ("Amlodipine has about three days left. Should I reorder Amlodipine 5 mg, 30 tablets, from Riverside Pharmacy for delivery?"). Alexa calls it again with `confirm: true` only after a clear yes.
2. **Checkout link.** The order is created as `awaiting_checkout` with a one-time link at `/checkout/<token>`. If the client supports URL-mode elicitation, the link goes straight to the browser, so it never passes through the model. It also always appears in `structuredContent.checkoutUrl` for an on-screen card. It is never spoken.
3. **Secure checkout page.** The page shows the medicine, quantity, pharmacy and delivery or pickup, with **Place order** and **Cancel** buttons. When it is completed, a `notifications/elicitation/complete` goes back to the session that asked. From then on, `get_care_status` and `check_refills` say "A refill arrives tomorrow."

How the checkout is secured:

- Tokens are 256 random bits, single-use and valid for 15 minutes. Only a SHA-256 hash is stored.
- Placing an order is a compare-and-set from `awaiting_checkout`. A double submit, or a submit racing a cancel, places at most one order.
- Form posts must come from the page's own origin (`403` otherwise), on top of the app-wide Host and Origin checks.
- Responses are sent with `Cache-Control: no-store`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` and a CSP that allows no scripts.
- No card or payment details are ever collected: payment is settled with the pharmacy. In this demo no real order leaves the server.
- Only the recipient and coordinators can start a refill; helpers get a spoken refusal.

### Resources and prompts

- `carecircle://family/{familyId}/care-plan`: the care plan as Markdown
- `carecircle://family/{familyId}/log/{date}`: one day's doses, notes and visits as JSON
- Prompts: `morning_briefing`, `caregiver_handoff`

Resources are scoped to the caller's own family; any other family id reads as "not found".

### Transport (MCP 2025-11-25 Streamable HTTP)

- One `/mcp` endpoint: `POST` for client messages, `GET` for the server-to-client SSE stream, `DELETE` to end a session.
- Stateful sessions with a random `MCP-Session-Id`, bound to the user who opened them. Unknown sessions get `404`, missing ones `400`, another user's `403`.
- `MCP-Protocol-Version` is checked on every request (`400` if unsupported). Negotiates `2025-11-25`; also accepts `2025-06-18` and `2025-03-26`.
- `Origin` and `Host` validation against DNS rebinding (`403`). Binds to `127.0.0.1` by default.
- SSE events carry ids, and an in-memory event store lets dropped streams resume with `Last-Event-ID`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port (AgentCore Runtime expects 8000) |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in a container, with `ALLOWED_HOSTS` |
| `ALLOWED_HOSTS` | localhost names | Comma-separated Host header allow-list |
| `ALLOWED_ORIGINS` | localhost names | Comma-separated Origin allow-list for browser clients |
| `CARECIRCLE_DEFAULT_USER` | `sam` | Who you are when no `Authorization` header is sent |
| `CARECIRCLE_NOW` | real time | Freeze the clock (ISO 8601) |
| `CARECIRCLE_SEED` | `seed/rose.json` | Seed family file |
| `PUBLIC_URL` | the request's origin | Base URL for checkout links when running behind a proxy or on AWS |

Dev auth (`Bearer dev:<userId>`) is for local use only. The AWS deployment replaces it with Cognito JWTs validated by AgentCore Runtime.

## Repository layout

```text
server/                 MCP server (TypeScript, MCP SDK v2)
  src/domain/           Pure care logic: dose status, refills and refill orders, name matching, safety words
  src/store/            Storage interface, in-memory store, seed loader
  src/mcp/              Tools, resources, prompts, server factory
  src/http/             Streamable HTTP app, dev auth, event store, refill checkout page
  test/                 Unit, MCP and transport conformance tests
seed/rose.json          Synthetic demo family (dates relative to today)
mcp.config.json         Client config pointing at the local server
docs/friction-log.md    Developer friction log for the hackathon
```

## License

[MIT](LICENSE)
