# Task: appointment coordination (MCP Tasks + Strands care team) and the Agent Skill

Two standout additions. The hackathon rules name these as "creative" for the judges:

- **Alexa+:** "agentic workflow that orchestrates across services autonomously" and "Agent Skills".
- **AWS Builder:** "multi-service pipeline (Bedrock + AgentCore + Strands)" and "agent
  orchestration patterns".

Read `README.md`, `server/src/mcp/*.ts`, `alexa-sim/orchestrator` and `docs/friction-log.md`
first. Keep everything that already works working.

## Part A: `coordinate_appointment` (the demo's "wow" moment)

Sam says: *"Book Mom's cardiology follow-up next week, mornings only, and sort out a ride."*

### 1. Mock services (in-process, synthetic)

- Clinic availability: Riverside Heart Clinic, slots next Mon–Fri, 9:00–17:00.
- Each family member's busy times: Maya free Tue and Thu mornings, Sam remote.
- Travel time: about 25 minutes.
- Put them behind a tiny interface so a real API could replace them.

### 2. MCP server tool `coordinate_appointment`

- **Input:** `specialty`, `window` (e.g. "next week"), `constraints` (e.g. "mornings").
- **Annotations:** `openWorldHint: true`.
- **Runs as an MCP Task** (spec 2025-11-25, experimental) when the client asks for task
  augmentation:
  - Return a task handle immediately.
  - Status moves `working` → `input_required` (pick a slot) → `completed`.
  - Send `notifications/tasks/status`.
  - Support `tasks/get`, `tasks/result` and `tasks/cancel`.
  - Check the installed `@modelcontextprotocol/server` version's Tasks API from its type
    definitions before writing code; do not guess.
  - If the client doesn't ask for a task, run synchronously with progress notifications.
- **The approval step:**
  - Uses form elicitation listing up to 3 ranked options, e.g. "Tue 10:30 with Dr Rao, Maya
    drives".
  - The user picks one or declines. Nothing is booked without that choice; the server enforces
    it, as with refills (FL-10).
- **On completion:**
  - Create the visit, so it shows in `get_care_status` and the family view.
  - Create a helper task for the driver ("Maya: drive Rose to Riverside Heart Clinic, Tue 10:05").
  - Speak one short confirmation line.

### 3. The planning is done by a Strands multi-agent Graph (Python, in the orchestrator)

- Agents:
  - **Coordinator**, which reads the request and preferences.
  - **Clinic**, **Family calendar** and **Transport**, which run in parallel.
  - **Planner**, which ranks up to 3 options with a one-line reason each.
- **Model:** Bedrock `global.amazon.nova-2-lite-v1:0` in `ap-southeast-2`.
- **Mock mode:** a deterministic planner returns the same 3 options, so judges can run it without
  AWS.
- **Wiring:** the simplest robust option is an orchestrator HTTP endpoint the MCP server calls,
  with the server owning the Task state and the elicitation.

### 4. Remember preferences across sessions

- When someone says "Mom prefers mornings", store it on the family and use it next time.
- Use a simple server-side preference store now. Mention AgentCore Memory as the production path
  in the README; don't deploy it.

### 5. Simulator UI

- A task card with live status ("Checking the clinic… Checking who can drive…").
- The slot picker as the elicitation form.
- A final booked card.
- The protocol panel shows the task messages.

### 6. Tests

- Server: the Task lifecycle including cancel and decline, and that nothing is booked without a
  choice.
- Orchestrator (mock mode): the planner returns 3 options and respects "mornings".
- Add the demo line to the README script, after the refill line.

## Part B: Agent Skill (`skills/carecircle/SKILL.md`)

Follow the Agent Skills format (https://agentskills.io/): YAML front matter with `name` and
`description`, then instructions. It teaches any agent how to:

- connect to the CareCircle MCP server (URL, the `Bearer dev:<user>` header locally),
- pick the right tool per intent (a table),
- follow the safety rules: no medical advice, orders and bookings only after a human yes, never
  read URLs aloud,
- follow two worked examples ("How is Mom today?", "Reorder her blood pressure tablets").

Add a short `skills/carecircle/README.md` explaining how to install it in Claude Code or Kiro.
Link it from the main README.

## Friction log

Add entries for anything that fights you, especially experimental MCP Tasks support in the SDKs
and Strands Graph APIs. Use exact errors and versions.

## Done when

- [ ] `npm test` passes: server, orchestrator and web.
- [ ] The appointment demo line works in `npm run sim:mock` and `npm run sim:demo`.
- [ ] Branch `feature/appointments`, PR opened with a short screen recording or screenshots.

Plan first and wait for my OK. Build mock mode end to end before Bedrock.
