/**
 * Pure care logic: no I/O, no MCP. Everything here is unit-tested with a fixed clock.
 */
import type { DoseLog, Family, Medication, Slot } from '../store/types.js';
import { addDays, localParts, toMinutes } from './time.js';

/** A dose counts as "due" from 60 min before its slot until 3 h after; later it is "missed". */
export const DUE_BEFORE_MIN = 60;
export const MISSED_AFTER_MIN = 180;
/** Refill alerts fire at or below this many days of supply. */
export const DEFAULT_REFILL_WINDOW_DAYS = 7;

export type DoseStatus = 'taken' | 'skipped' | 'due' | 'upcoming' | 'missed';

export interface ScheduledDose {
  medicationId: string;
  name: string;
  strength: string;
  purpose: string;
  slot: Slot;
  time: string;
  pills: number;
  instructions?: string;
}

export interface DoseState extends ScheduledDose {
  status: DoseStatus;
  /** ISO instant, when taken or skipped */
  loggedAt?: string;
  loggedBy?: string;
}

export function scheduledDoses(family: Family, meds: Medication[]): ScheduledDose[] {
  const out: ScheduledDose[] = [];
  for (const med of meds) {
    for (const entry of med.schedule) {
      out.push({
        medicationId: med.id,
        name: med.name,
        strength: med.strength,
        purpose: med.purpose,
        slot: entry.slot,
        time: family.slots[entry.slot],
        pills: entry.pills,
        instructions: entry.instructions
      });
    }
  }
  return out.sort((a, b) => toMinutes(a.time) - toMinutes(b.time) || a.name.localeCompare(b.name));
}

export function doseStates(
  family: Family,
  meds: Medication[],
  logs: DoseLog[],
  date: string,
  now: Date
): DoseState[] {
  const local = localParts(now, family.timezone);
  return scheduledDoses(family, meds).map(dose => {
    const log = logs.find(l => l.date === date && l.medicationId === dose.medicationId && l.slot === dose.slot);
    if (log) return { ...dose, status: log.status, loggedAt: log.at, loggedBy: log.loggedBy };
    let status: DoseStatus;
    if (date < local.date) status = 'missed';
    else if (date > local.date) status = 'upcoming';
    else {
      const slotMin = toMinutes(dose.time);
      if (local.minutes < slotMin - DUE_BEFORE_MIN) status = 'upcoming';
      else if (local.minutes <= slotMin + MISSED_AFTER_MIN) status = 'due';
      else status = 'missed';
    }
    return { ...dose, status };
  });
}

export function pillsPerDay(med: Medication): number {
  return med.schedule.reduce((sum, e) => sum + e.pills, 0);
}

export interface Supply {
  medicationId: string;
  name: string;
  strength: string;
  pillsOnHand: number;
  pillsPerDay: number;
  /** Whole days of supply left, counting from today */
  daysLeft: number;
  /** Family-local date of the last day covered */
  runsOutOn: string;
  pharmacyId: string;
}

export function supply(med: Medication, today: string): Supply {
  const perDay = pillsPerDay(med);
  const daysLeft = perDay === 0 ? Number.POSITIVE_INFINITY : Math.floor(med.pillsOnHand / perDay);
  return {
    medicationId: med.id,
    name: med.name,
    strength: med.strength,
    pillsOnHand: med.pillsOnHand,
    pillsPerDay: perDay,
    daysLeft: Number.isFinite(daysLeft) ? daysLeft : 9999,
    runsOutOn: addDays(today, Math.max(0, (Number.isFinite(daysLeft) ? daysLeft : 9999) - 1)),
    pharmacyId: med.pharmacyId
  };
}

export function refillAlerts(meds: Medication[], today: string, withinDays = DEFAULT_REFILL_WINDOW_DAYS): Supply[] {
  return meds
    .map(m => supply(m, today))
    .filter(s => s.daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/* ---------- Spoken-name matching ---------- */

const GENERIC = new Set([
  'pill', 'pills', 'tablet', 'tablets', 'medicine', 'medicines', 'medication', 'medications', 'meds',
  'my', 'the', 'all', 'one', 'ones', 'dose', 'doses', 'morning', 'evening', 'night', 'noon', 'and', 'took', 'taken'
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if the phrase names no particular medicine ("my pills", "my morning tablets"). */
export function isGenericPhrase(spoken: string): boolean {
  const words = normalize(spoken).split(' ').filter(Boolean);
  return words.length === 0 || words.every(w => GENERIC.has(w));
}

export interface MatchResult {
  kind: 'none' | 'single' | 'ambiguous';
  matches: Medication[];
}

/**
 * Matches a spoken phrase ("the blood pressure one", "vitamin", "metformin")
 * against medication names and aliases. Longer alias hits win; ties are ambiguous.
 */
export function matchMedication(meds: Medication[], spoken: string): MatchResult {
  const phrase = ` ${normalize(spoken)} `;
  const scored = meds
    .map(med => {
      const terms = [med.name, med.purpose, ...med.aliases].map(normalize).filter(Boolean);
      const best = Math.max(0, ...terms.filter(t => phrase.includes(` ${t} `)).map(t => t.length));
      return { med, score: best };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: 'none', matches: [] };
  const top = scored.filter(x => x.score === scored[0].score).map(x => x.med);
  return top.length === 1 ? { kind: 'single', matches: top } : { kind: 'ambiguous', matches: top };
}

/**
 * The slot a generic "I took my pills" most likely refers to: the earliest slot
 * today with doses currently due, else the latest slot whose time has passed
 * that still has untaken doses.
 */
export function slotToLog(states: DoseState[], family: Family, now: Date): Slot | undefined {
  const due = states.find(s => s.status === 'due');
  if (due) return due.slot;
  const minutes = localParts(now, family.timezone).minutes;
  const pending = states
    .filter(s => s.status === 'missed' && toMinutes(s.time) <= minutes)
    .sort((a, b) => toMinutes(b.time) - toMinutes(a.time));
  return pending[0]?.slot;
}

/* ---------- Wellbeing safety ---------- */

const RED_FLAGS: { pattern: RegExp; label: string }[] = [
  { pattern: /chest\b.{0,20}\b(pain|hurts?|hurting|tight|pressure|heavy)/, label: 'chest pain' },
  { pattern: /(can ?not|can't|cannot|hard to|trouble) breath|short of breath|breathless/, label: 'breathing difficulty' },
  { pattern: /\b(fell|fallen|had a fall|falling down)\b/, label: 'a fall' },
  { pattern: /\b(fainted|passed out|blacked out|unconscious)\b/, label: 'fainting' },
  { pattern: /\b(stroke|slurred|face (is )?droop|one side (is )?(numb|weak))\b/, label: 'stroke signs' },
  { pattern: /\b(bleeding (a lot|heavily)|won't stop bleeding|vomiting blood)\b/, label: 'heavy bleeding' },
  { pattern: /\b(overdose|took too many|double dose|extra (tablet|pill)s?)\b/, label: 'possible medication error' },
  // Hindi (Devanagari) and Hinglish. \b doesn't work around Devanagari, so these match on substrings.
  { pattern: /(सीने|छाती) में (दर्द|जकड़न|भारीपन)|\b(seene|chhati|chati) (mein|me) dard\b/, label: 'chest pain' },
  { pattern: /(साँस|सांस) (नहीं|लेने में)|\b(saans|sans) (nahi|lene)\b/, label: 'breathing difficulty' },
  { pattern: /गिर (गई|गया|गयी|पड़ी|पड़ा)|फिसल (गई|गया|गयी)|\b(gir|phisal) (gayi|gai|gaya|padi|pada)\b/, label: 'a fall' },
  { pattern: /बेहोश|\bbehosh\b/, label: 'fainting' },
  { pattern: /(ज़्यादा|ज्यादा|दो बार) (दवा|दवाई|गोली|गोलियाँ) (ले|खा)/, label: 'possible medication error' }
];

export interface SafetyCheck {
  redFlag: boolean;
  reasons: string[];
}

export function safetyCheck(note: string): SafetyCheck {
  const lowered = note.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  const reasons = RED_FLAGS.filter(f => f.pattern.test(lowered)).map(f => f.label);
  return { redFlag: reasons.length > 0, reasons };
}
