import { ResourceTemplate, ResourceNotFoundError, type McpServer } from '@modelcontextprotocol/server';
import { doseStates, supply } from '../domain/care.js';
import { addDays, spokenTime } from '../domain/time.js';
import { resolveCaller, type Deps } from './context.js';

/**
 * Resources: a readable care plan (Markdown) and a per-day log (JSON).
 * Both are scoped to the caller's own family; other family ids read as "not found"
 * so their existence isn't revealed.
 */
export function registerResources(server: McpServer, deps: Deps): void {
  server.registerResource(
    'care-plan',
    new ResourceTemplate('carecircle://family/{familyId}/care-plan', {
      list: async ctx => {
        const caller = await resolveCaller(ctx, deps);
        return {
          resources: [
            {
              uri: `carecircle://family/${caller.family.id}/care-plan`,
              name: `${caller.recipient.name}'s care plan`,
              mimeType: 'text/markdown'
            }
          ]
        };
      }
    }),
    {
      title: 'Care plan',
      description: "The care recipient's medicines, schedule, pharmacy, family contacts and this week's visits, as Markdown.",
      mimeType: 'text/markdown'
    },
    async (uri, variables, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      if (variables.familyId !== caller.family.id) throw new ResourceNotFoundError(uri.href);
      const meds = await deps.store.listMedications(caller.family.id);
      const members = await deps.store.listMembers(caller.family.id);
      const visits = await deps.store.listVisits(caller.family.id, caller.local.date, addDays(caller.local.date, 7));
      const lines = [
        `# ${caller.recipient.name}'s care plan`,
        '',
        `Timezone: ${caller.family.timezone}`,
        '',
        '## Medicines',
        '',
        '| Medicine | For | When | Supply |',
        '| --- | --- | --- | --- |',
        ...(await Promise.all(
          meds.map(async m => {
            const when = m.schedule
              .map(s => `${s.slot} ${spokenTime(caller.family.slots[s.slot])} (${s.pills})${s.instructions ? `, ${s.instructions}` : ''}`)
              .join('; ');
            const ph = await deps.store.getPharmacy(m.pharmacyId);
            return `| ${m.name} ${m.strength} | ${m.purpose} | ${when} | ${supply(m, caller.local.date).daysLeft} days, ${ph?.name ?? ''} |`;
          })
        )),
        '',
        '## Family',
        '',
        ...members.map(m => `- ${m.name} (${m.relation}, ${m.role})`),
        '',
        '## Visits this week',
        '',
        ...(visits.length
          ? visits.map(v => `- ${v.date} ${spokenTime(v.time)}: ${members.find(m => m.id === v.who)?.name ?? v.who}, ${v.purpose}`)
          : ['- None scheduled']),
        '',
        '_CareCircle coordinates care. It does not give medical advice._'
      ];
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    }
  );

  server.registerResource(
    'daily-log',
    new ResourceTemplate('carecircle://family/{familyId}/log/{date}', { list: undefined }),
    {
      title: 'Daily care log',
      description: 'Every scheduled dose with its status, plus wellbeing notes and visits, for one family-local date (YYYY-MM-DD).',
      mimeType: 'application/json'
    },
    async (uri, variables, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const date = String(variables.date);
      if (variables.familyId !== caller.family.id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ResourceNotFoundError(uri.href);
      const meds = await deps.store.listMedications(caller.family.id);
      const logs = await deps.store.listDoseLogs(caller.family.id, date, date);
      const body = {
        date,
        doses: doseStates(caller.family, meds, logs, date, caller.now),
        wellbeing: await deps.store.listWellbeing(caller.family.id, date, date),
        visits: await deps.store.listVisits(caller.family.id, date, date)
      };
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    }
  );
}
