import { readFileSync } from 'node:fs';
import { MemoryStore } from './memory.js';
import type { Role, ScheduleEntry, Severity, Slot } from './types.js';
import { addDays, localParts, toMinutes, zonedToUtc } from '../domain/time.js';

/** Shape of seed/rose.json. Dates are relative (dayOffset) so the demo never goes stale. */
export interface SeedFile {
  family: { id: string; name: string; timezone: string; locale: string; recipientId: string };
  members: { id: string; name: string; role: Role; relation: string; pronoun?: 'she' | 'he' | 'they' }[];
  slots: Record<Slot, string>;
  pharmacies: { id: string; name: string; pickup: boolean; delivery: boolean }[];
  medications: {
    id: string;
    name: string;
    strength: string;
    form: string;
    purpose: string;
    aliases: string[];
    schedule: ScheduleEntry[];
    pillsOnHand: number;
    pharmacyId: string;
  }[];
  history: {
    days: number;
    loggedBy: string;
    minutesAfterSlot: [number, number];
    missed: { dayOffset: number; medicationId: string; slot: Slot }[];
  };
  visits: { id: string; dayOffset: number; time: string; who: string; purpose: string }[];
  wellbeing: { dayOffset: number; time: string; note: string; severity: Severity; loggedBy: string }[];
}

export function readSeedFile(path: string): SeedFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedFile;
}

/** Small deterministic hash so seeded "taken at" minutes look natural but never change between runs. */
function jitter(key: string, min: number, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return min + (Math.abs(h) % (max - min + 1));
}

/**
 * Builds a MemoryStore from a seed file. History covers the `history.days` days
 * before today; today's doses are left for the user to log, so the demo starts
 * from a realistic "this morning" state.
 */
export function buildSeededStore(seed: SeedFile, now: Date): MemoryStore {
  const store = new MemoryStore();
  const tz = seed.family.timezone;
  const today = localParts(now, tz).date;
  const familyId = seed.family.id;

  store.families.set(familyId, { ...seed.family, slots: seed.slots });
  for (const m of seed.members) store.members.set(m.id, { ...m, familyId });
  for (const p of seed.pharmacies) store.pharmacies.set(p.id, { ...p });
  for (const m of seed.medications) store.medications.set(m.id, { ...m, familyId });

  const missed = new Set(seed.history.missed.map(x => `${x.dayOffset}|${x.medicationId}|${x.slot}`));
  const [minAfter, maxAfter] = seed.history.minutesAfterSlot;

  for (let offset = -seed.history.days; offset <= -1; offset++) {
    const date = addDays(today, offset);
    for (const med of seed.medications) {
      for (const entry of med.schedule) {
        if (missed.has(`${offset}|${med.id}|${entry.slot}`)) continue;
        const minutes = toMinutes(seed.slots[entry.slot]) + jitter(`${date}${med.id}${entry.slot}`, minAfter, maxAfter);
        const time = `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        store.doseLogs.push({
          id: `log-${date}-${med.id}-${entry.slot}`,
          familyId,
          medicationId: med.id,
          slot: entry.slot,
          date,
          status: 'taken',
          at: zonedToUtc(date, time, tz).toISOString(),
          loggedBy: seed.history.loggedBy,
          source: 'seed'
        });
      }
    }
  }

  for (const v of seed.visits) {
    store.visits.push({ id: v.id, familyId, date: addDays(today, v.dayOffset), time: v.time, who: v.who, purpose: v.purpose });
  }

  seed.wellbeing.forEach((w, i) => {
    const date = addDays(today, w.dayOffset);
    const at = zonedToUtc(date, w.time, tz);
    // Never seed a note in the future relative to "now".
    if (at.getTime() > now.getTime()) return;
    store.wellbeing.push({
      id: `well-seed-${i}`,
      familyId,
      at: at.toISOString(),
      date,
      time: w.time,
      note: w.note,
      severity: w.severity,
      redFlag: false,
      loggedBy: w.loggedBy
    });
  });

  return store;
}
