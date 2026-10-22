/**
 * Morning check-in: the "is Mom up yet?" worry, handled gently.
 *
 * CareCircle learns when the person usually starts their day. If a morning goes quiet past
 * that, it first checks in with them on their own device. Only if they don't answer does it
 * tell the family, calmly and with the context, and it tells them again when she answers.
 * The family can pause check-ins (a stay away, a hospital visit) and they resume by themselves;
 * turning them off for good needs a clear yes.
 *
 * CareCircle is not an emergency service and never says it is.
 */
import * as z from 'zod';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { CheckIn, CheckInSettings } from '../store/types.js';
import {
  firstByDay,
  isPaused,
  LATE_BY_MIN,
  MAX_PAUSE_DAYS,
  nextStep,
  readUntil,
  settingsOrDefault,
  usualTime,
  week,
  RHYTHM_DAYS,
  type RhythmDay
} from '../domain/rhythm.js';
import { addDays, daysBetween, localParts, spokenDate, spokenTime, toMinutes, weekdayName } from '../domain/time.js';
import { listJoin, sentences } from '../domain/speech.js';
import { uiMeta } from './apps.js';
import { callerFor, CareError, guarded, ok, resolveCaller, type Caller, type Deps } from './context.js';
import { speakerFrom } from './identity.js';

/* ---------- reading the rhythm ---------- */

/** Every first-activity time per day for the person being cared for, over the past two weeks and today. */
async function firsts(deps: Deps, familyId: string, recipientId: string, today: string): Promise<Map<string, string>> {
  const from = addDays(today, -RHYTHM_DAYS);
  const [doses, notes, activity] = await Promise.all([
    deps.store.listDoseLogs(familyId, from, today),
    deps.store.listWellbeing(familyId, from, today),
    deps.store.listActivity(familyId, from, today)
  ]);
  const family = await deps.store.getFamily(familyId);
  const tz = family!.timezone;
  const events = [
    ...doses.filter(d => d.loggedBy === recipientId).map(d => localParts(new Date(d.at), tz)),
    ...notes.filter(n => n.loggedBy === recipientId).map(n => ({ date: n.date, time: n.time })),
    ...activity.filter(a => a.memberId === recipientId).map(a => ({ date: a.date, time: a.time }))
  ];
  return firstByDay(events);
}

export interface Rhythm {
  today: string;
  usual: string | undefined;
  firstToday: string | undefined;
  week: RhythmDay[];
  settings: CheckInSettings;
  checkIn: CheckIn | undefined;
}

export async function readRhythm(deps: Deps, caller: Caller): Promise<Rhythm> {
  const familyId = caller.family.id;
  const today = caller.local.date;
  const byDay = await firsts(deps, familyId, caller.recipient.id, today);
  const usual = usualTime(byDay, today);
  const settings = settingsOrDefault(familyId, await deps.store.getCheckInSettings(familyId));
  const checkIn = (await deps.store.listCheckIns(familyId, today, today))[0];
  // Only what has happened by now counts for today (the demo clock can be moved, history can't).
  const firstToday = byDay.get(today);
  return { today, usual, firstToday: firstToday && firstToday <= caller.local.time ? firstToday : undefined, week: week(byDay, today, usual), settings, checkIn };
}

/* ---------- what gets said ---------- */

function vsUsual(first: string, usual: string | undefined): string {
  if (!usual) return '';
  const diff = toMinutes(first) - toMinutes(usual);
  if (Math.abs(diff) < 20) return ', around the usual time';
  return diff < 0 ? ', a bit earlier than usual' : `, later than usual (usually by ${spokenTime(usual)})`;
}

function pausedSentence(s: CheckInSettings, today: string): string {
  const resume = addDays(s.pausedUntil!, 1);
  return `Morning check-ins are paused${s.pauseReason ? ` (${s.pauseReason.replace(/\.$/, '')})` : ''} and start again ${spokenDate(resume, today)}.`;
}

function weekSentence(r: Rhythm, caller: Caller): string {
  const you = caller.isRecipient;
  const name = you ? 'your' : `${caller.recipient.name}'s`;
  if (!r.usual) return `I don't know ${name} usual morning yet; I need about a week of mornings first.`;
  const p = caller.recipient.pronoun;
  const subj = you ? 'you have' : `${p === 'he' ? 'he has' : p === 'she' ? 'she has' : 'they have'}`;
  const poss = you ? 'your' : p === 'he' ? 'his' : p === 'she' ? 'her' : 'their';
  const obj = you ? 'you' : p === 'he' ? 'him' : p === 'she' ? 'her' : 'them';
  const past = r.week.filter(d => d.date < r.today);
  const late = past.filter(d => d.late);
  const quiet = past.filter(d => !d.first);
  const head = `This week ${subj} usually been up by ${spokenTime(r.usual)}`;
  const was = you ? 'you were' : p === 'he' || p === 'she' ? `${p} was` : 'they were';
  const notes = [
    late.length ? `${was} later than usual on ${listJoin(late.map(d => `${weekdayName(d.date)}, at ${spokenTime(d.first!)}`))}` : '',
    quiet.length ? `there was nothing from ${obj} on ${listJoin(quiet.map(d => weekdayName(d.date)))}` : ''
  ].filter(Boolean);
  return notes.length ? `${head}, but ${notes.join(', and ')}.` : `${head}, and ${poss} mornings have been regular.`;
}

export function rhythmSpeech(r: Rhythm, caller: Caller): string {
  const you = caller.isRecipient;
  const name = you ? 'you' : caller.recipient.name;
  let today: string;
  if (r.firstToday) {
    today = you ? `You were up and about at ${spokenTime(r.firstToday)} this morning${vsUsual(r.firstToday, r.usual)}.` : `Yes, ${name} was up and about at ${spokenTime(r.firstToday)} this morning${vsUsual(r.firstToday, r.usual)}.`;
    if (r.checkIn?.answeredTime) today = `${name === 'you' ? 'You' : name} answered my check-in at ${spokenTime(r.checkIn.answeredTime)}.`;
  } else if (r.checkIn?.stage === 'family_told') {
    today = `I haven't heard from ${name} yet this morning. I checked in at ${spokenTime(r.checkIn.askedTime)} with no answer, and told the family at ${spokenTime(r.checkIn.familyToldTime!)}.`;
  } else if (r.checkIn) {
    today = `I haven't heard from ${name} yet this morning. I checked in on ${you ? 'your' : 'her'} device at ${spokenTime(r.checkIn.askedTime)} and I'm waiting for an answer.`;
  } else if (r.usual && r.settings.enabled && !isPaused(r.settings, r.today)) {
    today = `Not yet this morning. ${name === 'you' ? 'You are' : `${name} is`} usually up by ${spokenTime(r.usual)}; if I haven't heard anything by ${spokenTime(addMinutes(r.usual, r.settings.graceMinutes))}, I'll check in.`;
  } else {
    today = `I haven't heard from ${name} yet this morning.`;
  }
  const status = !r.settings.enabled ? 'Morning check-ins are turned off.' : isPaused(r.settings, r.today) ? pausedSentence(r.settings, r.today) : '';
  return sentences(today, weekSentence(r, caller), status);
}

function addMinutes(time: string, minutes: number): string {
  const m = toMinutes(time) + minutes;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** What the person's device says when CareCircle checks in. */
export function askText(name: string): string {
  return `Good morning, ${name}. Just checking in, as I haven't heard from you yet this morning. How are you feeling today?`;
}

function familyText(name: string, pronoun: string, c: CheckIn): string {
  const obj = pronoun === 'he' ? 'him' : pronoun === 'she' ? 'her' : 'them';
  return `CareCircle check-in: ${name} hasn't been active this morning. ${pronoun === 'they' ? 'They are' : `${pronoun[0].toUpperCase()}${pronoun.slice(1)} is`} usually up by ${spokenTime(c.usual)}, and didn't answer when I checked in at ${spokenTime(c.askedTime)}. You might give ${obj} a call. CareCircle is not an emergency service; if you think something is wrong, call emergency services.`;
}

function answeredText(name: string, c: CheckIn): string {
  return `Good news: ${name} answered at ${spokenTime(c.answeredTime!)}. No need to worry about this morning.`;
}

/** Check-in lines for the `today` resource, so devices announce them like any alert. */
export async function checkInAlerts(deps: Deps, caller: Caller) {
  const c = (await deps.store.listCheckIns(caller.family.id, caller.local.date, caller.local.date))[0];
  if (!c) return [];
  const name = caller.recipient.name;
  const pronoun = caller.recipient.pronoun ?? 'they';
  const base = { note: '', reasons: [] as string[], kind: 'check_in' as const };
  if (caller.isRecipient) {
    if (c.answeredAt) return [];
    return [{ ...base, id: `checkin-ask-${c.date}`, time: c.askedTime, loggedBy: 'carecircle', text: askText(name) }];
  }
  const out = [];
  if (c.familyToldAt) out.push({ ...base, id: `checkin-family-${c.date}`, time: c.familyToldTime!, loggedBy: caller.recipient.id, text: familyText(name, pronoun, c) });
  if (c.familyToldAt && c.answeredAt) out.push({ ...base, id: `checkin-ok-${c.date}`, time: c.answeredTime!, loggedBy: caller.recipient.id, text: answeredText(name, c) });
  return out;
}

/** One line for the evening summary. */
export async function digestLine(deps: Deps, caller: Caller): Promise<string | undefined> {
  const r = await readRhythm(deps, caller);
  const name = caller.recipient.name;
  if (r.checkIn?.familyToldAt) {
    return `Morning: ${name} was quiet; CareCircle checked in at ${spokenTime(r.checkIn.askedTime)} and told the family at ${spokenTime(r.checkIn.familyToldTime!)}.${r.checkIn.answeredTime ? ` ${name} answered at ${spokenTime(r.checkIn.answeredTime)}.` : ''}`;
  }
  if (r.firstToday && r.usual) return `Morning: up at ${spokenTime(r.firstToday)} (usually by ${spokenTime(r.usual)}).`;
  return undefined;
}

/* ---------- the schedule ---------- */

/** Moves one family's check-in on, if anything is due. Returns what happened, for tests and logs. */
export async function runCheckIn(deps: Deps, familyId: string): Promise<'asked' | 'family_told' | 'answered' | 'none'> {
  const family = await deps.store.getFamily(familyId);
  if (!family) return 'none';
  const caller = await callerFor(family.recipientId, deps);
  const r = await readRhythm(deps, caller);
  const step = nextStep({ settings: r.settings, today: r.today, nowMinutes: caller.local.minutes, usual: r.usual, firstToday: r.firstToday, existing: r.checkIn });
  const now = caller.now.toISOString();
  const others = (await deps.store.listMembers(familyId)).filter(m => m.id !== family.recipientId).map(m => m.id);
  const name = caller.recipient.name;
  const pronoun = caller.recipient.pronoun ?? 'they';

  const tell = async (c: CheckIn, title: string, text: string) => {
    if (!deps.notifier) return;
    await deps.notifier.send({ id: `msg-checkin-${c.date}-${caller.now.getTime()}`, familyId, kind: 'check_in', date: c.date, title, text, to: others, sentAt: now, sentBy: 'schedule' });
  };

  switch (step.kind) {
    case 'ask':
      await deps.store.saveCheckIn({ id: `checkin-${familyId}-${r.today}`, familyId, date: r.today, usual: step.usual, stage: 'asked', askedAt: now, askedTime: caller.local.time });
      return 'asked';
    case 'tell_family': {
      const c: CheckIn = { ...r.checkIn!, stage: 'family_told', familyToldAt: now, familyToldTime: caller.local.time };
      await deps.store.saveCheckIn(c);
      await tell(c, `Checking on ${name} this morning`, familyText(name, pronoun, c));
      return 'family_told';
    }
    case 'answered': {
      const c: CheckIn = { ...r.checkIn!, answeredAt: now, answeredTime: r.firstToday! >= r.checkIn!.askedTime ? r.firstToday! : caller.local.time };
      await deps.store.saveCheckIn(c);
      if (c.familyToldAt) await tell(c, `${name} is fine`, answeredText(name, c));
      return 'answered';
    }
    default:
      return 'none';
  }
}

/** Called every minute (and right after the demo clock moves): every family's check-in. */
export async function runCheckInSchedule(deps: Deps): Promise<void> {
  for (const family of await deps.store.listFamilies()) await runCheckIn(deps, family.id);
}

/**
 * Notes that the person being cared for spoke to CareCircle, so their morning counts as
 * started, and closes an open check-in straight away. Only for a voice CareCircle is sure of.
 */
export function installActivityTracker(server: McpServer, deps: Deps): void {
  type Handler = (request: { params?: { name?: unknown } }, ctx: ServerContext) => Promise<CallToolResult>;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const toolsCall = handlers.get('tools/call');
  if (!toolsCall) throw new Error('installActivityTracker: register tools first');
  handlers.set('tools/call', async (request, ctx) => {
    const result = await toolsCall(request, ctx);
    if (speakerFrom(ctx).confidence !== 'high' || result?.isError) return result;
    try {
      const caller = await resolveCaller(ctx, deps);
      if (caller.isRecipient) {
        await deps.store.addActivity({
          familyId: caller.family.id,
          memberId: caller.member.id,
          at: caller.now.toISOString(),
          date: caller.local.date,
          time: caller.local.time,
          via: String(request.params?.name ?? '')
        });
        await runCheckIn(deps, caller.family.id);
      }
    } catch (err) {
      console.warn('[carecircle] could not note activity', err);
    }
    return result;
  });
}

/* ---------- tools ---------- */

const DayOut = z.object({
  date: z.string(),
  first: z.string().optional().describe('HH:MM of the first activity; absent for a morning with nothing from them'),
  vsUsual: z.number().optional().describe('Minutes after the usual time, negative when earlier'),
  late: z.boolean()
});
const SettingsOut = z.object({ enabled: z.boolean(), pausedUntil: z.string().optional(), pauseReason: z.string().optional() });

function settingsOut(s: CheckInSettings) {
  return { enabled: s.enabled, ...(s.pausedUntil ? { pausedUntil: s.pausedUntil } : {}), ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}) };
}

export function registerCheckInTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'get_morning_rhythm',
    {
      title: 'Morning rhythm and check-ins',
      description:
        "Whether the care recipient has been up and about this morning, compared with their usual time, how their mornings have been this week (later than usual, quiet mornings), and the state of morning check-ins. Use for 'Has Mom been up this morning?', 'Is Mom up yet?', 'How have Mom's mornings been?', 'Are check-ins on?'.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        usual: z.string().optional().describe('HH:MM they are usually up by; absent until there is enough history'),
        firstToday: z.string().optional().describe('HH:MM of their first activity today'),
        checkIn: z.enum(['none', 'asked', 'family_told', 'answered']),
        week: z.array(DayOut),
        lateMinutes: z.number().describe(`A morning at least this many minutes after the usual time counts as late (${LATE_BY_MIN})`),
        settings: SettingsOut
      }),
      annotations: { title: 'Morning rhythm and check-ins', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
    },
    guarded(async (_args, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const r = await readRhythm(deps, caller);
      const checkIn = !r.checkIn ? 'none' : r.checkIn.answeredAt ? 'answered' : r.checkIn.stage;
      return ok(
        {
          ...(r.usual ? { usual: r.usual } : {}),
          ...(r.firstToday ? { firstToday: r.firstToday } : {}),
          checkIn,
          week: r.week.map(d => ({ date: d.date, ...(d.first ? { first: d.first } : {}), ...(d.vsUsual !== null ? { vsUsual: d.vsUsual } : {}), late: d.late })),
          lateMinutes: LATE_BY_MIN,
          settings: settingsOut(r.settings)
        },
        rhythmSpeech(r, caller)
      );
    })
  );

  server.registerTool(
    'set_check_ins',
    {
      title: 'Pause or change morning check-ins',
      description:
        "Pause, resume, turn off or turn on morning check-ins (CareCircle checks in when the care recipient's morning goes quiet, and tells the family if there's no answer). Use pause for a stay away or a hospital visit: 'Mom's staying with me till Sunday' (until: 'Sunday'); check-ins start again by themselves the day after. turn_off stops them until someone turns them on again; it needs confirm true after a clear yes. Anyone in the family, including the care recipient, can do any of these.",
      inputSchema: z.object({
        action: z.enum(['pause', 'resume', 'turn_off', 'turn_on']),
        until: z.string().max(40).optional().describe("For pause: the last day to pause, as said ('Sunday', 'tomorrow', 'next week', '3 days') or YYYY-MM-DD"),
        reason: z.string().max(120).optional().describe("For pause: why, as said, e.g. 'staying with Sam'"),
        confirm: z.boolean().default(false).describe('For turn_off: true only after the person clearly said yes')
      }),
      outputSchema: z.object({
        result: z.enum(['paused', 'resumed', 'turned_off', 'turned_on', 'needs_confirmation', 'needs_detail']),
        settings: SettingsOut
      }),
      annotations: { title: 'Pause or change morning check-ins', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: uiMeta(['model'])
    },
    guarded(async ({ action, until, reason, confirm }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const familyId = caller.family.id;
      const today = caller.local.date;
      const current = settingsOrDefault(familyId, await deps.store.getCheckInSettings(familyId));
      const name = caller.isRecipient ? 'your' : `${caller.recipient.name}'s`;
      const save = async (patch: Partial<CheckInSettings>) => {
        const next: CheckInSettings = { ...current, ...patch, familyId, setBy: caller.member.id, setAt: caller.now.toISOString() };
        if (!next.pausedUntil) delete next.pausedUntil;
        if (!next.pauseReason) delete next.pauseReason;
        await deps.store.setCheckInSettings(next);
        return next;
      };

      if (action === 'pause') {
        const day = until ? readUntil(until, today) : undefined;
        if (!day) {
          return ok({ result: 'needs_detail' as const, settings: settingsOut(current) }, `Until when should I pause ${name} morning check-ins? For example, until Sunday.`);
        }
        if (daysBetween(today, day) > MAX_PAUSE_DAYS) {
          throw new CareError(`I can pause check-ins for up to ${MAX_PAUSE_DAYS} days at a time. To stop them for longer, ask me to turn them off.`);
        }
        // "Staying with me" is said by whoever paused; others should hear who that was.
        const why = reason?.trim().replace(/\bwith me\b/i, `with ${caller.member.name}`);
        const next = await save({ pausedUntil: day, pauseReason: why || undefined });
        return ok(
          { result: 'paused' as const, settings: settingsOut(next) },
          `Okay. I've paused ${name} morning check-ins through ${spokenDate(day, today)}. They start again ${spokenDate(addDays(day, 1), today)} by themselves.`
        );
      }
      if (action === 'resume') {
        const next = await save({ pausedUntil: undefined, pauseReason: undefined, enabled: true });
        return ok({ result: 'resumed' as const, settings: settingsOut(next) }, `Morning check-ins are back on for ${caller.isRecipient ? 'you' : caller.recipient.name}.`);
      }
      if (action === 'turn_on') {
        const next = await save({ enabled: true });
        return ok({ result: 'turned_on' as const, settings: settingsOut(next) }, `Morning check-ins are on. If ${caller.isRecipient ? 'your' : `${caller.recipient.name}'s`} morning goes quiet, I'll check in, and tell the family if there's no answer.`);
      }
      // turn_off
      if (!confirm) {
        return ok(
          { result: 'needs_confirmation' as const, settings: settingsOut(current) },
          `Turn off ${name} morning check-ins? Nobody will be told about a quiet morning until they're turned on again. If it's only for a while, I can pause them instead. Should I turn them off?`
        );
      }
      const next = await save({ enabled: false, pausedUntil: undefined, pauseReason: undefined });
      return ok({ result: 'turned_off' as const, settings: settingsOut(next) }, `Okay, morning check-ins are off. Ask me any time to turn them back on.`);
    })
  );
}
