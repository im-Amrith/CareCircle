/**
 * Domain types and the storage interface. The in-memory store backs local and
 * judge runs; a DynamoDB store implementing the same interface comes later.
 * Methods are async so the swap needs no caller changes.
 */

export type Role = 'recipient' | 'coordinator' | 'helper';
export const SLOTS = ['morning', 'noon', 'evening', 'night'] as const;
export type Slot = (typeof SLOTS)[number];

export interface Family {
  id: string;
  name: string;
  timezone: string;
  locale: string;
  recipientId: string;
  /** Wall-clock time for each slot, e.g. { morning: "08:00" } */
  slots: Record<Slot, string>;
}

export interface Member {
  id: string;
  familyId: string;
  name: string;
  role: Role;
  relation: string;
  /** Used in spoken replies about this person */
  pronoun?: 'she' | 'he' | 'they';
}

export interface Pharmacy {
  id: string;
  name: string;
  pickup: boolean;
  delivery: boolean;
}

export interface ScheduleEntry {
  slot: Slot;
  pills: number;
  instructions?: string;
}

export interface Medication {
  id: string;
  familyId: string;
  name: string;
  strength: string;
  form: string;
  purpose: string;
  aliases: string[];
  schedule: ScheduleEntry[];
  pillsOnHand: number;
  pharmacyId: string;
}

export type DoseStatusLogged = 'taken' | 'skipped';

export interface DoseLog {
  id: string;
  familyId: string;
  medicationId: string;
  slot: Slot;
  /** The scheduled day (family-local YYYY-MM-DD) this dose belongs to */
  date: string;
  status: DoseStatusLogged;
  /** ISO instant the dose was taken or skipped */
  at: string;
  loggedBy: string;
  source: 'voice' | 'ui' | 'seed';
}

export interface Visit {
  id: string;
  familyId: string;
  date: string;
  time: string;
  who: string;
  purpose: string;
}

export type Severity = 'low' | 'medium' | 'high';

export interface WellbeingNote {
  id: string;
  familyId: string;
  at: string;
  date: string;
  time: string;
  note: string;
  severity: Severity;
  redFlag: boolean;
  loggedBy: string;
}

export interface CareStore {
  getMember(userId: string): Promise<Member | undefined>;
  getFamily(familyId: string): Promise<Family | undefined>;
  listMembers(familyId: string): Promise<Member[]>;
  listMedications(familyId: string): Promise<Medication[]>;
  getMedication(familyId: string, medicationId: string): Promise<Medication | undefined>;
  adjustPills(familyId: string, medicationId: string, delta: number): Promise<Medication>;
  getPharmacy(pharmacyId: string): Promise<Pharmacy | undefined>;
  /** Inclusive date range, family-local YYYY-MM-DD */
  listDoseLogs(familyId: string, fromDate: string, toDate: string): Promise<DoseLog[]>;
  addDoseLog(log: DoseLog): Promise<void>;
  listVisits(familyId: string, fromDate: string, toDate: string): Promise<Visit[]>;
  listWellbeing(familyId: string, fromDate: string, toDate: string): Promise<WellbeingNote[]>;
  addWellbeing(note: WellbeingNote): Promise<void>;
}
