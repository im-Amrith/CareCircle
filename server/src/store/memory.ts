import type {
  Activity,
  CheckIn,
  CheckInSettings,
  CarePreference,
  CareStore,
  DoseLog,
  Family,
  FamilyMessage,
  HelperTask,
  Language,
  Medication,
  Member,
  OrderStatus,
  PreferenceKey,
  Pharmacy,
  RefillOrder,
  Visit,
  VoiceCheck,
  WellbeingNote
} from './types.js';

/** In-memory store for local development, tests and judge runs (MOCK_AWS=1). */
export class MemoryStore implements CareStore {
  families = new Map<string, Family>();
  members = new Map<string, Member>();
  medications = new Map<string, Medication>();
  pharmacies = new Map<string, Pharmacy>();
  doseLogs: DoseLog[] = [];
  visits: Visit[] = [];
  helperTasks: HelperTask[] = [];
  wellbeing: WellbeingNote[] = [];
  orders: RefillOrder[] = [];
  messages: FamilyMessage[] = [];
  preferences: CarePreference[] = [];
  voiceChecks: VoiceCheck[] = [];
  activity: Activity[] = [];
  checkInSettings = new Map<string, CheckInSettings>();
  checkIns: CheckIn[] = [];

  async getMember(userId: string) {
    return this.members.get(userId);
  }

  async setMemberLanguage(userId: string, language: Language) {
    const member = this.members.get(userId);
    if (!member) throw new Error(`Unknown member ${userId}`);
    member.language = language;
    return member;
  }

  async listFamilies() {
    return [...this.families.values()];
  }

  async getFamily(familyId: string) {
    return this.families.get(familyId);
  }

  async listMembers(familyId: string) {
    return [...this.members.values()].filter(m => m.familyId === familyId);
  }

  async listMedications(familyId: string) {
    return [...this.medications.values()].filter(m => m.familyId === familyId);
  }

  async getMedication(familyId: string, medicationId: string) {
    const med = this.medications.get(medicationId);
    return med && med.familyId === familyId ? med : undefined;
  }

  async adjustPills(familyId: string, medicationId: string, delta: number) {
    const med = await this.getMedication(familyId, medicationId);
    if (!med) throw new Error(`Unknown medication ${medicationId}`);
    med.pillsOnHand = Math.max(0, med.pillsOnHand + delta);
    return med;
  }

  async getPharmacy(pharmacyId: string) {
    return this.pharmacies.get(pharmacyId);
  }

  async listDoseLogs(familyId: string, fromDate: string, toDate: string) {
    return this.doseLogs.filter(l => l.familyId === familyId && l.date >= fromDate && l.date <= toDate);
  }

  async addDoseLog(log: DoseLog) {
    this.doseLogs.push(log);
  }

  async listVisits(familyId: string, fromDate: string, toDate: string) {
    return this.visits
      .filter(v => v.familyId === familyId && v.date >= fromDate && v.date <= toDate)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  async addVisit(visit: Visit) {
    this.visits.push(visit);
  }

  async listHelperTasks(familyId: string, fromDate: string, toDate: string) {
    return this.helperTasks
      .filter(t => t.familyId === familyId && t.date >= fromDate && t.date <= toDate)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }

  async addHelperTask(task: HelperTask) {
    this.helperTasks.push(task);
  }

  async listWellbeing(familyId: string, fromDate: string, toDate: string) {
    return this.wellbeing
      .filter(n => n.familyId === familyId && n.date >= fromDate && n.date <= toDate)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async addWellbeing(note: WellbeingNote) {
    this.wellbeing.push(note);
  }

  async listOrders(familyId: string) {
    return this.orders.filter(o => o.familyId === familyId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addOrder(order: RefillOrder) {
    this.orders.push(order);
  }

  async getOrderByTokenHash(tokenHash: string) {
    return this.orders.find(o => o.checkoutTokenHash === tokenHash);
  }

  async transitionOrder(orderId: string, from: OrderStatus, patch: Partial<RefillOrder> & { status: OrderStatus }) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order || order.status !== from) return undefined;
    Object.assign(order, patch);
    return order;
  }

  async listPreferences(familyId: string) {
    return this.preferences.filter(p => p.familyId === familyId);
  }

  async setPreference(preference: CarePreference) {
    this.preferences = this.preferences.filter(p => !(p.familyId === preference.familyId && p.key === preference.key));
    this.preferences.push(preference);
  }

  async removePreference(familyId: string, key: PreferenceKey) {
    const before = this.preferences.length;
    this.preferences = this.preferences.filter(p => !(p.familyId === familyId && p.key === key));
    return this.preferences.length < before;
  }

  async listVoiceChecks(familyId: string, fromDate: string, toDate: string) {
    return this.voiceChecks.filter(c => c.familyId === familyId && c.date >= fromDate && c.date <= toDate);
  }

  async addVoiceCheck(check: VoiceCheck) {
    this.voiceChecks.push(check);
  }

  async addActivity(activity: Activity) {
    this.activity.push(activity);
  }

  async listActivity(familyId: string, fromDate: string, toDate: string) {
    return this.activity.filter(a => a.familyId === familyId && a.date >= fromDate && a.date <= toDate);
  }

  async getCheckInSettings(familyId: string) {
    return this.checkInSettings.get(familyId);
  }

  async setCheckInSettings(settings: CheckInSettings) {
    this.checkInSettings.set(settings.familyId, { ...settings });
  }

  async listCheckIns(familyId: string, fromDate: string, toDate: string) {
    return this.checkIns.filter(c => c.familyId === familyId && c.date >= fromDate && c.date <= toDate).sort((a, b) => a.date.localeCompare(b.date));
  }

  async saveCheckIn(checkIn: CheckIn) {
    this.checkIns = this.checkIns.filter(c => c.id !== checkIn.id);
    this.checkIns.push({ ...checkIn });
  }

  async addMessage(message: FamilyMessage) {
    this.messages.push(message);
  }

  async listMessages(familyId: string, limit = 20) {
    return this.messages
      .filter(m => m.familyId === familyId)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
      .slice(0, limit);
  }
}
