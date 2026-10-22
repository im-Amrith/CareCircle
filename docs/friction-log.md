# CareCircle friction log

Running log of developer-experience friction hit while building CareCircle for the
**Build, Ship, Shape: Amazon Developer Hackathon** (Alexa+ track + AWS Builder mini challenge).

Each entry follows the format the hackathon asks for: task, steps, expected vs. actual,
severity, workaround and an actionable suggestion. Entries are written when the friction
happens, not reconstructed at the end.

**Severity scale**

| Severity | Meaning |
| --- | --- |
| Blocker | Could not continue without a workaround or outside help |
| Major | Lost an hour or more, or had to change the design |
| Minor | Confusing or slow, but resolved quickly |

---

## FL-01: Alexa+ add-on tools linked from public docs are partner-only

- **Date:** 2026-10-05
- **Area:** Alexa+ developer documentation
- **Task attempted:** Set up the Alexa+ MCP Toolkit (Alexa AI CLI, Web Simulator) to test an MCP add-on.
- **Steps taken:** Opened the hackathon Resources page, then the Alexa+ MCP Toolkit overview and the
  "Build Alexa+ Add-ons: Development Stages" page, which describe `alexa-ai deploy`, the Agent Skill
  onboarding flow and the Web Simulator.
- **Expected:** A path to install the CLI and test an add-on, since the track is about Alexa+.
- **Actual:** The hackathon FAQ says the Category SDK, MCP Toolkit, CLI and Web Simulator are in
  preview for select partners only, with no way for participants to get access. Individual setup
  pages do not say this, so it is easy to lose time trying.
- **Severity:** Major
- **Workaround:** Build a standards-compliant MCP server (spec 2025-11-25, Streamable HTTP) plus our
  own web-based Alexa+ simulator that acts as the MCP client.
- **Suggestion:** Add a visible "Partner preview: not available to the public" banner to every
  Alexa+ add-on setup page, or publish a public test harness (even a hosted simulator with limited
  quotas) so outside developers can validate their server against the real Alexa+ client.

## FL-02: Protocol version in Alexa+ client example doesn't match the supported spec

- **Date:** 2026-10-05
- **Area:** Alexa+ MCP client lifecycle docs
- **Task attempted:** Decide which MCP protocol versions the server must negotiate.
- **Steps taken:** Read the MCP Toolkit overview (states Alexa+ supports MCP 2025-11-25), then the
  "Alexa+ MCP Client and App Lifecycle" page with sample `initialize` payloads.
- **Expected:** Sample payloads using `protocolVersion: "2025-11-25"`.
- **Actual:** The sample `initialize` request and response both use `"2025-03-26"`. Unclear which
  version the real Alexa+ client sends.
- **Severity:** Minor
- **Workaround:** Server negotiates 2025-11-25 and also accepts 2025-06-18 and 2025-03-26.
- **Suggestion:** Update the sample payloads to 2025-11-25, and state explicitly which versions the
  Alexa+ client sends and accepts.

## FL-03: AgentCore Runtime MCP hosting guide is Python-only

- **Date:** 2026-10-05
- **Area:** Amazon Bedrock AgentCore docs
- **Task attempted:** Plan deployment of a TypeScript MCP server (needed for first-class MCP Apps
  helpers from `@modelcontextprotocol/ext-apps`) to AgentCore Runtime.
- **Steps taken:** Read "Deploy MCP servers in AgentCore Runtime".
- **Expected:** Examples for both Python and TypeScript MCP servers.
- **Actual:** The guide uses FastMCP (Python) throughout; the TypeScript path and its stateful-mode
  equivalent of `stateless_http=False` are not shown.
- **Severity:** Minor (planning stage; will update after the deploy)
- **Workaround:** _TBD after deploy._
- **Suggestion:** Add a TypeScript tab to the MCP hosting guide, including stateful session handling
  for elicitation and progress notifications.

## FL-04: AWS credits require a project description before you can plan

- **Date:** 2026-10-06
- **Area:** Hackathon AWS credits process
- **Task attempted:** Request the $150 AWS Promotional Credits.
- **Steps taken:** Opened the credit request form from the Resources page.
- **Expected:** Credits available on registration.
- **Actual:** The form asks for a 2–3 sentence project description naming the track before credits
  are issued, so you have to commit to an idea before you can experiment with paid services.
  Credits received by 2026-10-10.
- **Severity:** Minor
- **Workaround:** Submitted a short description; the form says the idea can change later.
- **Suggestion:** Issue credits on registration, or allow a placeholder description.

## FL-05: Unclear whether hackathon credits cover Claude models on Bedrock

- **Date:** 2026-10-10
- **Area:** Amazon Bedrock billing / AWS credits
- **Task attempted:** Choose a Bedrock model for the simulator and care-team agents that the $150
  credit will pay for.
- **Steps taken:** Opened the Bedrock console, the Bedrock pricing page and the model access docs.
- **Expected:** A clear statement of which models the hackathon credits cover.
- **Actual:** Third-party models (e.g. Anthropic Claude) are subscribed through AWS Marketplace on
  first use, and AWS re:Post answers say promotional credits generally apply only to AWS services,
  not Marketplace charges. Nothing in the hackathon resources says which models are covered. The
  Anthropic first-time-use form is also an extra step not mentioned in the hackathon resources.
- **Severity:** Major (risk of unexpected charges to the card on file)
- **Workaround:** Use Amazon Nova models for development and the demo; check Billing → Credits after
  the first day of usage. Claude only if it is confirmed covered.
- **Suggestion:** State in the hackathon resources which Bedrock models the credits cover, and
  recommend a default model for participants.

## FL-06: Bedrock console still points developers to "model access" that no longer works the same way

- **Date:** 2026-10-10
- **Area:** Amazon Bedrock console onboarding
- **Task attempted:** Request model access, following older guides and tutorials.
- **Steps taken:** Opened the Bedrock console home; found "Get started by using API Keys", Model
  catalog, and Labs (Quotas, Compare models), but no model-access request step.
- **Expected:** A "Request model access" step, as many tutorials describe.
- **Actual:** Serverless models are now enabled automatically on first invocation (subscription can
  take up to 15 minutes, during which calls may return `AccessDeniedException`). The console home
  promotes API keys first, which is not the recommended path for SDK-based apps that can use IAM
  credentials.
- **Severity:** Minor
- **Workaround:** Test the model once in the playground to trigger enablement; use IAM credentials
  (AWS CLI profile / SSO) for boto3 and Strands instead of a long-term API key.
- **Suggestion:** Add a "First call may take up to 15 minutes" notice in the playground, and explain
  on the console home when to use API keys vs. IAM credentials.

## FL-07: Nova Lite returns "ValidationException: Operation not allowed" in the playground

- **Date:** 2026-10-10
- **Area:** Amazon Bedrock playground / account enablement
- **Task attempted:** First call to Amazon Nova Lite in the Bedrock playground (Chat mode) to confirm
  model access before writing any code.
- **Steps taken:** Bedrock console → Test → Playground → Mode: Chat → model Nova Lite → prompt
  "hello" → Run.
- **Expected:** A reply from Nova Lite, since serverless models are documented as enabled by default
  on first use.
- **Actual:** Red banner `ValidationException: Operation not allowed`. No hint about the cause or
  the fix. "ValidationException" suggests a bad request, but the prompt was a single word. AWS
  re:Post threads with the same error point to an account-level restriction that only AWS Support
  can lift.
- **Severity:** Blocker for two days (no model calls possible until resolved)
- **Root cause (found later):** AWS CloudShell in ap-southeast-2 showed "Unable to create the
  environment. Your account verification is in progress. This may take up to two days for new
  accounts." Bedrock gave no such hint; every Amazon Nova model (Lite, Pro, Micro, 2 Lite) in the
  Sydney playground returned the same `ValidationException: Operation not allowed`.
- **Workaround:** Opened AWS Support case 179162884900471 (Account and billing; category "Account
  Activation, Bedrock Allowlisting") on 2026-10-10 at 10:40 UTC. Waiting for verification (up to 48
  hours). Development continued locally in mock mode with no AWS calls.
- **Resolved:** 2026-10-12, about 48 hours after account creation. Amazon Nova 2 Lite now answers
  in the Sydney (ap-southeast-2) playground (97 input / 344 output tokens, 2.3 s latency on the
  first call). No change was needed on our side; verification completing was the fix. The
  `ValidationException` cost roughly half a day of debugging before CloudShell revealed the cause.
- **Related friction:** The console top bar showed only the account name ("Lift Off Soon"), with
  no visible Region selector, so it was unclear which Region the playground was using.
- **Suggestion:** Bedrock should say what CloudShell says: return an `AccessDeniedException` with
  "account verification in progress, up to 48 hours" instead of a generic `ValidationException`, and
  show it as a banner on the Bedrock console home. For the hackathon, warn participants to create
  their AWS account early because new-account verification can block Bedrock for up to two days.

## FL-08: Project account is locked to Sydney; us-east-1 and Anthropic models blocked by SCP

- **Date:** 2026-10-10
- **Area:** AWS account setup (project accounts) / Amazon Bedrock
- **Task attempted:** Retry Nova Lite in the Bedrock playground in US East (N. Virginia) us-east-1,
  the Region most tutorials and the hackathon samples assume.
- **Steps taken:** Opened `https://us-east-1.console.aws.amazon.com/bedrock/home?region=us-east-1`
  and the playground.
- **Expected:** Playground loads in us-east-1.
- **Actual:** Dialog "Region United States (N. Virginia) unavailable. Your project is assigned to
  Asia Pacific (Sydney) ap-southeast-2. To access other commercial AWS Regions, activate advanced
  features." A banner also showed `AccountFullAccessRole ... is not authorized to perform:
  bedrock:GetUseCaseForModelAccess with an explicit deny in a service control policy`. The account
  is a simplified "project" account, assigned to ap-southeast-2 because the contact address is in
  India; the Region selector is hidden, which explains why it could not be found (see FL-07). The
  SCP blocks the Anthropic first-time-use form, so Claude models cannot be enabled at all.
- **Severity:** Major
- **Workaround:** Build everything in ap-southeast-2 and use Amazon Nova models. Did not activate
  advanced features until it's clear whether that changes billing or the hackathon credits.
- **Suggestion:** Tell hackathon participants that new sign-ups may get a Region-locked project
  account (Sydney for India) and list which Bedrock models and AgentCore features work there. Show
  the assigned Region in the console top bar instead of hiding the Region selector, and explain the
  SCP denial in plain words with the fix.

## FL-09: Strands Agents pins the MCP Python SDK below the current release

- **Date:** 2026-10-12
- **Area:** Strands Agents (`strands-agents` on PyPI)
- **Task attempted:** Build the simulator orchestrator as an MCP client with the latest MCP Python SDK
  and give its tools to a Strands agent on Bedrock.
- **Steps taken:** `pip install strands-agents mcp boto3` on Python 3.12 (Windows 11).
  PyPI listed `strands-agents` 1.59.0 and `mcp` 2.3.0.
- **Expected:** The latest `mcp` (2.3.0) installed alongside Strands.
- **Actual:** pip resolved `mcp` 2.1.1, because `strands-agents` 1.59.0 requires `mcp<2.2,>=1.23.0`.
  Nothing warns about this: you only notice by comparing `pip list` against PyPI. The 2.1.1 client
  also opens every session with a `server/discover` request for protocol revision 2026-07-28,
  before `initialize`. A server that speaks only 2025-11-25 answers it with HTTP 400, and the
  client then falls back to `initialize`. It works, but the failed probe shows up in our protocol
  log on every connect.
- **Severity:** Minor
- **Workaround:** Accept `mcp` 2.1.1 (form and URL elicitation both work through
  `MCPClient(elicitation_callback=...)`), and label the probe in the simulator's protocol panel as a
  version probe that falls back to `initialize`.
- **Suggestion:** Note the supported `mcp` range in the Strands MCP docs and release notes, and
  widen the upper bound soon after each MCP SDK minor release. Add an option to skip the
  `server/discover` probe, or document it, when the target server is known to speak 2025-11-25.

## FL-10: Nova 2 Lite treated "Reorder it" as consent and skipped the server's confirmation

- **Date:** 2026-10-12
- **Area:** Amazon Bedrock (Amazon Nova 2 Lite, `global.amazon.nova-2-lite-v1:0`, ap-southeast-2)
  with Strands Agents 1.59.0 tool use
- **Task attempted:** Demo line "Is she running low on anything?" then "Reorder it" in the
  simulator. The `request_refill` tool takes `confirm: true` only after a spoken yes; the tool
  description and the system prompt both say so.
- **Steps taken:** Ran the turn through a Strands agent on Nova 2 Lite and watched the JSON-RPC log.
- **Expected:** The model calls `request_refill` without `confirm`, so the server asks the person to
  confirm (form elicitation).
- **Actual:** The model's first call was
  `request_refill {"spoken_name": "Amlodipine 5 mg", "confirm": true}`. It read "Reorder it" as the
  yes to its own earlier "Would you like me to reorder it?", so the server's confirmation form was
  skipped. The checkout page still guarded the order, but the server was trusting a yes that came
  from the model, not the person.
- **Severity:** Major (changed the server design)
- **Workaround:** The server no longer trusts `confirm` from clients that support elicitation: it
  always asks the person through a form, and `confirm` only applies to voice clients without
  elicitation. Added a server test for this case. Every model choice is still visible in the
  protocol panel.
- **Suggestion:** Add a "human confirmation for side-effecting tools" pattern to the Bedrock and
  Strands tool-use docs. Recommend that the tool server (via MCP elicitation) or a Strands
  interrupt, not a model-set boolean, should hold the yes for purchases and other irreversible
  actions, and show Nova's behaviour with a `confirm`-style parameter as the example.

## FL-11: Strands MCPClient can't declare MCP extensions such as MCP Apps

- **Date:** 2026-10-14
- **Area:** Strands Agents 1.59.0 (`strands.tools.mcp.MCPClient`) with MCP Python SDK 2.1.1
- **Task attempted:** Render the `get_care_status` dashboard (an MCP App, `ui://carecircle/care-dashboard`)
  in the simulator. A client has to declare `capabilities.extensions["io.modelcontextprotocol/ui"]`
  in `initialize` so the server knows it can show views.
- **Steps taken:** Looked for an option on `MCPClient` to add client capabilities, then read its source.
- **Expected:** A way to pass extensions through, since `mcp.ClientSession` 2.1.1 already accepts
  `extensions=`.
- **Actual:** `MCPClient` builds the `ClientSession` itself and passes only `message_handler`,
  `elicitation_callback`, `client_info` and task settings. There's no parameter or hook for
  `extensions`, so a Strands-based host can't say it supports MCP Apps.
- **Severity:** Minor
- **Workaround:** The simulator already wraps the transport's write stream to log JSON-RPC traffic,
  so it adds the extension to the outgoing `initialize` request there. Covered by an orchestrator
  test that checks the logged `initialize`.
- **Suggestion:** Add `client_session_kwargs` (or `extensions=`) to `MCPClient` and forward it to
  `ClientSession`, and document MCP Apps support for Strands hosts.

## FL-12: Strands MCPClient has no resource subscriptions, and the MCP SDK already deprecates them

- **Date:** 2026-10-15
- **Area:** Strands Agents 1.59.0 (`strands.tools.mcp.MCPClient`) with MCP Python SDK 2.1.1
- **Task attempted:** Keep every family member's device live: when Rose logs a dose, Sam's phone
  updates. The server supports `resources/subscribe` on a `today` resource and sends
  `notifications/resources/updated`.
- **Steps taken:** Looked for a subscribe method on `MCPClient`, then read its source and the
  `ClientSession` it wraps.
- **Expected:** `MCPClient.subscribe_resource_sync(uri)` next to `read_resource_sync`, and a way to
  receive `notifications/resources/updated`.
- **Actual:** `MCPClient` has list and read for resources but no subscribe, and it doesn't surface
  server notifications to the host. `ClientSession.subscribe_resource` exists, but calling it
  logs `MCPDeprecationWarning: resources/subscribe is removed as of 2026-07-28; use
  Client.listen() instead`, even on a session that negotiated 2025-11-25, where subscribe is the
  only option.
- **Severity:** Minor
- **Workaround:** The simulator calls the wrapped `ClientSession.subscribe_resource` on the
  client's own event loop, and watches the transport (which it already logs) for
  `notifications/resources/updated`. Covered by orchestrator tests.
- **Suggestion:** Add `subscribe_resource_sync` and a notification callback to `MCPClient`, or
  document how a Strands host should follow resource changes on both 2025-11-25 (subscribe) and
  2026-07-28 (`subscriptions/listen`). In the MCP SDK, only warn when the negotiated protocol
  version is one where subscribe is actually gone.

## FL-13: MCP TypeScript SDK 2.3.1 has the Tasks wire types but no Tasks runtime, and its client rejects task results

- **Date:** 2026-10-22
- **Area:** `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/client` 2.3.1, MCP
  2025-11-25 Tasks (experimental)
- **Task attempted:** Run `coordinate_appointment` as an MCP Task: return a task handle at once,
  move through `working`, `input_required` and `completed`, and support `tasks/get`,
  `tasks/result` and `tasks/cancel`.
- **Steps taken:** Read the type definitions before writing code, as the build brief asked, then
  ran a spike test against an in-memory server and client.
- **Expected:** A task store and a way to register a tool as task-capable, as earlier 1.x SDKs
  had in their experimental API.
- **Actual:** Three separate gaps:
  1. The server exports `CreateTaskResultSchema`, `GetTaskRequestSchema` and the rest, but the
     docs comment in the type definitions says the task methods are "2025-11-25 wire vocabulary
     with no SDK runtime". `RequestMethod` excludes `tasks/*`, so the typed
     `setRequestHandler('tasks/get', handler)` doesn't compile, and there is no task store.
  2. `McpServer.registerTool()` accepts no `execution` field. It passes `undefined` through to
     `_createRegisteredTool`, so `execution.taskSupport` can't be declared the normal way.
  3. `McpServer` validates every `tools/call` result as a `CallToolResult`. The 2.3.1 *client*
     rejects a `CreateTaskResult` even when you pass `CreateTaskResultSchema` to `request()`:
     `Invalid result for tools/call: content is required when the body carries 'task' — another
     result family cannot default into an empty tools/call success`.
- **Severity:** Major
- **Workaround:** `server/src/mcp/tasks.ts` (about 275 lines) implements the runtime: a task
  registry with owner checks, TTL and cancel. It registers `tasks/*` through the custom-schema
  form `setRequestHandler(method, { params }, handler)`, which the SDK allows for the Tasks
  extension names. Task-augmented `tools/call` requests are routed by wrapping McpServer's stored
  `tools/call` handler, which uses a private field. `execution` is set on the registered tool
  object after `registerTool()`. Server tests drive the task flow with raw JSON-RPC over
  `InMemoryTransport`, because the SDK client can't read the task handle.
- **Suggestion:** Either ship an `experimental.tasks` server helper (task store, task-capable
  `registerTool`, `tasks/*` handlers) for peers on 2025-11-25, or say in the README that Tasks are
  wire-only in 2.x. Let `registerTool()` pass `execution` through. Let the client accept a
  `CreateTaskResult` when the request carried a `task` param.

---

## Feature requests

| Request | Why it matters to CareCircle | Priority |
| --- | --- | --- |
| Public Alexa+ MCP test harness or hosted simulator | Lets us validate tool selection, elicitation and MCP Apps rendering against the real Alexa+ client | Critical |
| Published list of MCP features the Alexa+ client supports (elicitation modes, Tasks, resources, prompts) | Avoids building features Alexa+ will ignore | Important |
| TypeScript examples for MCP servers on AgentCore Runtime | MCP Apps tooling is TypeScript-first | Important |
| Clear credit eligibility per Bedrock model for hackathons | Prevents unexpected Marketplace charges | Important |

---

## Entry template

```markdown
## FL-<nn>: <short title>

- **Date:** YYYY-MM-DD
- **Area:** <product / doc / tool>
- **Task attempted:** <what you were trying to do>
- **Steps taken:** <commands, pages, versions>
- **Expected:** <what should have happened>
- **Actual:** <what happened, error text>
- **Severity:** Blocker / Major / Minor
- **Workaround:** <what you did>
- **Suggestion:** <one actionable fix>
```
