# Work log

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
