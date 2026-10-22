/**
 * Today's care status, shared by the get_care_status tool and the subscribable
 * `carecircle://family/{id}/today` resource. Spoken text follows the caller's language.
 */
import type { Slot } from '../store/types.js';
import { doseStates, refillAlerts, safetyCheck, supply, type DoseState } from '../domain/care.js';
import { addDays, spokenDate, spokenTime, toMinutes } from '../domain/time.js';
import { countWord, greeting, listJoin, plural, sentences } from '../domain/speech.js';
import { dateHi, listJoinHi, REASON_HI, SLOT_HI, timeHi, willComeHi } from '../domain/hindi.js';
import { openOrders, orderOut, orderSentence } from './refills.js';
import { subject, type Caller, type Deps } from './context.js';

export function doseOut(d: DoseState) {
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

export function supplyOut(s: ReturnType<typeof supply>) {
  return {
    medicationId: s.medicationId,
    name: s.name,
    strength: s.strength,
    pillsOnHand: s.pillsOnHand,
    daysLeft: s.daysLeft,
    runsOutOn: s.runsOutOn
  };
}

export async function todayContext(deps: Deps, caller: Caller, date: string) {
  const meds = await deps.store.listMedications(caller.family.id);
  const logs = await deps.store.listDoseLogs(caller.family.id, date, date);
  const states = doseStates(caller.family, meds, logs, date, caller.now);
  return { meds, logs, states };
}

const possessive = (pronoun: string | undefined) => (pronoun === 'he' ? 'his' : pronoun === 'she' ? 'her' : 'their');

/** Structured status (the get_care_status output) plus its spoken summary. */
export async function careStatus(deps: Deps, caller: Caller, day: string, detail: 'brief' | 'full') {
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
  const memberOf = (id: string) => members.find(m => m.id === id);
  const rawVisits = (await deps.store.listVisits(caller.family.id, day, day)).filter(v => v.kind !== 'appointment');
  const visits = rawVisits.map(v => ({ who: memberOf(v.who)?.name ?? v.who, time: v.time, purpose: v.purpose }));
  // Booked appointments from today through the next week, with who drives.
  const rides = await deps.store.listHelperTasks(caller.family.id, day, addDays(day, APPOINTMENT_DAYS));
  const appointments = (await deps.store.listVisits(caller.family.id, day, addDays(day, APPOINTMENT_DAYS)))
    .filter(v => v.kind === 'appointment')
    .map(v => {
      const ride = rides.find(t => t.visitId === v.id);
      return {
        id: v.id,
        date: v.date,
        time: v.time,
        purpose: v.purpose,
        place: v.place ?? '',
        ...(ride ? { driver: memberOf(ride.assigneeId)?.name ?? ride.assigneeId, leaveAt: ride.time } : {})
      };
    });
  const notes = await deps.store.listWellbeing(caller.family.id, addDays(day, -1), day);
  const latest = notes.at(-1);
  const alerts = refillAlerts(meds, caller.local.date);
  const orders = await openOrders(deps, caller);

  const weekLogs = await deps.store.listDoseLogs(caller.family.id, addDays(caller.local.date, -7), addDays(caller.local.date, -1));
  let missedLast7Days = 0;
  for (let i = 1; i <= 7; i++) {
    missedLast7Days += doseStates(caller.family, meds, weekLogs, addDays(caller.local.date, -i), caller.now).filter(s => s.status === 'missed').length;
  }

  const isToday = day === caller.local.date;
  const due = states.filter(d => d.status === 'due');
  const missedToday = states.filter(d => d.status === 'missed');
  const showNote = latest && (detail === 'full' || latest.date === caller.local.date);
  const firstAlert = alerts[0];
  const firstOrder = firstAlert ? orders.get(firstAlert.medicationId) : undefined;

  const parts: string[] = [];
  if (caller.lang === 'hi') {
    const name = caller.recipient.name;
    if (caller.isRecipient && isToday) parts.push(`${caller.local.minutes < 12 * 60 ? 'सुप्रभात' : 'नमस्ते'}, ${name} जी।`);
    if (isToday) {
      const doer = caller.isRecipient ? 'आपने' : `${name} ने`;
      const own = caller.isRecipient ? 'अपनी ' : '';
      parts.push(
        counts.taken === 0
          ? `आज ${doer} अभी तक कोई खुराक नहीं ली है, कुल ${counts.total} हैं।`
          : counts.taken === counts.total
            ? `आज ${doer} ${own}सभी ${counts.total} खुराक ले ली हैं।`
            : `आज ${doer} ${own}${counts.total} में से ${counts.taken} खुराक ले ली हैं।`
      );
      if (due.length) parts.push(`${listJoinHi(due.map(d => d.name))} अभी लेनी है।`);
      else if (next) parts.push(`अगली दवा ${next.name} है, ${timeHi(next.time)}।`);
      if (missedToday.length) parts.push(`अभी तक दर्ज नहीं हुई: ${listJoinHi(missedToday.map(d => `${SLOT_HI[d.slot]} की ${d.name}`))}।`);
    } else {
      parts.push(`${dateHi(day, caller.local.date)} ${caller.isRecipient ? 'आपने' : `${name} ने`} ${counts.total} में से ${counts.taken} खुराक लीं।`);
      if (missedToday.length) parts.push(`छूटी: ${listJoinHi(missedToday.map(d => d.name))}।`);
    }
    for (const v of rawVisits) {
      const who = memberOf(v.who);
      parts.push(`${who?.name ?? v.who} ${timeHi(v.time)} ${willComeHi(who?.pronoun)}।`);
    }
    for (const a of appointments.slice(0, 1)) parts.push(`${dateHi(a.date, caller.local.date)} ${timeHi(a.time)} ${a.place} में अपॉइंटमेंट है${a.driver ? `, ${a.driver} ले जाएँगे` : ''}।`);
    if (showNote) parts.push(`${caller.isRecipient ? 'आपने' : `${name} ने`} बताया था: ${latest.note.replace(/[.।]$/, '')}।`);
    if (firstAlert) {
      parts.push(`${firstAlert.name} कम है: लगभग ${firstAlert.daysLeft} दिन की बची है।`);
      if (firstOrder) parts.push(orderSentence(firstOrder, caller.now, caller.local.date, 'hi'));
    }
    if (detail === 'full') parts.push(`पिछले हफ़्ते ${missedLast7Days} खुराक छूटीं।`);
  } else {
    const who = subject(caller);
    if (caller.isRecipient && isToday) parts.push(`${greeting(caller.local.minutes)}, ${caller.recipient.name}.`);
    if (isToday) {
      const takenWord = counts.taken === counts.total ? 'all' : counts.taken === 0 ? 'none' : countWord(counts.taken);
      parts.push(
        caller.isRecipient
          ? `You've taken ${takenWord} of your ${plural(counts.total, 'dose')} today.`
          : `${who.has} taken ${takenWord} of ${possessive(caller.recipient.pronoun)} ${plural(counts.total, 'dose')} so far today.`
      );
      if (due.length) parts.push(`${listJoin(due.map(d => d.name))} ${due.length === 1 ? 'is' : 'are'} due now.`);
      else if (next) parts.push(`Next is ${next.name} at ${spokenTime(next.time)}.`);
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
    for (const a of appointments.slice(0, 1)) {
      const driving = a.driver ? (a.driver === caller.member.name ? ` You're driving.` : ` ${a.driver} is driving.`) : '';
      const when = spokenDate(a.date, caller.local.date);
      parts.push(`${a.purpose} ${when === 'today' || when === 'tomorrow' ? when : `on ${when}`} at ${spokenTime(a.time)}.${driving}`);
    }
    if (showNote) {
      const said = latest.note.replace(/\.$/, '');
      // Lower-case the first letter so it reads mid-sentence, but never the pronoun "I".
      const quoted = /^I\b/.test(said) ? said : said[0].toLowerCase() + said.slice(1);
      parts.push(
        caller.isRecipient
          ? `You mentioned: ${quoted}.`
          : `${who.pronoun === 'they' ? 'They' : who.pronoun[0].toUpperCase() + who.pronoun.slice(1)} mentioned: ${quoted}.`
      );
    }
    if (firstAlert) {
      parts.push(`${firstAlert.name} runs low: about ${plural(firstAlert.daysLeft, 'day')} left.`);
      if (firstOrder) parts.push(orderSentence(firstOrder, caller.now, caller.local.date));
    }
    if (detail === 'full') parts.push(`In the past week, ${plural(missedLast7Days, 'dose')} ${missedLast7Days === 1 ? 'was' : 'were'} missed.`);
  }

  const structured = {
    date: day,
    isToday,
    recipient: { id: caller.recipient.id, name: caller.recipient.name },
    counts,
    doses: states.map(doseOut),
    nextDose: next ? doseOut(next) : null,
    visits,
    appointments,
    latestWellbeing: latest ? { note: latest.note, severity: latest.severity, date: latest.date, time: latest.time, redFlag: latest.redFlag } : null,
    refillAlerts: await Promise.all(
      alerts.map(async a => {
        const order = orders.get(a.medicationId);
        return { ...supplyOut(a), order: order ? await orderOut(deps, order, caller.now) : null };
      })
    ),
    missedLast7Days
  };
  return { structured, speech: sentences(...parts) };
}

/** How far ahead get_care_status mentions booked appointments. */
export const APPOINTMENT_DAYS = 7;

/** A dose is worth a gentle reminder this long after its time, if it still isn't logged. */
export const REMINDER_AFTER_MIN = 30;

/**
 * Everything a screen needs to stay current: the status, today's safety alerts and,
 * for the person being cared for, a gentle reminder about overdue doses. The host
 * decides when to announce alerts and reminders; the server only says what they are.
 */
export async function todaySnapshot(deps: Deps, caller: Caller) {
  const day = caller.local.date;
  const status = await careStatus(deps, caller, day, 'brief');
  const members = await deps.store.listMembers(caller.family.id);
  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? id;
  const recipient = caller.recipient;
  const objectPronoun = recipient.pronoun === 'he' ? 'him' : recipient.pronoun === 'she' ? 'her' : 'them';

  const notes = await deps.store.listWellbeing(caller.family.id, day, day);
  const alerts = notes
    .filter(n => n.redFlag)
    .map(n => {
      const reasons = safetyCheck(n.note).reasons;
      const by = n.loggedBy === recipient.id ? recipient.name : nameOf(n.loggedBy);
      const reason = reasons[0] ?? 'a safety concern';
      const text =
        caller.lang === 'hi'
          ? sentences(`CareCircle अलर्ट: ${timeHi(n.time)} ${by} ने बताया: ${n.note.replace(/[.।]$/, '')}।`, `इसमें ${REASON_HI[reason] ?? reason} की बात है।`, caller.isRecipient ? '' : `कृपया ${recipient.name} से बात कर लें।`)
          : sentences(
              `CareCircle alert: at ${spokenTime(n.time)}, ${by === recipient.name ? `${recipient.name} said` : `${by} noted for ${recipient.name}`}: ${n.note.replace(/\.$/, '')}.`,
              `That mentions ${reason}.`,
              caller.isRecipient ? '' : `Please check on ${objectPronoun}.`
            );
      return { id: n.id, time: n.time, note: n.note, reasons, loggedBy: n.loggedBy, text };
    });

  let reminder = null;
  if (caller.isRecipient) {
    const overdue = status.structured.doses.filter(
      d => (d.status === 'due' || d.status === 'missed') && toMinutes(d.time) + REMINDER_AFTER_MIN <= caller.local.minutes
    );
    const slot = overdue[0]?.slot;
    if (slot) {
      const doses = overdue.filter(d => d.slot === slot);
      const names = doses.map(d => d.name);
      const time = doses[0].time;
      reminder = {
        key: `${day}:${slot}`,
        slot,
        time,
        medicationIds: doses.map(d => d.medicationId),
        text:
          caller.lang === 'hi'
            ? `${recipient.name} जी, एक छोटी-सी याद: ${timeHi(time)} की ${listJoinHi(names)} अभी दर्ज नहीं ${names.length === 1 ? 'हुई है' : 'हुई हैं'}। क्या आपने ${names.length === 1 ? 'ले ली है' : 'ले ली हैं'}?`
            : `${recipient.name}, a gentle reminder: your ${listJoin(names)} from ${spokenTime(time)} ${names.length === 1 ? "isn't" : "aren't"} logged yet. Have you taken ${names.length === 1 ? 'it' : 'them'}?`
      };
    }
  }

  return {
    viewer: { id: caller.member.id, name: caller.member.name, role: caller.member.role, language: caller.lang },
    status: status.structured,
    speech: status.speech,
    alerts,
    reminder,
    updatedAt: caller.now.toISOString()
  };
}
