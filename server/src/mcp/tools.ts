import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { SLOTS, type DoseLog, type Medication, type Slot } from '../store/types.js';
import {
  DEFAULT_REFILL_WINDOW_DAYS,
  doseStates,
  isGenericPhrase,
  matchMedication,
  refillAlerts,
  safetyCheck,
  slotToLog,
  supply,
  type DoseState
} from '../domain/care.js';
import { addDays, localParts, spokenDate, spokenTime, toMinutes } from '../domain/time.js';
import { countWord, greeting, listJoin, plural, sentences } from '../domain/speech.js';
import { OrderOut, openOrders, orderOut, orderSentence } from './refills.js';
import { CareError, guarded, ok, requireRole, resolveCaller, subject, type Caller, type Deps } from './context.js';

/* ---------- Shared schemas ---------- */

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const SlotEnum = z.enum(SLOTS);

const DoseOut = z.object({
  medicationId: z.string(),
  name: z.string(),
  strength: z.string(),
  slot: SlotEnum,
  time: z.string().describe('HH:MM in the family timezone'),
  pills: z.number(),
  status: z.enum(['taken', 'skipped', 'due', 'upcoming', 'missed']),
  loggedAt: z.string().optional()
});

const SupplyOut = z.object({
  medicationId: z.string(),
  name: z.string(),
  strength: z.string(),
  pillsOnHand: z.number(),
  daysLeft: z.number(),
  runsOutOn: z.string(),
  order: OrderOut.nullable().describe('An open refill order for this medicine, if one exists')
});

function doseOut(d: DoseState) {
  return {
    medicationId: d.medicationId,
    name: d.name,
    strength: d.strength,
    slot: d.slot,
    time: d.time,
    pills: d.pills,
    status: d.status,
    ...(d.loggedAt ? { loggedAt: d.loggedAt } : {})
  };
}

function supplyOut(s: ReturnType<typeof supply>) {
  return {
    medicationId: s.medicationId,
    name: s.name,
    strength: s.strength,
    pillsOnHand: s.pillsOnHand,
    daysLeft: s.daysLeft,
    runsOutOn: s.runsOutOn
  };
}

const SLOT_PHRASE: Record<Slot, string> = {
  morning: 'this morning',
  noon: 'at lunchtime',
  evening: 'this evening',
  night: 'tonight'
};

function medLabel(d: { name: string }) {
  return d.name;
}

async function todayContext(deps: Deps, caller: Caller, date: string) {
  const meds = await deps.store.listMedications(caller.family.id);
  const logs = await deps.store.listDoseLogs(caller.family.id, date, date);
  const states = doseStates(caller.family, meds, logs, date, caller.now);
  return { meds, logs, states };
}

/* ---------- Tools ---------- */

export function registerTools(server: McpServer, deps: Deps): void {
  /* get_care_status */
  server.registerTool(
    'get_care_status',
    {
      title: "Today's care status",
      description:
        "Summarise the care recipient's day: which medication doses are taken, due, upcoming or missed, the next dose, visits, the latest wellbeing note, and medicines running low. Use for 'How is Mom today?', 'Good morning', 'What's happening today?'. Read-only.",
      inputSchema: z.object({
        date: DateString.optional().describe('Family-local date, YYYY-MM-DD. Defaults to today.'),
        detail: z.enum(['brief', 'full']).default('brief').describe('brief for a one-breath spoken answer, full for more detail')
      }),
      outputSchema: z.object({
        date: z.string(),
        recipient: z.object({ id: z.string(), name: z.string() }),
        counts: z.object({
          total: z.number(),
          taken: z.number(),
          due: z.number(),
          upcoming: z.number(),
          missed: z.number(),
          skipped: z.number()
        }),
        doses: z.array(DoseOut),
        nextDose: DoseOut.nullable(),
        visits: z.array(z.object({ who: z.string(), time: z.string(), purpose: z.string() })),
        latestWellbeing: z
          .object({ note: z.string(), severity: z.string(), date: z.string(), time: z.string(), redFlag: z.boolean() })
          .nullable(),
        refillAlerts: z.array(SupplyOut),
        missedLast7Days: z.number()
      }),
      annotations: { title: "Today's care status", readOnlyHint: true, openWorldHint: false }
    },
    guarded(async ({ date, detail }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const day = date ?? caller.local.date;
      const { meds, states } = await todayContext(deps, caller, day);
      const count = (s: DoseState['status']) => states.filter(d => d.status === s).length;
      const counts = {
        total: states.length,
        taken: count('taken'),
        due: count('due'),
        upcoming: count('upcoming'),
        missed: count('missed'),
        skipped: count('skipped')
      };
      const next = states.find(d => d.status === 'due') ?? states.find(d => d.status === 'upcoming') ?? null;

      const members = await deps.store.listMembers(caller.family.id);
      const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? id;
      const visits = (await deps.store.listVisits(caller.family.id, day, day)).map(v => ({
        who: nameOf(v.who),
        time: v.time,
        purpose: v.purpose
      }));
      const notes = await deps.store.listWellbeing(caller.family.id, addDays(day, -1), day);
      const latest = notes.at(-1);
      const alerts = refillAlerts(meds, caller.local.date);
      const orders = await openOrders(deps, caller);

      const weekFrom = addDays(caller.local.date, -7);
      const weekTo = addDays(caller.local.date, -1);
      const weekLogs = await deps.store.listDoseLogs(caller.family.id, weekFrom, weekTo);
      let missedLast7Days = 0;
      for (let i = 1; i <= 7; i++) {
        const d = addDays(caller.local.date, -i);
        missedLast7Days += doseStates(caller.family, meds, weekLogs, d, caller.now).filter(s => s.status === 'missed').length;
      }

      // ---- Spoken summary ----
      const who = subject(caller);
      const isToday = day === caller.local.date;
      const due = states.filter(d => d.status === 'due');
      const missedToday = states.filter(d => d.status === 'missed');
      const parts: string[] = [];
      if (caller.isRecipient && isToday) parts.push(`${greeting(caller.local.minutes)}, ${caller.recipient.name}.`);
      if (isToday) {
        const takenWord = counts.taken === counts.total ? 'all' : counts.taken === 0 ? 'none' : countWord(counts.taken);
        parts.push(
          caller.isRecipient
            ? `You've taken ${takenWord} of your ${plural(counts.total, 'dose')} today.`
            : `${who.has} taken ${takenWord} of ${caller.recipient.pronoun === 'he' ? 'his' : caller.recipient.pronoun === 'she' ? 'her' : 'their'} ${plural(counts.total, 'dose')} so far today.`
        );
        if (due.length) {
          parts.push(`${listJoin(due.map(medLabel))} ${due.length === 1 ? 'is' : 'are'} due now.`);
        } else if (next) {
          parts.push(`Next is ${next.name} at ${spokenTime(next.time)}.`);
        }
        if (missedToday.length) {
          const bySlot = new Map<Slot, string[]>();
          for (const d of missedToday) bySlot.set(d.slot, [...(bySlot.get(d.slot) ?? []), d.name]);
          const groups = [...bySlot].map(([slot, names]) => `${listJoin(names)} from ${slot === 'noon' ? 'lunchtime' : `the ${slot}`}`);
          parts.push(`Not logged yet: ${listJoin(groups)}.`);
        }
      } else {
        parts.push(`On ${spokenDate(day, caller.local.date)}, ${who.name} took ${counts.taken} of ${plural(counts.total, 'dose')}.`);
        if (missedToday.length) parts.push(`Missed: ${listJoin(missedToday.map(d => d.name))}.`);
      }
      for (const v of visits) parts.push(`${v.who} visits at ${spokenTime(v.time)}.`);
      if (latest && (detail === 'full' || latest.date === caller.local.date)) {
        const said = latest.note.replace(/\.$/, '');
        // Lower-case the first letter so it reads mid-sentence, but never the pronoun "I".
        const quoted = /^I\b/.test(said) ? said : said[0].toLowerCase() + said.slice(1);
        parts.push(
          caller.isRecipient
            ? `You mentioned: ${quoted}.`
            : `${who.pronoun === 'they' ? 'They' : who.pronoun[0].toUpperCase() + who.pronoun.slice(1)} mentioned: ${quoted}.`
        );
      }
      if (alerts.length) {
        const a = alerts[0];
        parts.push(`${a.name} runs low: about ${plural(a.daysLeft, 'day')} left.`);
        const order = orders.get(a.medicationId);
        if (order) parts.push(orderSentence(order, caller.now, caller.local.date));
      }
      if (detail === 'full') parts.push(`In the past week, ${plural(missedLast7Days, 'dose')} ${missedLast7Days === 1 ? 'was' : 'were'} missed.`);

      return ok(
        {
          date: day,
          recipient: { id: caller.recipient.id, name: caller.recipient.name },
          counts,
          doses: states.map(doseOut),
          nextDose: next ? doseOut(next) : null,
          visits,
          latestWellbeing: latest
            ? { note: latest.note, severity: latest.severity, date: latest.date, time: latest.time, redFlag: latest.redFlag }
            : null,
          refillAlerts: await Promise.all(
            alerts.map(async a => {
              const order = orders.get(a.medicationId);
              return { ...supplyOut(a), order: order ? await orderOut(deps, order, caller.now) : null };
            })
          ),
          missedLast7Days
        },
        sentences(...parts)
      );
    })
  );

  /* list_medications */
  server.registerTool(
    'list_medications',
    {
      title: 'Medication schedule',
      description:
        "List the care recipient's medicines with when to take them, what each is for and how many days of supply are left. Optionally filter to one time of day. Use for 'What do I take tonight?' or 'What medicines is Mom on?'. Read-only.",
      inputSchema: z.object({
        when: SlotEnum.optional().describe('Only medicines taken at this time of day')
      }),
      outputSchema: z.object({
        when: SlotEnum.nullable(),
        medications: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            strength: z.string(),
            form: z.string(),
            purpose: z.string(),
            schedule: z.array(z.object({ slot: SlotEnum, time: z.string(), pills: z.number(), instructions: z.string().optional() })),
            pillsOnHand: z.number(),
            daysLeft: z.number(),
            pharmacy: z.string()
          })
        )
      }),
      annotations: { title: 'Medication schedule', readOnlyHint: true, openWorldHint: false }
    },
    guarded(async ({ when }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const meds = await deps.store.listMedications(caller.family.id);
      const chosen = when ? meds.filter(m => m.schedule.some(s => s.slot === when)) : meds;
      const medications = await Promise.all(
        chosen.map(async m => ({
          id: m.id,
          name: m.name,
          strength: m.strength,
          form: m.form,
          purpose: m.purpose,
          schedule: m.schedule
            .filter(s => !when || s.slot === when)
            .map(s => ({ slot: s.slot, time: caller.family.slots[s.slot], pills: s.pills, ...(s.instructions ? { instructions: s.instructions } : {}) })),
          pillsOnHand: m.pillsOnHand,
          daysLeft: supply(m, caller.local.date).daysLeft,
          pharmacy: (await deps.store.getPharmacy(m.pharmacyId))?.name ?? 'unknown pharmacy'
        }))
      );
      medications.sort((a, b) => toMinutes(a.schedule[0]?.time ?? '23:59') - toMinutes(b.schedule[0]?.time ?? '23:59'));

      const who = subject(caller);
      let speech: string;
      if (when) {
        const takes = caller.isRecipient ? 'you take' : `${caller.recipient.name} takes`;
        const instructions = [...new Set(medications.map(m => m.schedule[0]?.instructions ?? ''))];
        const shared = instructions.length === 1 && instructions[0] ? `, ${instructions[0]}` : '';
        const items = medications.map(
          m => `${m.name} ${m.strength}${!shared && m.schedule[0]?.instructions ? ` ${m.schedule[0].instructions}` : ''}`
        );
        speech = medications.length
          ? `${SLOT_PHRASE[when][0].toUpperCase()}${SLOT_PHRASE[when].slice(1)} at ${spokenTime(caller.family.slots[when])}, ${takes} ${listJoin(items)}${shared}.`
          : `There's nothing scheduled ${SLOT_PHRASE[when]}.`;
      } else {
        speech = `${caller.isRecipient ? 'You take' : `${caller.recipient.name} takes`} ${plural(medications.length, 'medicine')}: ${listJoin(
          medications.map(m => `${m.name} for ${m.purpose}`)
        )}.`;
      }
      return ok({ when: when ?? null, medications }, speech);
    })
  );

  /* log_medication */
  server.registerTool(
    'log_medication',
    {
      title: 'Log a dose',
      description:
        "Record that the care recipient took (or skipped) medication today. Use for 'I took my pills', 'I took my blood pressure tablet', 'Mom took her evening medicine'. With no medicine named, logs every dose currently due. Repeating the same call does not double-log. If the name matches more than one medicine it returns options to ask about.",
      inputSchema: z.object({
        spoken_name: z
          .string()
          .max(120)
          .optional()
          .describe("The medicine as the person said it, e.g. 'my blood pressure tablet' or 'vitamin'. Omit for 'my pills'."),
        medication_ids: z.array(z.string()).max(10).optional().describe('Exact medication ids, if already known'),
        slot: SlotEnum.optional().describe('Which scheduled dose, if the person said (e.g. evening)'),
        status: z.enum(['taken', 'skipped']).default('taken'),
        taken_at: z.iso.datetime({ offset: true }).optional().describe('When it was taken, ISO 8601. Defaults to now.')
      }),
      outputSchema: z.object({
        result: z.enum(['logged', 'already_logged', 'needs_clarification', 'nothing_due', 'not_found']),
        date: z.string(),
        logged: z.array(z.object({ medicationId: z.string(), name: z.string(), slot: SlotEnum, status: z.enum(['taken', 'skipped']), at: z.string() })),
        alreadyLogged: z.array(z.object({ medicationId: z.string(), name: z.string(), slot: SlotEnum })),
        options: z.array(z.object({ id: z.string(), name: z.string(), purpose: z.string() })),
        nextDose: DoseOut.nullable()
      }),
      annotations: { title: 'Log a dose', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    guarded(async ({ spoken_name, medication_ids, slot, status, taken_at }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      requireRole(caller, ['recipient', 'coordinator', 'helper'], 'log doses');
      const day = caller.local.date;
      const { meds, states } = await todayContext(deps, caller, day);
      const base = { date: day, logged: [], alreadyLogged: [], options: [], nextDose: null };
      const who = subject(caller);

      // 1. Work out which medicines.
      let targets: Medication[];
      if (medication_ids?.length) {
        targets = meds.filter(m => medication_ids.includes(m.id));
        const unknown = medication_ids.filter(id => !meds.some(m => m.id === id));
        if (unknown.length) throw new CareError(`I don't know the medicine ${unknown.join(', ')}.`);
      } else if (spoken_name && !isGenericPhrase(spoken_name)) {
        const match = matchMedication(meds, spoken_name);
        if (match.kind === 'none') {
          return ok(
            { ...base, result: 'not_found' as const, options: meds.map(m => ({ id: m.id, name: m.name, purpose: m.purpose })) },
            `I couldn't match "${spoken_name}" to a medicine. ${caller.isRecipient ? 'Your' : `${caller.recipient.name}'s`} medicines are ${listJoin(meds.map(m => m.name))}. Which one was it?`
          );
        }
        if (match.kind === 'ambiguous') {
          return ok(
            { ...base, result: 'needs_clarification' as const, options: match.matches.map(m => ({ id: m.id, name: m.name, purpose: m.purpose })) },
            `Did you mean ${listJoin(match.matches.map(m => `${m.name} for ${m.purpose}`), 'or')}?`
          );
        }
        targets = match.matches;
      } else {
        const chosenSlot = slot ?? slotToLog(states, caller.family, caller.now);
        if (!chosenSlot) {
          const next = states.find(s => s.status === 'upcoming') ?? null;
          return ok(
            { ...base, result: 'nothing_due' as const, nextDose: next ? doseOut(next) : null },
            next
              ? `Nothing is due right now. Next is ${next.name} at ${spokenTime(next.time)}.`
              : `All of today's doses are already logged.`
          );
        }
        targets = meds.filter(m => m.schedule.some(s => s.slot === chosenSlot));
        slot = chosenSlot;
      }

      // 2. For each medicine, pick the dose slot this refers to.
      const at = taken_at ? new Date(taken_at) : caller.now;
      const logged: { medicationId: string; name: string; slot: Slot; status: 'taken' | 'skipped'; at: string }[] = [];
      const alreadyLogged: { medicationId: string; name: string; slot: Slot }[] = [];
      for (const med of targets) {
        const own = states.filter(s => s.medicationId === med.id);
        const pick =
          (slot && own.find(s => s.slot === slot)) ||
          own.find(s => s.status === 'due') ||
          [...own].reverse().find(s => s.status === 'missed') ||
          own.find(s => s.status === 'upcoming') ||
          own.find(s => s.status === 'taken' || s.status === 'skipped');
        if (!pick) continue;
        if (pick.status === 'taken' || pick.status === 'skipped') {
          alreadyLogged.push({ medicationId: med.id, name: med.name, slot: pick.slot });
          continue;
        }
        const log: DoseLog = {
          id: `log-${day}-${med.id}-${pick.slot}`,
          familyId: caller.family.id,
          medicationId: med.id,
          slot: pick.slot,
          date: day,
          status,
          at: at.toISOString(),
          loggedBy: caller.member.id,
          source: 'voice'
        };
        await deps.store.addDoseLog(log);
        if (status === 'taken') await deps.store.adjustPills(caller.family.id, med.id, -pick.pills);
        logged.push({ medicationId: med.id, name: med.name, slot: pick.slot, status, at: log.at });
      }

      const after = (await todayContext(deps, caller, day)).states;
      const next = after.find(s => s.status === 'due') ?? after.find(s => s.status === 'upcoming') ?? null;
      const parts: string[] = [];
      if (logged.length) {
        const slotsLogged = [...new Set(logged.map(l => l.slot))];
        const when = slotsLogged.length === 1 ? ` for ${SLOT_PHRASE[slotsLogged[0]].replace('this ', 'the ').replace('tonight', 'tonight').replace('at lunchtime', 'lunchtime')}` : '';
        parts.push(
          caller.isRecipient
            ? `Got it. I've logged ${listJoin(logged.map(medLabel))}${when}${status === 'skipped' ? ' as skipped' : ''}.`
            : `Got it. Logged ${listJoin(logged.map(medLabel))}${when} for ${caller.recipient.name}${status === 'skipped' ? ' as skipped' : ''}.`
        );
      }
      if (alreadyLogged.length) parts.push(`${listJoin(alreadyLogged.map(medLabel))} ${alreadyLogged.length === 1 ? 'was' : 'were'} already logged.`);
      if (next) parts.push(`Next is ${next.name} at ${spokenTime(next.time)}.`);
      else if (logged.length) parts.push(`That's everything for today${caller.isRecipient ? ', well done' : ''}.`);

      return ok(
        {
          result: logged.length ? ('logged' as const) : ('already_logged' as const),
          date: day,
          logged,
          alreadyLogged,
          options: [],
          nextDose: next ? doseOut(next) : null
        },
        sentences(...parts) || `${who.has} nothing to log right now.`
      );
    })
  );

  /* check_refills */
  server.registerTool(
    'check_refills',
    {
      title: 'Check medicine supply',
      description:
        "Find medicines that will run out soon, with days of supply left and the date they run out. Use for 'Am I running low on anything?' or 'Does Mom need a refill?'. Read-only; does not order anything (use request_refill for that).",
      inputSchema: z.object({
        within_days: z.number().int().min(1).max(60).default(DEFAULT_REFILL_WINDOW_DAYS).describe('Flag medicines with this many days or fewer left')
      }),
      outputSchema: z.object({
        withinDays: z.number(),
        alerts: z.array(SupplyOut.extend({ pharmacy: z.object({ id: z.string(), name: z.string() }) }))
      }),
      annotations: { title: 'Check medicine supply', readOnlyHint: true, openWorldHint: false }
    },
    guarded(async ({ within_days }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const meds = await deps.store.listMedications(caller.family.id);
      const orders = await openOrders(deps, caller);
      const alerts = await Promise.all(
        refillAlerts(meds, caller.local.date, within_days).map(async s => {
          const ph = await deps.store.getPharmacy(s.pharmacyId);
          const order = orders.get(s.medicationId);
          return {
            ...supplyOut(s),
            order: order ? await orderOut(deps, order, caller.now) : null,
            pharmacy: { id: s.pharmacyId, name: ph?.name ?? 'the pharmacy' }
          };
        })
      );
      const unordered = alerts.filter(a => !a.order);
      const whose = caller.isRecipient ? 'your' : `${caller.recipient.name}'s`;
      const speech = alerts.length
        ? sentences(
            ...alerts.map(
              a =>
                a.daysLeft === 0
                  ? `${a.name} ${a.strength} has run out or has less than a day left.`
                  : `${a.name} ${a.strength} has about ${plural(a.daysLeft, 'day')} left, enough until ${spokenDate(a.runsOutOn, caller.local.date)}.`
            ).flatMap((line, i) => {
              const order = orders.get(alerts[i].medicationId);
              return order ? [line, orderSentence(order, caller.now, caller.local.date)] : [line];
            }),
            unordered.length > 0 &&
              `${unordered.length === 1 ? 'It comes' : 'They come'} from ${unordered[0].pharmacy.name}.${caller.member.role === 'helper' ? '' : ` Want me to reorder ${unordered.length === 1 ? 'it' : unordered[0].name}?`}`
          )
        : `All of ${whose} medicines have more than ${plural(within_days, 'day')} of supply.`;
      return ok({ withinDays: within_days, alerts }, speech);
    })
  );

  /* log_wellbeing */
  server.registerTool(
    'log_wellbeing',
    {
      title: 'Log how they feel',
      description:
        "Record a note about how the care recipient is feeling, sleeping or managing, e.g. 'I slept badly', 'Mom says her knee hurts', 'I feel dizzy'. Notes show up in the family's status and digest. CareCircle does not diagnose or give medical advice; urgent symptoms get safety guidance.",
      inputSchema: z.object({
        note: z.string().min(1).max(500).describe("What was said, in plain words, e.g. 'feeling dizzy since lunch'"),
        severity: z.enum(['low', 'medium', 'high']).optional().describe('How worrying it sounds, if clear')
      }),
      outputSchema: z.object({
        id: z.string(),
        date: z.string(),
        time: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        redFlag: z.boolean(),
        reasons: z.array(z.string()),
        familyCanSee: z.boolean()
      }),
      annotations: { title: 'Log how they feel', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    guarded(async ({ note, severity }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const check = safetyCheck(note);
      const level = check.redFlag ? 'high' : (severity ?? 'low');
      const local = localParts(caller.now, caller.family.timezone);
      const id = `well-${caller.now.getTime()}`;
      await deps.store.addWellbeing({
        id,
        familyId: caller.family.id,
        at: caller.now.toISOString(),
        date: local.date,
        time: local.time,
        note: note.trim(),
        severity: level,
        redFlag: check.redFlag,
        loggedBy: caller.member.id
      });
      const others = (await deps.store.listMembers(caller.family.id)).filter(m => m.id !== caller.member.id && m.id !== caller.recipient.id);
      const family = listJoin(others.map(m => m.name)) || 'the family';
      let speech: string;
      if (check.redFlag) {
        speech = sentences(
          caller.isRecipient ? "I've noted that." : `I've noted that for ${caller.recipient.name}.`,
          `${check.reasons[0][0].toUpperCase()}${check.reasons[0].slice(1)} can be serious.`,
          'If it is severe or sudden, call emergency services now.',
          `${family} will see this note straight away.`
        );
      } else if (level === 'medium') {
        speech = sentences(
          caller.isRecipient ? "Thanks for telling me, I've noted it." : `Noted for ${caller.recipient.name}.`,
          'If it gets worse or does not settle, please call the doctor.',
          `${family} can see it in today's update.`
        );
      } else {
        speech = sentences(
          caller.isRecipient ? "Thanks, I've added that to today's notes." : `Noted for ${caller.recipient.name}.`,
          `${family} can see it in today's update.`
        );
      }
      return ok({ id, date: local.date, time: local.time, severity: level, redFlag: check.redFlag, reasons: check.reasons, familyCanSee: true }, speech);
    })
  );
}
