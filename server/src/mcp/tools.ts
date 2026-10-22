import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { LANGUAGES, SLOTS, type DoseLog, type Medication, type Slot } from '../store/types.js';
import { DEFAULT_REFILL_WINDOW_DAYS, isGenericPhrase, matchMedication, refillAlerts, safetyCheck, slotToLog, supply } from '../domain/care.js';
import { localParts, spokenDate, spokenTime, toMinutes } from '../domain/time.js';
import { listJoin, plural, sentences } from '../domain/speech.js';
import { dateHi, listJoinHi, REASON_HI, SLOT_HI, timeHi } from '../domain/hindi.js';
import { OrderOut, openOrders, orderOut, orderSentence } from './refills.js';
import { careStatus, doseOut, supplyOut, todayContext } from './status.js';
import { sendDailySummary } from '../notify/digest.js';
import { CARE_DASHBOARD_URI, uiMeta } from './apps.js';
import { CareError, guarded, ok, requireRole, resolveCaller, subject, type Deps } from './context.js';

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

const SLOT_PHRASE: Record<Slot, string> = {
  morning: 'this morning',
  noon: 'at lunchtime',
  evening: 'this evening',
  night: 'tonight'
};

function medLabel(d: { name: string }) {
  return d.name;
}

/* ---------- Tools ---------- */

export function registerTools(server: McpServer, deps: Deps): void {
  /* get_care_status */
  server.registerTool(
    'get_care_status',
    {
      title: "Today's care status",
      description:
        "Summarise the care recipient's day: which medication doses are taken, due, upcoming or missed, the next dose, visits, booked appointments, the latest wellbeing note, and medicines running low. Use for 'How is Mom today?', 'Good morning', 'What's happening today?'. Read-only.",
      inputSchema: z.object({
        date: DateString.optional().describe('Family-local date, YYYY-MM-DD. Defaults to today.'),
        detail: z.enum(['brief', 'full']).default('brief').describe('brief for a one-breath spoken answer, full for more detail')
      }),
      outputSchema: z.object({
        date: z.string(),
        isToday: z.boolean(),
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
        appointments: z
          .array(
            z.object({
              id: z.string(),
              date: z.string(),
              time: z.string(),
              purpose: z.string(),
              place: z.string(),
              driver: z.string().optional(),
              leaveAt: z.string().optional()
            })
          )
          .describe('Booked appointments from today through the next week'),
        latestWellbeing: z
          .object({ note: z.string(), severity: z.string(), date: z.string(), time: z.string(), redFlag: z.boolean() })
          .nullable(),
        refillAlerts: z.array(SupplyOut),
        missedLast7Days: z.number()
      }),
      annotations: { title: "Today's care status", readOnlyHint: true, openWorldHint: false },
      // The dashboard re-reads status after the person taps Mark taken.
      _meta: uiMeta(['model', 'app'], CARE_DASHBOARD_URI)
    },
    guarded(async ({ date, detail }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const { structured, speech } = await careStatus(deps, caller, date ?? caller.local.date, detail);
      return ok(structured, speech);
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
      annotations: { title: 'Medication schedule', readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
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

      let speech: string;
      if (caller.lang === 'hi') {
        const whom = caller.isRecipient ? 'आपको' : `${caller.recipient.name} को`;
        if (when) {
          speech = medications.length
            ? `आज ${SLOT_HI[when]} ${timeHi(caller.family.slots[when]).split(' ').slice(1).join(' ')} ${whom} लेनी है: ${listJoinHi(medications.map(m => `${m.name} ${m.strength}`))}।`
            : `${SLOT_HI[when]} के लिए कोई दवा नहीं है।`;
        } else {
          speech = `${whom} ${medications.length} दवाइयाँ लेनी होती हैं: ${listJoinHi(medications.map(m => m.name))}।`;
        }
      } else if (when) {
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
      return ok({ when: when ?? null, medications }, sentences(speech));
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
      annotations: { title: 'Log a dose', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      // The dashboard's Mark taken button calls this directly.
      _meta: uiMeta(['model', 'app'])
    },
    guarded(async ({ spoken_name, medication_ids, slot, status, taken_at }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      requireRole(caller, ['recipient', 'coordinator', 'helper'], 'log doses');
      const day = caller.local.date;
      const { meds, states } = await todayContext(deps, caller, day);
      const base = { date: day, logged: [], alreadyLogged: [], options: [], nextDose: null };
      const who = subject(caller);
      const hi = caller.lang === 'hi';

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
            hi
              ? `मैं "${spoken_name}" को किसी दवा से नहीं मिला पाई। ${caller.isRecipient ? 'आपकी' : `${caller.recipient.name} की`} दवाइयाँ हैं ${listJoinHi(meds.map(m => m.name))}। कौन-सी थी?`
              : `I couldn't match "${spoken_name}" to a medicine. ${caller.isRecipient ? 'Your' : `${caller.recipient.name}'s`} medicines are ${listJoin(meds.map(m => m.name))}. Which one was it?`
          );
        }
        if (match.kind === 'ambiguous') {
          return ok(
            { ...base, result: 'needs_clarification' as const, options: match.matches.map(m => ({ id: m.id, name: m.name, purpose: m.purpose })) },
            hi
              ? `क्या आपका मतलब ${listJoinHi(match.matches.map(m => m.name), 'या')} से था?`
              : `Did you mean ${listJoin(match.matches.map(m => `${m.name} for ${m.purpose}`), 'or')}?`
          );
        }
        targets = match.matches;
      } else {
        const chosenSlot = slot ?? slotToLog(states, caller.family, caller.now);
        if (!chosenSlot) {
          const next = states.find(s => s.status === 'upcoming') ?? null;
          return ok(
            { ...base, result: 'nothing_due' as const, nextDose: next ? doseOut(next) : null },
            hi
              ? next
                ? `अभी कोई दवा बाकी नहीं है। अगली दवा ${next.name} है, ${timeHi(next.time)}।`
                : 'आज की सारी खुराक पहले ही दर्ज हैं।'
              : next
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
      if (hi) {
        if (logged.length) {
          const slotsLogged = [...new Set(logged.map(l => l.slot))];
          const when = slotsLogged.length === 1 ? `${SLOT_HI[slotsLogged[0]]} की ` : '';
          const skipped = status === 'skipped' ? ' छोड़ी गई के रूप में' : '';
          parts.push(
            caller.isRecipient
              ? `ठीक है। मैंने ${when}${listJoinHi(logged.map(medLabel))}${skipped} दर्ज कर ली है।`
              : `ठीक है। ${caller.recipient.name} के लिए ${when}${listJoinHi(logged.map(medLabel))}${skipped} दर्ज कर ली है।`
          );
        }
        if (alreadyLogged.length) parts.push(`${listJoinHi(alreadyLogged.map(medLabel))} पहले से दर्ज है।`);
        if (next) parts.push(`अगली दवा ${next.name} है, ${timeHi(next.time)}।`);
        else if (logged.length) parts.push(`आज की सारी दवाइयाँ हो गईं${caller.isRecipient ? ', शाबाश' : ''}।`);
      } else if (logged.length) {
        const slotsLogged = [...new Set(logged.map(l => l.slot))];
        const when = slotsLogged.length === 1 ? ` for ${SLOT_PHRASE[slotsLogged[0]].replace('this ', 'the ').replace('tonight', 'tonight').replace('at lunchtime', 'lunchtime')}` : '';
        parts.push(
          caller.isRecipient
            ? `Got it. I've logged ${listJoin(logged.map(medLabel))}${when}${status === 'skipped' ? ' as skipped' : ''}.`
            : `Got it. Logged ${listJoin(logged.map(medLabel))}${when} for ${caller.recipient.name}${status === 'skipped' ? ' as skipped' : ''}.`
        );
      }
      if (!hi) {
        if (alreadyLogged.length) parts.push(`${listJoin(alreadyLogged.map(medLabel))} ${alreadyLogged.length === 1 ? 'was' : 'were'} already logged.`);
        if (next) parts.push(`Next is ${next.name} at ${spokenTime(next.time)}.`);
        else if (logged.length) parts.push(`That's everything for today${caller.isRecipient ? ', well done' : ''}.`);
      }

      return ok(
        {
          result: logged.length ? ('logged' as const) : ('already_logged' as const),
          date: day,
          logged,
          alreadyLogged,
          options: [],
          nextDose: next ? doseOut(next) : null
        },
        sentences(...parts) || (hi ? 'अभी दर्ज करने को कुछ नहीं है।' : `${who.has} nothing to log right now.`)
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
      annotations: { title: 'Check medicine supply', readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
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
      const speech = caller.lang === 'hi'
        ? alerts.length
          ? sentences(
              ...alerts.flatMap(a => {
                const order = orders.get(a.medicationId);
                const line =
                  a.daysLeft === 0
                    ? `${a.name} ${a.strength} खत्म हो गई है या एक दिन से कम की बची है।`
                    : `${a.name} ${a.strength} लगभग ${a.daysLeft} दिन की बची है, ${dateHi(a.runsOutOn, caller.local.date)} तक चलेगी।`;
                return order ? [line, orderSentence(order, caller.now, caller.local.date, 'hi')] : [line];
              }),
              unordered.length > 0 &&
                `यह ${unordered[0].pharmacy.name} से आती है।${caller.member.role === 'helper' ? '' : ' क्या मैं इसे दोबारा मंगा दूँ?'}`
            )
          : `${caller.isRecipient ? 'आपकी' : `${caller.recipient.name} की`} सभी दवाइयाँ ${within_days} दिन से ज़्यादा चलेंगी।`
        : alerts.length
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
        note: z
          .string()
          .min(1)
          .max(500)
          .describe("What was said, in plain English words (translate if the person spoke another language), e.g. 'feeling dizzy since lunch'"),
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
      annotations: { title: 'Log how they feel', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(['model'])
    },
    guarded(async ({ note, severity }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const check = safetyCheck(note);
      const level = check.redFlag ? 'high' : (severity ?? 'low');
      const local = localParts(caller.now, caller.family.timezone);
      // Unique even with a frozen demo clock: screens announce each alert once, by id.
      const id = `well-${caller.now.getTime()}-${randomUUID().slice(0, 8)}`;
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
      if (caller.lang === 'hi') {
        const familyHi = listJoinHi(others.map(m => m.name)) || 'परिवार';
        const reason = check.reasons[0];
        speech = check.redFlag
          ? sentences(
              caller.isRecipient ? 'मैंने यह दर्ज कर लिया है।' : `मैंने ${caller.recipient.name} के लिए यह दर्ज कर लिया है।`,
              `${REASON_HI[reason] ?? reason} गंभीर हो सकता है।`,
              'अगर तकलीफ़ ज़्यादा है या अचानक हुई है, तो अभी इमरजेंसी सेवा को फ़ोन करें।',
              `${familyHi} को यह नोट तुरंत दिखेगा।`
            )
          : level === 'medium'
            ? sentences('बताने के लिए धन्यवाद, मैंने नोट कर लिया है।', 'अगर तकलीफ़ बढ़े या ठीक न हो, तो डॉक्टर को फ़ोन करें।', `${familyHi} इसे आज के अपडेट में देख सकते हैं।`)
            : sentences('धन्यवाद, मैंने इसे आज के नोट्स में जोड़ दिया है।', `${familyHi} इसे आज के अपडेट में देख सकते हैं।`);
      } else if (check.redFlag) {
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

  /* set_language */
  server.registerTool(
    'set_language',
    {
      title: 'Change the spoken language',
      description:
        "Change the language CareCircle uses when speaking to this person: 'en' for English, 'hi' for Hindi. Use for 'Talk to me in Hindi', 'हिंदी में बात करो' or 'Speak English'. Only changes the caller's own preference; the rest of the family keeps theirs.",
      inputSchema: z.object({ language: z.enum(LANGUAGES).describe('en = English, hi = Hindi') }),
      outputSchema: z.object({ language: z.enum(LANGUAGES), member: z.object({ id: z.string(), name: z.string() }) }),
      annotations: { title: 'Change the spoken language', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
    },
    guarded(async ({ language }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      await deps.store.setMemberLanguage(caller.member.id, language);
      return ok(
        { language, member: { id: caller.member.id, name: caller.member.name } },
        language === 'hi' ? `ठीक है ${caller.member.name} जी, अब मैं आपसे हिंदी में बात करूँगी।` : `Okay ${caller.member.name}, I'll speak English from now on.`
      );
    })
  );

  /* send_daily_summary */
  server.registerTool(
    'send_daily_summary',
    {
      title: "Send today's summary to the family",
      description:
        "Send the family a short written summary of the care recipient's day: doses taken and missed, alerts, notes, supplies and visits. It goes to everyone except the care recipient, in the CareCircle app and by email or text when set up. It is also sent automatically every evening. Use for 'Send everyone today's summary'.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        to: z.array(z.object({ id: z.string(), name: z.string() })),
        delivery: z.object({ inbox: z.boolean(), sns: z.enum(['sent', 'failed', 'off']) })
      }),
      annotations: { title: "Send today's summary", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: uiMeta(['model'])
    },
    guarded(async (_args, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const message = await sendDailySummary(deps, caller.family.id, caller.member.id);
      const members = await deps.store.listMembers(caller.family.id);
      const to = message.to.map(id => ({ id, name: members.find(m => m.id === id)?.name ?? id }));
      const names = to.map(t => t.name);
      const where =
        message.delivery.sns === 'sent' ? ' by email and in the CareCircle app' : message.delivery.sns === 'failed' ? ' in the CareCircle app; the email could not be sent' : ' in the CareCircle app';
      const speech =
        caller.lang === 'hi'
          ? `हो गया। मैंने आज का सारांश ${listJoinHi(names)} को भेज दिया है।`
          : `Done. I've sent today's summary to ${listJoin(names)}${where}.`;
      return ok({ id: message.id, title: message.title, text: message.text, to, delivery: { inbox: true, sns: message.delivery.sns } }, speech);
    })
  );
}
