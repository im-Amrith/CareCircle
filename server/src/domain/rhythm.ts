/**
 * Morning rhythm: when the person being cared for usually starts their day, and what to do
 * when a morning goes quiet. Pure functions; the store and the clock come from the caller.
 *
 * "Active" means they did something themselves: logged a dose, said how they feel, or spoke
 * to CareCircle. Someone else logging a dose for them doesn't count.
 */
import type { CheckIn, CheckInSettings } from '../store/types.js';
import { addDays, toMinutes, weekdayName } from './time.js';

/** Days of history the usual time is worked out from. */
export const RHYTHM_DAYS = 14;
/** Fewer mornings than this and there is no usual time yet, so no check-ins. */
export const MIN_MORNINGS = 5;
/** A morning this much later than usual is called out in the week's rhythm. */
export const LATE_BY_MIN = 45;
/** Longest pause someone can ask for, so a forgotten pause never silences check-ins for good. */
export const MAX_PAUSE_DAYS = 30;

export const DEFAULT_SETTINGS = { enabled: true, graceMinutes: 30, escalateMinutes: 30 } as const;

export function settingsOrDefault(familyId: string, s: CheckInSettings | undefined): CheckInSettings {
  return s ?? { familyId, ...DEFAULT_SETTINGS, setBy: 'carecircle', setAt: new Date(0).toISOString() };
}

/** "HH:MM" from minutes since midnight. */
export function hhmm(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Earliest HH:MM per day from a list of { date, time }. */
export function firstByDay(events: { date: string; time: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    const seen = out.get(e.date);
    if (!seen || e.time < seen) out.set(e.date, e.time);
  }
  return out;
}

/**
 * The time they are usually up and about by: the median first activity over the past two
 * weeks, not counting today. Undefined until there are enough mornings to go on.
 */
export function usualTime(firsts: Map<string, string>, today: string): string | undefined {
  const from = addDays(today, -RHYTHM_DAYS);
  const mins = [...firsts.entries()]
    .filter(([date]) => date >= from && date < today)
    .map(([, time]) => toMinutes(time))
    .sort((a, b) => a - b);
  if (mins.length < MIN_MORNINGS) return undefined;
  const mid = Math.floor(mins.length / 2);
  const median = mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2;
  // Round to five minutes: "usually up by 8:20" reads better than 8:23.
  return hhmm(Math.round(median / 5) * 5);
}

export interface RhythmDay {
  date: string;
  /** HH:MM of the first activity, or null for a morning with nothing from them */
  first: string | null;
  /** Minutes after the usual time, negative when earlier */
  vsUsual: number | null;
  late: boolean;
}

/** The past seven days, oldest first, including today so far. */
export function week(firsts: Map<string, string>, today: string, usual: string | undefined): RhythmDay[] {
  const days: RhythmDay[] = [];
  for (let i = -6; i <= 0; i++) {
    const date = addDays(today, i);
    const first = firsts.get(date) ?? null;
    const vsUsual = first && usual ? toMinutes(first) - toMinutes(usual) : null;
    days.push({ date, first, vsUsual, late: vsUsual !== null && vsUsual >= LATE_BY_MIN });
  }
  return days;
}

export function isPaused(settings: CheckInSettings, today: string): boolean {
  return Boolean(settings.pausedUntil && settings.pausedUntil >= today);
}

export type CheckInStep =
  | { kind: 'none'; why: 'off' | 'paused' | 'no_baseline' | 'active' | 'not_yet' | 'waiting' | 'done' }
  | { kind: 'ask'; usual: string }
  | { kind: 'tell_family' }
  | { kind: 'answered' };

/**
 * What the morning check-in should do now. `existing` is today's check-in, if any;
 * `activeSince` is the earliest activity today (HH:MM), if any.
 */
export function nextStep(input: {
  settings: CheckInSettings;
  today: string;
  nowMinutes: number;
  usual: string | undefined;
  firstToday: string | undefined;
  existing: CheckIn | undefined;
}): CheckInStep {
  const { settings, today, nowMinutes, usual, firstToday, existing } = input;
  // An open check-in only exists because there was nothing from them that morning, so anything
  // from them now answers it, even if check-ins were paused in the meantime.
  if (existing && !existing.answeredAt && firstToday) return { kind: 'answered' };
  if (existing?.answeredAt) return { kind: 'none', why: 'done' };
  if (!settings.enabled) return { kind: 'none', why: 'off' };
  if (isPaused(settings, today)) return { kind: 'none', why: 'paused' };
  if (!existing) {
    if (firstToday) return { kind: 'none', why: 'active' };
    if (!usual) return { kind: 'none', why: 'no_baseline' };
    if (nowMinutes < toMinutes(usual) + settings.graceMinutes) return { kind: 'none', why: 'not_yet' };
    return { kind: 'ask', usual };
  }
  if (existing.stage === 'asked' && nowMinutes >= toMinutes(existing.askedTime) + settings.escalateMinutes) return { kind: 'tell_family' };
  return { kind: 'none', why: 'waiting' };
}

/**
 * The day someone means by "till Sunday", "tomorrow", "next week" or "2026-10-18",
 * as family-local YYYY-MM-DD. "Till Sunday" includes Sunday. Undefined if unclear.
 */
export function readUntil(text: string, today: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t >= today ? t : undefined;
  if (/\btoday\b|this morning/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\bnext week\b|\ba week\b/.test(t)) return addDays(today, 7);
  const days = /(\d+)\s*days?/.exec(t);
  if (days) return addDays(today, Number(days[1]));
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const hit = names.findIndex(n => t.includes(n) || t.includes(n.slice(0, 3)));
  if (hit >= 0) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      if (weekdayName(d).toLowerCase() === names[hit]) return d;
    }
  }
  return undefined;
}
