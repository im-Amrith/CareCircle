import { McpServer } from '@modelcontextprotocol/server';
import type { Deps } from './context.js';
import { registerTools } from './tools.js';
import { registerRefillTools } from './refills.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerApps } from './apps.js';
import { registerLiveResources } from './live.js';
import { registerAppointmentTools } from './appointments.js';
import { registerPreferenceTools } from './preferences.js';
import { TASKS_CAPABILITY } from './tasks.js';
import { installSpeakerGate } from './identity.js';
import { installActivityTracker, registerCheckInTools } from './checkins.js';

export const SERVER_NAME = 'carecircle-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `CareCircle helps a family coordinate an older person's daily care: medication doses, refills, visits and how they are feeling.
- Use get_care_status for "How is Mom today?" or a greeting; list_medications for schedules; log_medication when someone says they took (or skipped) medicine; check_refills for supplies; request_refill to reorder; log_wellbeing for how they feel; set_language when someone asks you to speak Hindi or English; send_daily_summary to send the family today's written summary.
- Replies come in the caller's chosen language (English or Hindi). Keep that language when you speak; medicine names stay as they are.
- Every tool returns a short sentence meant to be spoken aloud. Prefer reading it as is; keep replies brief.
- If log_medication returns needs_clarification, ask the user which option they meant, then call it again with medication_ids.
- request_refill never orders without a yes: if it returns needs_confirmation, ask its question and call again with confirm true only after a clear yes. The order is placed on the checkout page it links to. Show the checkout link on screen; never read a URL aloud.
- coordinate_appointment books a doctor's appointment and a ride ("Book Mom's cardiology follow-up next week, mornings only, and sort out a ride"). It never books without the person's choice: clients with elicitation get a picker; otherwise, if it returns needs_choice, read the options and call again with option_id and confirm true only after a clear yes. It can run as an MCP Task.
- set_care_preference remembers how appointments should be arranged ("Mom prefers mornings", "not on Fridays") for the whole family, across conversations; coordinate_appointment uses them unless the request says otherwise.
- Morning check-ins: CareCircle learns when the care recipient usually starts the day; if a morning goes quiet it checks in on their device, and tells the family only if there's no answer. Use get_morning_rhythm for "Has Mom been up this morning?" or "How have Mom's mornings been?"; set_check_ins to pause them ("Mom's staying with me till Sunday"), resume, or turn them off (only after a clear yes). If the care recipient answers a check-in ("I'm fine"), log_wellbeing is right. CareCircle is not an emergency service.
- On a shared device CareCircle checks who is speaking before it changes anything. If a tool says it isn't sure who's speaking or doesn't recognise the voice, say that as it is; don't retry or work around it. Questions about how they are doing still work.
- CareCircle coordinates care and never gives medical advice, dosing changes or diagnoses. For symptoms, suggest the doctor; for emergencies, emergency services.`;

/** One McpServer per session. Each request resolves the caller from its own auth context. */
export function createCareCircleServer(deps: Deps): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'CareCircle',
      version: SERVER_VERSION,
      description: 'Family care coordination for Alexa+: medication logging, refill ordering, visits and wellbeing notes.',
      websiteUrl: 'https://github.com/im-Amrith/CareCircle'
    },
    {
      instructions: INSTRUCTIONS,
      capabilities: {
        tools: { listChanged: true },
        // today and inbox support resources/subscribe, so every family screen stays live.
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        // coordinate_appointment can run as a task (MCP 2025-11-25, experimental).
        tasks: TASKS_CAPABILITY
      } as object
    }
  );
  registerTools(server, deps);
  registerRefillTools(server, deps);
  registerPreferenceTools(server, deps);
  registerAppointmentTools(server, deps);
  registerCheckInTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  registerApps(server);
  registerLiveResources(server, deps);
  // Notes when the person being cared for speaks to CareCircle (their morning has started).
  // Inside the speaker gate, so it only sees calls the gate let through, as who they really are.
  installActivityTracker(server, deps);
  // Last, so it sits in front of every tool call, task-augmented ones included.
  installSpeakerGate(server, deps);
  return server;
}
