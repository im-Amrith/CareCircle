/**
 * Planning by the orchestrator's care team (a Strands multi-agent Graph). The server
 * gathers the facts and owns the task, the picker and the booking; the care team only
 * ranks. Its answer is checked against the facts: an option must be a real open slot
 * that fits the person's constraints, with a driver who is actually free. Anything
 * else is dropped, and if nothing usable comes back (or the call fails), the
 * deterministic ranking is used instead, so booking never depends on a model.
 */
import {
  MAX_OPTIONS,
  buildOption,
  dayName,
  fitsConstraints,
  gatherFacts,
  rankLocally,
  type AppointmentOption,
  type AppointmentPlanner,
  type AppointmentServices,
  type PlanFacts,
  type PlanRequest,
  type PlanStep
} from './appointments.js';
import { voiceSafe } from './speech.js';

/** What the care team answers: picked slots, best first, each with a one-line reason. */
export interface CareTeamAnswer {
  engine?: string;
  options?: { slotId?: unknown; driverId?: unknown; reason?: unknown }[];
}

export const PLANNER_TIMEOUT_MS = 20_000;

/** The JSON brief the care team plans from. */
export function planningBrief(facts: PlanFacts, req: PlanRequest) {
  return {
    recipient: req.recipientName,
    specialty: req.specialty,
    window: req.window,
    constraints: req.constraints,
    clinic: facts.clinic,
    travelMinutes: facts.travelMinutes,
    maxOptions: MAX_OPTIONS,
    slots: facts.slots.map(e => ({ id: e.id, date: e.slot.date, day: dayName(e.slot.date), time: e.slot.time, doctor: e.slot.doctor, leaveAt: e.leaveAt, drivers: e.drivers }))
  };
}

/** Keeps only picks that match the facts and constraints; tops up from the local ranking. */
export function checkAnswer(answer: CareTeamAnswer, facts: PlanFacts, req: PlanRequest): AppointmentOption[] {
  const out: AppointmentOption[] = [];
  const used = new Set<string>();
  for (const pick of Array.isArray(answer.options) ? answer.options : []) {
    if (out.length >= MAX_OPTIONS) break;
    const entry = facts.slots.find(e => e.id === pick?.slotId);
    if (!entry || used.has(entry.id) || !fitsConstraints(entry.slot, req.constraints)) continue;
    const driver = pick.driverId == null ? null : (entry.drivers.find(d => d.id === pick.driverId) ?? undefined);
    if (driver === undefined) continue;
    const reason = typeof pick.reason === 'string' ? voiceSafe(pick.reason).slice(0, 160) : '';
    if (!reason) continue;
    used.add(entry.id);
    out.push(buildOption(facts, entry, driver, out.length + 1, reason, typeof answer.engine === 'string' ? answer.engine.slice(0, 80) : 'care-team'));
  }
  if (out.length === 0) return out;
  for (const local of rankLocally(facts, req)) {
    if (out.length >= MAX_OPTIONS) break;
    if (!out.some(o => o.date === local.date && o.time === local.time)) out.push({ ...local, rank: out.length + 1 });
  }
  return out;
}

export class RemotePlanner implements AppointmentPlanner {
  constructor(
    private services: AppointmentServices,
    private url: string,
    private timeoutMs = PLANNER_TIMEOUT_MS,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async plan(req: PlanRequest, onStep?: (step: PlanStep) => void): Promise<AppointmentOption[]> {
    const facts = await gatherFacts(this.services, req, onStep);
    if (!facts) return [];
    onStep?.('planner');
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(planningBrief(facts, req)),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!res.ok) throw new Error(`care team answered HTTP ${res.status}`);
      const options = checkAnswer((await res.json()) as CareTeamAnswer, facts, req);
      if (options.length) return options;
      throw new Error('care team returned no usable options');
    } catch (err) {
      console.warn(`[carecircle] care team planner unavailable, ranking locally: ${err instanceof Error ? err.message : String(err)}`);
      return rankLocally(facts, req);
    }
  }
}
