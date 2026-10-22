import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { PreferenceKey } from '../store/types.js';
import { parseConstraints } from '../domain/appointments.js';
import { listJoin } from '../domain/speech.js';
import { uiMeta } from './apps.js';
import { guarded, ok, resolveCaller, type Caller, type Deps } from './context.js';

/**
 * Care preferences the family wants remembered across conversations ("Mom prefers
 * mornings"). Kept server-side on the family, so any member's next session uses them.
 * In production this would sit in AgentCore Memory; the store interface stays the same.
 */

const KEYS: Record<PreferenceKey, string> = {
  appointment_time: 'appointment time of day',
  appointment_days: 'appointment days'
};

/** What a sentence says about appointment preferences, one entry per key. */
export function readPreferences(text: string): { key: PreferenceKey; value: string }[] {
  const c = parseConstraints(text);
  const out: { key: PreferenceKey; value: string }[] = [];
  const time = c.understood.find(u => u === 'mornings' || u === 'afternoons');
  if (time) out.push({ key: 'appointment_time', value: time });
  const days = c.understood.filter(u => u !== time);
  if (days.length) out.push({ key: 'appointment_days', value: days.join(', ') });
  return out;
}

/** "in the mornings", "not on Friday", "on Tuesday or Thursday" */
export function phrase(value: string): string {
  if (value === 'mornings' || value === 'afternoons') return `in the ${value}`;
  return value.replace(/^not /, 'not on ').replace(/^(?!not )/, 'on ');
}

/** A request's own constraints, plus any stored preference for what the request leaves open. */
export async function withPreferences(deps: Deps, caller: Caller, constraints: string | undefined) {
  const own = parseConstraints(constraints);
  const prefs = await deps.store.listPreferences(caller.family.id);
  const used = prefs.filter(p =>
    p.key === 'appointment_time' ? own.earliest === '08:00' && own.latest === '17:00' : p.key === 'appointment_days' ? own.weekdays.length === 0 : false
  );
  return { constraints: parseConstraints(constraints, ...used.map(p => p.value)), used };
}

const PreferenceOut = z.object({ key: z.enum(['appointment_time', 'appointment_days']), value: z.string(), said: z.string(), setBy: z.string() });

export function registerPreferenceTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'set_care_preference',
    {
      title: 'Remember a care preference',
      description:
        "Remember how the care recipient likes appointments arranged, across conversations, for the whole family: time of day ('Mom prefers mornings') and days ('not on Fridays', 'Tuesdays or Thursdays'). coordinate_appointment uses them whenever a request doesn't say otherwise. Set forget to true for 'Forget Mom's appointment preferences'. Not for medical instructions.",
      inputSchema: z.object({
        preference: z.string().min(2).max(200).describe("What was said, e.g. 'Mom prefers mornings'"),
        forget: z.boolean().default(false).describe('True to forget the preference described (or all appointment preferences)')
      }),
      outputSchema: z.object({
        result: z.enum(['saved', 'forgotten', 'not_understood']),
        preferences: z.array(PreferenceOut).describe('Every preference now stored for the family')
      }),
      annotations: { title: 'Remember a care preference', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
    },
    guarded(async ({ preference, forget }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const familyId = caller.family.id;
      const name = caller.isRecipient ? 'your' : `${caller.recipient.name}'s`;
      const found = readPreferences(preference);
      const all = async () => (await deps.store.listPreferences(familyId)).map(p => ({ key: p.key, value: p.value, said: p.said, setBy: p.setBy }));

      if (forget) {
        const keys = found.length ? found.map(f => f.key) : (Object.keys(KEYS) as PreferenceKey[]);
        const removed: string[] = [];
        for (const key of keys) if (await deps.store.removePreference(familyId, key)) removed.push(KEYS[key]);
        return ok(
          { result: 'forgotten' as const, preferences: await all() },
          removed.length ? `Okay, I've forgotten ${name} ${listJoin(removed)} preference${removed.length > 1 ? 's' : ''}.` : `There was nothing to forget.`
        );
      }
      if (!found.length) {
        return ok(
          { result: 'not_understood' as const, preferences: await all() },
          `I can remember times of day and days for ${name} appointments, like mornings, or not on Fridays. What should I remember?`
        );
      }
      for (const f of found) {
        await deps.store.setPreference({ familyId, key: f.key, value: f.value, said: preference, setBy: caller.member.id, setAt: caller.now.toISOString() });
      }
      return ok(
        { result: 'saved' as const, preferences: await all() },
        `Got it. From now on I'll look for ${name} appointments ${listJoin(found.map(f => phrase(f.value)))}, unless someone asks otherwise.`
      );
    })
  );
}
