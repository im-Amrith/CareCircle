/**
 * Domain types and the storage interface. The in-memory store backs local and
 * judge runs; a DynamoDB store implementing the same interface comes later.
 * Methods are async so the swap needs no caller changes.
 */

export type Role = 'recipient' | 'coordinator' | 'helper';
/** Languages CareCircle can speak. Medicine names stay as they are on the box. */
export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];
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
  /** Spoken replies to this person use this language. Default en. */
  language?: Language;
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
  /** Member id of who visits, or for an appointment, who it is for */
  who: string;
  purpose: string;
  /** A family visit at home (default), or a booked appointment away from home */
  kind?: 'visit' | 'appointment';
  /** Where an appointment is, e.g. "Riverside Heart Clinic" */
  place?: string;
  doctor?: string;
  /** Member id who booked it */
  bookedBy?: string;
}

/** Something a family member agreed to do, e.g. drive Rose to an appointment. */
export interface HelperTask {
  id: string;
  familyId: string;
  assigneeId: string;
  /** e.g. "Drive Rose to Riverside Heart Clinic" */
  text: string;
  date: string;
  /** HH:MM, when to start */
  time: string;
  /** The appointment this task belongs to */
  visitId?: string;
  createdBy: string;
  createdAt: string;
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

export type Fulfilment = 'delivery' | 'pickup';
/** awaiting_checkout until the checkout page is completed; expired is derived from expiresAt. */
export type OrderStatus = 'awaiting_checkout' | 'placed' | 'cancelled' | 'expired';

export interface RefillOrder {
  id: string;
  familyId: string;
  medicationId: string;
  pharmacyId: string;
  /** Pills ordered */
  quantity: number;
  fulfilment: Fulfilment;
  status: OrderStatus;
  requestedBy: string;
  createdAt: string;
  /** SHA-256 of the one-time checkout token. The token itself is never stored. */
  checkoutTokenHash: string;
  /** ISO instant after which the checkout link stops working */
  expiresAt: string;
  placedAt?: string;
  /** Family-local date the pharmacy should deliver or have it ready */
  readyOn?: string;
  cancelledAt?: string;
}

/** What a stored care preference is about. */
export type PreferenceKey = 'appointment_time' | 'appointment_days';

/** Something the family wants remembered, e.g. "Mom prefers mornings". One per key. */
export interface CarePreference {
  familyId: string;
  key: PreferenceKey;
  /** Normalised, e.g. "mornings", "not Friday" */
  value: string;
  /** The words as said, e.g. "Mom prefers mornings" */
  said: string;
  setBy: string;
  setAt: string;
}

/** A message CareCircle sent to the family, e.g. the evening summary. */
export interface FamilyMessage {
  id: string;
  familyId: string;
  kind: 'daily_summary';
  /** Family-local date the message is about */
  date: string;
  title: string;
  text: string;
  /** Member ids it was sent to */
  to: string[];
  sentAt: string;
  /** Member id, or 'schedule' when the evening scheduler sent it */
  sentBy: string;
  /** Where it went: always the in-app inbox; Amazon SNS when a topic is configured */
  delivery: { inbox: true; sns: 'sent' | 'failed' | 'off'; snsMessageId?: string; snsError?: string };
}

/** How sure the device is about who is speaking. Simulated in dev; a real voice profile would set it. */
export type SpeakerConfidence = 'high' | 'low' | 'unknown';

/** A change someone asked for by voice that CareCircle didn't make because it couldn't tell who was speaking. */
export interface VoiceCheck {
  id: string;
  familyId: string;
  at: string;
  /** Family-local YYYY-MM-DD and HH:MM */
  date: string;
  time: string;
  /** Member id of the device's profile the request came in on */
  device: string;
  confidence: Exclude<SpeakerConfidence, 'high'>;
  tool: string;
  /** What was asked, e.g. "log Rose's 8 am Metformin" */
  attempted: string;
}

export interface CareStore {
  getMember(userId: string): Promise<Member | undefined>;
  setMemberLanguage(userId: string, language: Language): Promise<Member>;
  getFamily(familyId: string): Promise<Family | undefined>;
  listFamilies(): Promise<Family[]>;
  listMembers(familyId: string): Promise<Member[]>;
  listMedications(familyId: string): Promise<Medication[]>;
  getMedication(familyId: string, medicationId: string): Promise<Medication | undefined>;
  adjustPills(familyId: string, medicationId: string, delta: number): Promise<Medication>;
  getPharmacy(pharmacyId: string): Promise<Pharmacy | undefined>;
  /** Inclusive date range, family-local YYYY-MM-DD */
  listDoseLogs(familyId: string, fromDate: string, toDate: string): Promise<DoseLog[]>;
  addDoseLog(log: DoseLog): Promise<void>;
  listVisits(familyId: string, fromDate: string, toDate: string): Promise<Visit[]>;
  addVisit(visit: Visit): Promise<void>;
  /** Inclusive date range, family-local YYYY-MM-DD */
  listHelperTasks(familyId: string, fromDate: string, toDate: string): Promise<HelperTask[]>;
  addHelperTask(task: HelperTask): Promise<void>;
  listWellbeing(familyId: string, fromDate: string, toDate: string): Promise<WellbeingNote[]>;
  addWellbeing(note: WellbeingNote): Promise<void>;
  listOrders(familyId: string): Promise<RefillOrder[]>;
  addOrder(order: RefillOrder): Promise<void>;
  getOrderByTokenHash(tokenHash: string): Promise<RefillOrder | undefined>;
  /**
   * Moves an order on only if it is still in status `from`, so two checkout
   * submits (or a submit racing a cancel) can never both win. Returns the
   * updated order, or undefined if it had already moved on.
   */
  transitionOrder(orderId: string, from: OrderStatus, patch: Partial<RefillOrder> & { status: OrderStatus }): Promise<RefillOrder | undefined>;
  listPreferences(familyId: string): Promise<CarePreference[]>;
  /** Replaces any preference with the same key */
  setPreference(preference: CarePreference): Promise<void>;
  /** Returns whether there was one to remove */
  removePreference(familyId: string, key: PreferenceKey): Promise<boolean>;
  /** Inclusive date range, family-local YYYY-MM-DD */
  listVoiceChecks(familyId: string, fromDate: string, toDate: string): Promise<VoiceCheck[]>;
  addVoiceCheck(check: VoiceCheck): Promise<void>;
  addMessage(message: FamilyMessage): Promise<void>;
  /** Newest first */
  listMessages(familyId: string, limit?: number): Promise<FamilyMessage[]>;
}
