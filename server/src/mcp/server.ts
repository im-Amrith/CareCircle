import { McpServer } from '@modelcontextprotocol/server';
import type { Deps } from './context.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export const SERVER_NAME = 'carecircle-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `CareCircle helps a family coordinate an older person's daily care: medication doses, refills, visits and how they are feeling.
- Use get_care_status for "How is Mom today?" or a greeting; list_medications for schedules; log_medication when someone says they took (or skipped) medicine; check_refills for supplies; log_wellbeing for how they feel.
- Every tool returns a short sentence meant to be spoken aloud. Prefer reading it as is; keep replies brief.
- If log_medication returns needs_clarification, ask the user which option they meant, then call it again with medication_ids.
- CareCircle coordinates care and never gives medical advice, dosing changes or diagnoses. For symptoms, suggest the doctor; for emergencies, emergency services.`;

/** One McpServer per session. Each request resolves the caller from its own auth context. */
export function createCareCircleServer(deps: Deps): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'CareCircle',
      version: SERVER_VERSION,
      description: 'Family care coordination for Alexa+: medication logging, refills, visits and wellbeing notes.',
      websiteUrl: 'https://github.com/im-Amrith/CareCircle'
    },
    {
      instructions: INSTRUCTIONS,
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      }
    }
  );
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  return server;
}
