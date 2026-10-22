/**
 * Appointment planning: find a clinic slot that fits the family's constraints and
 * someone who can take the care recipient there. The outside world (clinic
 * availability, family calendars, travel times) sits behind three small interfaces
 * so a real booking API or calendar can replace the synthetic mocks.
 */
import { addDays, spokenTime, toMinutes } from './time.js';

export interface Clinic {
  id: string;
  name: string;
  specialty: string;
}

export interface ClinicSlot {
  clinicId: string;
  doctor: string;
  /** Family-local YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
}

export interface ClinicDirectory {
  /** The clinic for a specialty, or undefined if CareCircle knows none. */
  clinicFor(specialty: string): Promise<Clinic | undefined>;
  /** Open slots, inclusive date range. */
  openSlots(clinicId: string, fromDate: string, toDate: string): Promise<ClinicSlot[]>;
}

export interface FamilyCalendar {
  /** Member ids free to drive for the whole of [from, to) on that date, wall-clock HH:MM. */
  freeDrivers(familyId: string, date: string, from: string, to: string): Promise<string[]>;
}

export interface TravelTimes {
  /** Door-to-door minutes from the care recipient's home to the clinic. */
  minutes(familyId: string, clinicId: string): Promise<number>;
}

export interface AppointmentServices {
  clinics: ClinicDirectory;
  calendar: FamilyCalendar;
  travel: TravelTimes;
}

/* ---------- Requests and options ---------- */

export interface TimeWindow {
  from: string;
  to: string;
  /** e.g. "next week" */
  label: string;
}

export interface Constraints {
  /** Earliest and latest appointment start, HH:MM */
  earliest: string;
  latest: string;
  /** 1 = Monday ... 5 = Friday; empty means any weekday */
  weekdays: number[];
  /** Words understood, for the spoken reply, e.g. ["mornings"] */
  understood: string[];
}

export interface PlanRequest {
  familyId: string;
  recipientName: string;
  specialty: string;
  window: TimeWindow;
  constraints: Constraints;
  /** Family members by id, for driver names */
  members: { id: string; name: string }[];
}

export interface AppointmentOption {
  /** Stable for a given slot and ride, e.g. "2026-10-13T10:30-riverside-heart-dr-rao-maya" */
  id: string;
  rank: number;
  date: string;
  time: string;
  clinicId: string;
  clinic: string;
  specialty: string;
  doctor: string;
  /** Who drives; null means a booked taxi */
  driver: { id: string; name: string } | null;
  /** When the ride leaves home, HH:MM */
  leaveAt: string;
  travelMinutes: number;
  /** Short label for a picker, e.g. "Tue 10:30 am with Dr Rao, Maya drives" */
  label: string;
  /** One line on why this option ranks where it does */
  reason: string;
  /** Who ranked it: "local", or the care team's engine, e.g. "strands-graph:deterministic" */
  plannedBy: string;
}

/** The planning steps, in order. Status messages and the UI task card follow these. */
export type PlanStep = 'clinic' | 'calendar' | 'transport' | 'planner';

export interface AppointmentPlanner {
  plan(request: PlanRequest, onStep?: (step: PlanStep) => void): Promise<AppointmentOption[]>;
}

/** How long a visit takes at the clinic, for checking the driver is free for the round trip. */
export const VISIT_MINUTES = 45;
export const MAX_OPTIONS = 3;

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const dayName = (date: string) => LONG_DAY[weekdayOf(date)];

export function shiftTime(time: string, minutes: number): string {
  const t = toMinutes(time) + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** "next week" -> Monday to Sunday after today; "this week" -> tomorrow to Sunday; otherwise the next 14 days. */
export function parseWindow(text: string | undefined, today: string): TimeWindow {
  const t = (text ?? '').toLowerCase().trim();
  const dow = weekdayOf(today);
  const toSunday = (7 - dow) % 7;
  if (/next week/.test(t)) {
    const monday = addDays(today, toSunday + 1);
    return { from: monday, to: addDays(monday, 6), label: 'next week' };
  }
  if (/this week/.test(t)) return { from: addDays(today, 1), to: addDays(today, Math.max(toSunday, 1)), label: 'this week' };
  if (/tomorrow/.test(t)) return { from: addDays(today, 1), to: addDays(today, 1), label: 'tomorrow' };
  return { from: addDays(today, 1), to: addDays(today, 14), label: 'in the next two weeks' };
}

/** Understands times of day and weekday names: "mornings", "afternoons, not Friday", "Tuesday or Thursday". */
export function parseConstraints(...texts: (string | undefined)[]): Constraints {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  const out: Constraints = { earliest: '08:00', latest: '17:00', weekdays: [], understood: [] };
  if (/morning/.test(t)) {
    out.latest = '11:59';
    out.understood.push('mornings');
  } else if (/afternoon/.test(t)) {
    out.earliest = '12:00';
    out.understood.push('afternoons');
  }
  const excluded = new Set<number>();
  for (const [i, name] of WEEKDAY_NAMES.entries()) {
    if (!new RegExp(`\\b${name}s?\\b`).test(t)) continue;
    // "not Friday", "not on Fridays", "would rather not go on Thursdays", "never Mondays", "avoid Monday"
    if (new RegExp(`\\b(not|except|no|never|avoid|can't|cannot)\\b(\\s+[a-z']+){0,3}?\\s+${name}`).test(t)) excluded.add(i);
    else out.weekdays.push(i);
  }
  if (excluded.size) {
    out.weekdays = [1, 2, 3, 4, 5].filter(d => !excluded.has(d) && (out.weekdays.length === 0 || out.weekdays.includes(d)));
    out.understood.push(`not ${[...excluded].map(d => LONG_DAY[d]).join(' or ')}`);
  } else if (out.weekdays.length) {
    out.understood.push(out.weekdays.map(d => LONG_DAY[d]).join(' or '));
  }
  return out;
}

/* ---------- Facts, and the deterministic planner (mock mode, and the fallback) ---------- */

/** Everything a planner ranks: the clinic, its open slots in the window, who can drive to each, travel time. */
export interface PlanFacts {
  clinic: Clinic;
  travelMinutes: number;
  slots: { id: string; slot: ClinicSlot; leaveAt: string; drivers: { id: string; name: string }[] }[];
}

export function fitsConstraints(slot: ClinicSlot, c: Constraints): boolean {
  return (
    toMinutes(slot.time) >= toMinutes(c.earliest) &&
    toMinutes(slot.time) <= toMinutes(c.latest) &&
    (c.weekdays.length === 0 || c.weekdays.includes(weekdayOf(slot.date)))
  );
}

/** Asks the clinic, the family calendar and the travel service. Undefined if no clinic does this specialty. */
export async function gatherFacts(services: AppointmentServices, req: PlanRequest, onStep?: (step: PlanStep) => void): Promise<PlanFacts | undefined> {
  onStep?.('clinic');
  const clinic = await services.clinics.clinicFor(req.specialty);
  if (!clinic) return undefined;
  const open = await services.clinics.openSlots(clinic.id, req.window.from, req.window.to);
  onStep?.('calendar');
  onStep?.('transport');
  const travelMinutes = await services.travel.minutes(req.familyId, clinic.id);
  const nameOf = (id: string) => req.members.find(m => m.id === id)?.name ?? id;
  const slots = await Promise.all(
    open.map(async slot => {
      const leaveAt = shiftTime(slot.time, -travelMinutes);
      const backAt = shiftTime(slot.time, VISIT_MINUTES + travelMinutes);
      const drivers = await services.calendar.freeDrivers(req.familyId, slot.date, leaveAt, backAt);
      return { id: `${slot.date}T${slot.time}-${clinic.id}-${slug(slot.doctor)}`, slot, leaveAt, drivers: drivers.map(id => ({ id, name: nameOf(id) })) };
    })
  );
  return { clinic, travelMinutes, slots };
}

export function buildOption(
  facts: PlanFacts,
  entry: PlanFacts['slots'][number],
  driver: { id: string; name: string } | null,
  rank: number,
  reason: string,
  plannedBy = 'local'
): AppointmentOption {
  const { slot } = entry;
  return {
    id: `${entry.id}-${driver?.id ?? 'taxi'}`,
    rank,
    date: slot.date,
    time: slot.time,
    clinicId: facts.clinic.id,
    clinic: facts.clinic.name,
    specialty: facts.clinic.specialty,
    doctor: slot.doctor,
    driver,
    leaveAt: entry.leaveAt,
    travelMinutes: facts.travelMinutes,
    label: `${SHORT_DAY[weekdayOf(slot.date)]} ${spokenTime(slot.time)} with ${slot.doctor}, ${driver ? `${driver.name} drives` : 'taxi'}`,
    reason,
    plannedBy
  };
}

/** A family member driving beats a taxi; then earliest first. */
export function rankLocally(facts: PlanFacts, req: PlanRequest): AppointmentOption[] {
  const fitting = facts.slots.filter(e => fitsConstraints(e.slot, req.constraints));
  fitting.sort((a, b) => Number(!a.drivers.length) - Number(!b.drivers.length) || (a.slot.date + a.slot.time).localeCompare(b.slot.date + b.slot.time));
  return fitting.slice(0, MAX_OPTIONS).map((entry, i) => {
    const driver = entry.drivers[0] ?? null;
    const day = LONG_DAY[weekdayOf(entry.slot.date)];
    const reason = driver
      ? `${i === 0 ? 'Earliest slot with a driver, and ' : ''}${driver.name} is free ${day} ${toMinutes(entry.slot.time) < 12 * 60 ? 'morning' : 'afternoon'}.`
      : `No one in the family is free then, so a taxi, about ${facts.travelMinutes} minutes each way.`;
    return buildOption(facts, entry, driver, i + 1, reason[0].toUpperCase() + reason.slice(1));
  });
}

/** Same inputs, same three options, every time: judges can run the demo without AWS. */
export class LocalPlanner implements AppointmentPlanner {
  constructor(private services: AppointmentServices) {}

  async plan(req: PlanRequest, onStep?: (step: PlanStep) => void): Promise<AppointmentOption[]> {
    const facts = await gatherFacts(this.services, req, onStep);
    if (!facts) return [];
    onStep?.('planner');
    return rankLocally(facts, req);
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- Synthetic services ---------- */

const CLINICS: (Clinic & { aliases: string[] })[] = [
  { id: 'riverside-heart', name: 'Riverside Heart Clinic', specialty: 'cardiology', aliases: ['cardiology', 'cardiologist', 'heart', 'cardiac'] }
];

/** Riverside Heart Clinic's synthetic week, by weekday (1 = Monday). */
const WEEK: Record<number, { time: string; doctor: string }[]> = {
  1: [{ time: '09:30', doctor: 'Dr Mehta' }, { time: '14:00', doctor: 'Dr Rao' }],
  2: [{ time: '10:30', doctor: 'Dr Rao' }, { time: '15:00', doctor: 'Dr Mehta' }],
  3: [{ time: '11:00', doctor: 'Dr Rao' }, { time: '16:00', doctor: 'Dr Rao' }],
  4: [{ time: '09:15', doctor: 'Dr Mehta' }, { time: '11:30', doctor: 'Dr Rao' }, { time: '14:30', doctor: 'Dr Mehta' }],
  5: [{ time: '10:00', doctor: 'Dr Mehta' }, { time: '15:30', doctor: 'Dr Rao' }]
};

/**
 * Who can drive, and when, as weekly free windows. Maya is free Tuesday and Thursday
 * mornings; Sam lives away and helps remotely; Rose doesn't drive.
 */
const DRIVERS: Record<string, { weekday: number; from: string; to: string }[]> = {
  maya: [
    { weekday: 2, from: '08:00', to: '13:00' },
    { weekday: 4, from: '08:00', to: '13:00' }
  ]
};

export const TRAVEL_MINUTES = 25;

export function mockAppointmentServices(): AppointmentServices {
  return {
    clinics: {
      async clinicFor(specialty) {
        const s = specialty.toLowerCase();
        const c = CLINICS.find(c => c.aliases.some(a => s.includes(a)));
        return c && { id: c.id, name: c.name, specialty: c.specialty };
      },
      async openSlots(clinicId, fromDate, toDate) {
        if (!CLINICS.some(c => c.id === clinicId)) return [];
        const out: ClinicSlot[] = [];
        for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
          for (const s of WEEK[weekdayOf(date)] ?? []) out.push({ clinicId, date, time: s.time, doctor: s.doctor });
        }
        return out;
      }
    },
    calendar: {
      async freeDrivers(_familyId, date, from, to) {
        const day = weekdayOf(date);
        return Object.entries(DRIVERS)
          .filter(([, windows]) => windows.some(w => w.weekday === day && toMinutes(w.from) <= toMinutes(from) && toMinutes(to) <= toMinutes(w.to)))
          .map(([id]) => id);
      }
    },
    travel: {
      async minutes() {
        return TRAVEL_MINUTES;
      }
    }
  };
}
