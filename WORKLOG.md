# Work log

## 2026-10-21: simulator UI redesign (branch `feature/ui-redesign`)

Brief: `docs/prompts/03-ui-redesign.md`. Visual and interaction changes only. `api.ts`, the orchestrator and the MCP server are unchanged. All tests pass: 70 server, 21 orchestrator, web typecheck and build.

### What was built

**Identity**
- Sand page in light mode and plum-navy in dark, following the OS setting, with CSS variables in `styles.css`. Coral is the one accent. Green, amber and red only mean taken, due and missed or alert. Cyan only lights the device ring and the mic while listening or speaking.
- Fraunces for headings, Atkinson Hyperlegible for body text (Google Fonts, with system fallbacks). Icons from `lucide-react`, the only new dependency.
- Slim top bar: CareCircle, status pills (MCP connected, Mock mode or the Bedrock model, voice) and a quiet "Simulated Alexa+ experience" label.

**Devices** (`DeviceView.tsx`, pure CSS)
- Show 8: fabric bezel on a wedge stand with a top light bar. Show 15: thin bezel, wall-mounted. Dot: seen from above with a mesh top and a ring that pulses cyan (listening), sweeps (speaking) or glows amber (alert), with a live caption. Phone: notch and chat bubbles.
- Screen strip with the frozen demo clock (from the live `today` state's `updatedAt`), the person's avatar and "Rose's CareCircle".
- Idle home screen (`HomeScreen.tsx`): greeting, big clock, date, doses due or next dose, Maya's visit, and a ring of today's doses.
- Conversation: the newest reply is large, with its card below, and earlier turns fade upward. Auto-scroll pins the start of the newest reply, or an open question's buttons, and re-pins when content resizes, until the person scrolls. This fixes the clipped reply in the old screenshot.
- Show devices use native cards. The phone keeps MCP App views.

**Controls** (`Controls.tsx`)
- One bar per device: a big push-to-talk mic with animated states, the text box, and a "…" menu (device, language, slower speech, large text, sound, remind now, inbox, new chat).
- Avatar profile switcher (Rose · Mom, Sam · Son, Maya · Daughter) with a 1.3 s "Switching to Sam's device" overlay.
- Suggestion chips only while the input is empty. They lead with what follows from the last reply, for example "Reorder it" after a low-supply answer.

**Cards** (`cards/Cards.tsx`, `ElicitationCard.tsx`)
- Care status: a dose timeline by slot (morning, noon, evening, night) with taken, due, missed and later marks. Supplies: gauges of days left. Orders: a stepper (requested, checkout, placed, arriving). Safety: a calm red-bordered alert.
- Confirmations look like a device dialog: the question in large type, big Accept and Decline, and Cancel as a text button. Answered questions fold to one line.

**Under the hood** (`ProtocolPanel.tsx`)
- Messages grouped per turn ("Sam said …", tools called, response time), coloured by kind, with JSON on click.
- The `server/discover` probe is a neutral info row. A turn with no MCP calls (the safe refusal) is listed as such. Folded by default below 1100 px.

### How it was checked
- A Playwright script (system Edge) ran all 7 README demo lines in `npm run sim:mock`, including the form elicitation, the secure checkout page and `notifications/elicitation/complete`.
- On every turn it checked that the newest reply isn't cut off and the page doesn't scroll sideways, at 1280×800, 1440×900 and 1920×1080, and in dark mode.
- New screenshots in `docs/screenshots/`: home (light and dark), care status, reorder form, checkout page and complete, Dot, phone, safety and the protocol panel.

### Not done
- `npm run sim:demo` (Bedrock and Polly) was not run with the new UI.
- The care dashboard MCP App view on the phone is the server's HTML and is cramped at phone width.
- The protocol chip shows "Sam's session", not a session id, because the orchestrator doesn't pass the id to the browser.

### Next
Run `sim:demo` with AWS on this UI, record the demo video, then `docs/prompts/04-appointments-and-skill.md`.

## 2026-10-15: family features (branch `feature/family-live`)

Built on top of `feature/mcp-apps`. All tests pass: 70 server, 21 orchestrator, web typecheck and build.

### What was built

**Live updates across family devices**
- Server: `store/changes.ts` wraps the store so every write (dose, supply, note, order, language, message) is announced on a family-wide change feed.
- Server: `mcp/live.ts` adds two subscribable resources, `carecircle://family/{id}/today` and `.../inbox`. Sessions `resources/subscribe` and get `notifications/resources/updated` within about 120 ms of a change, one per burst.
- Server: `mcp/status.ts` holds the shared status logic for `get_care_status` and the `today` snapshot. The snapshot includes today's safety alerts and, for the person cared for, a reminder about overdue doses.
- Orchestrator: subscribes on connect, re-reads a resource when told it changed, and streams `today`, `inbox` and `announcement` events to the browser over `GET /events`.
- Web: a **Family view** with two devices side by side, each with its own conversation, input and settings. Open dashboards refresh when someone else changes something. Safety alerts light the other devices yellow and are spoken once.

**Hindi**
- Server: per-member language (`set_language` tool). Rose's main replies are phrased in Hindi (`domain/hindi.ts`), with medicine names unchanged. Hindi and Hinglish red-flag words are detected.
- Orchestrator: the mock router understands Hindi and Hinglish, and turns symptoms into an English note with the original words kept. Nova's system prompt follows the person's language. Polly speaks `hi-IN` with Kajal.
- Dashboard: labels follow the MCP Apps host locale.

**Accessibility**
- "Say that again" repeats the last reply slower with no tool call.
- Per-person **Slower speech** (Polly SSML prosody, or browser rate) and **Large text** (the dashboard scales through MCP Apps host styles). Both are on by default for Rose.
- Gentle reminders: the server works out overdue doses; the device says them after 45 quiet seconds (`REMINDER_IDLE_S`) or on **Remind now**. "Yes" logs them.

**Evening summary**
- Server: `notify/digest.ts` composes the summary; `notify/notifier.ts` delivers it to the family inbox, and to Amazon SNS when `SNS_TOPIC_ARN` is set. There's a `send_daily_summary` tool and an 8:30 pm scheduler (`DIGEST_TIME`). If SNS fails, the inbox copy stays.
- Web: new summaries pop up as a message on Sam's and Maya's devices.

### Fixes along the way
- The dashboard showed a stray "null" when there was no toast.
- The dashboard view cache now resets with each new session.
- The protocol panel could skip an app view's own tool calls (from the previous session's work).

### How it was checked
- Server and orchestrator tests for subscriptions, alerts, reminders, Hindi, repeat, the summary, the scheduler and SNS failure.
- Headless Chrome run of the whole Family view demo, with no browser errors.
- AWS mode: Nova chose `set_language`, replied in Hindi, and Polly spoke Hindi (normal and slow).

### Friction log
- FL-12: Strands' `MCPClient` has no resource subscriptions, and the MCP Python SDK warns that `resources/subscribe` is removed in 2026-07-28 even on 2025-11-25 sessions.

### Not done
- No SNS topic was created (that creates an AWS resource). The README has the commands.
- Refill confirmations, the checkout page and error messages are still English only.
- Not pushed. Push order: `feature/simulator`, then `feature/mcp-apps`, then `feature/family-live`.

### Next
AWS deployment (AgentCore Runtime, Cognito, DynamoDB), then the safety scene for the demo video (FL-10).
