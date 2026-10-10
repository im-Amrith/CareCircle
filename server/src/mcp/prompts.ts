import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { resolveCaller, type Deps } from './context.js';

const RULES =
  'Keep it under 40 words, in plain spoken sentences with no lists or formatting. Do not give medical advice; for symptoms, suggest contacting a doctor or emergency services.';

export function registerPrompts(server: McpServer, deps: Deps): void {
  server.registerPrompt(
    'morning_briefing',
    {
      title: 'Morning briefing',
      description: "A warm, short start-of-day briefing for the person asking: today's doses, visits and anything running low."
    },
    async ctx => {
      const caller = await resolveCaller(ctx, deps);
      const audience = caller.isRecipient
        ? `${caller.recipient.name}, speaking to her directly`
        : `${caller.member.name}, about ${caller.recipient.name}`;
      return {
        description: 'Morning briefing',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Give a morning briefing for ${audience}. Call get_care_status with detail "brief", then mention doses due this morning, visits today and any medicine running low. ${RULES}`
            }
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'caregiver_handoff',
    {
      title: 'Caregiver handoff',
      description: 'What the next helper needs to know before taking over: doses still due today, recent wellbeing notes and supplies.',
      argsSchema: z.object({
        helper: z.string().optional().describe('Name of the person taking over, e.g. Maya')
      })
    },
    async ({ helper }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const name = helper ?? 'the next helper';
      return {
        description: 'Caregiver handoff',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Prepare a handoff for ${name}, who is taking over care of ${caller.recipient.name}. Call get_care_status with detail "full" and check_refills. Say which doses are still due today and when, anything ${caller.recipient.name} mentioned about how she feels, and any medicine that needs reordering. ${RULES}`
            }
          }
        ]
      };
    }
  );
}
