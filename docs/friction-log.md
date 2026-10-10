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
- **Severity:** Blocker (no model calls possible until resolved)
- **Workaround:** _In progress:_ (1) retried in us-east-1: blocked, the account is a project
  account locked to ap-southeast-2 (see FL-08); retry Nova models in Sydney; (2) check the account plan (Free vs
  Paid) under Billing; (3) if still blocked, open a free "Account and billing" support case.
  Development continues in mock mode meanwhile. _Update this entry with the outcome._
- **Related friction:** The console top bar showed only the account name ("Lift Off Soon"), with
  no visible Region selector, so it was unclear which Region the playground was using.
- **Suggestion:** Return an `AccessDeniedException` with a reason (e.g. "account not yet enabled
  for Bedrock, contact Support") instead of a `ValidationException`, and show the fix as a link in
  the playground banner.

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
