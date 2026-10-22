import { describe, expect, it, vi } from 'vitest';
import { mockAppointmentServices, parseConstraints, parseWindow, type PlanRequest } from '../src/domain/appointments.js';
import { RemotePlanner, type CareTeamAnswer } from '../src/domain/remote-planner.js';

const req: PlanRequest = {
  familyId: 'fam-rose',
  recipientName: 'Rose',
  specialty: 'cardiology follow-up',
  window: parseWindow('next week', '2026-10-10'),
  constraints: parseConstraints('mornings'),
  members: [
    { id: 'rose', name: 'Rose' },
    { id: 'sam', name: 'Sam' },
    { id: 'maya', name: 'Maya' }
  ]
};

const TUE = '2026-10-13T10:30-riverside-heart-dr-rao';
const THU_EARLY = '2026-10-15T09:15-riverside-heart-dr-mehta';
const THU_LATE = '2026-10-15T11:30-riverside-heart-dr-rao';
const TUE_AFTERNOON = '2026-10-13T15:00-riverside-heart-dr-mehta';
const MON = '2026-10-12T09:30-riverside-heart-dr-mehta';

function answering(answer: CareTeamAnswer | Error, status = 200) {
  const calls: any[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { planner: new RemotePlanner(mockAppointmentServices(), 'http://care-team/plan', 1000, fetchImpl), calls };
}

describe('RemotePlanner (the care team ranks, the server checks)', () => {
  it('sends the facts and keeps the care team order and reasons', async () => {
    const { planner, calls } = answering({
      engine: 'strands-graph',
      options: [
        { slotId: THU_EARLY, driverId: 'maya', reason: 'Earliest Thursday slot; Maya is free.' },
        { slotId: TUE, driverId: 'maya', reason: 'Tuesday works for Maya too.' },
        { slotId: MON, driverId: null, reason: 'Monday by taxi.' }
      ]
    });
    const steps: string[] = [];
    const options = await planner.plan(req, s => steps.push(s));
    expect(steps).toEqual(['clinic', 'calendar', 'transport', 'planner']);
    expect(calls[0]).toMatchObject({ recipient: 'Rose', clinic: { name: 'Riverside Heart Clinic' }, travelMinutes: 25, maxOptions: 3 });
    expect(calls[0].slots.find((s: any) => s.id === TUE)).toMatchObject({ day: 'Tuesday', leaveAt: '10:05', drivers: [{ id: 'maya', name: 'Maya' }] });
    expect(options.map(o => [o.label, o.reason])).toEqual([
      ['Thu 9:15 am with Dr Mehta, Maya drives', 'Earliest Thursday slot; Maya is free.'],
      ['Tue 10:30 am with Dr Rao, Maya drives', 'Tuesday works for Maya too.'],
      ['Mon 9:30 am with Dr Mehta, taxi', 'Monday by taxi.']
    ]);
  });

  it('drops invented slots, slots outside the constraints and drivers who are not free, then tops up locally', async () => {
    const { planner } = answering({
      options: [
        { slotId: '2026-10-14T08:00-riverside-heart-dr-who', driverId: 'maya', reason: 'Invented.' },
        { slotId: TUE_AFTERNOON, driverId: null, reason: 'Afternoon, but mornings were asked for.' },
        { slotId: MON, driverId: 'maya', reason: 'Maya is not free on Monday.' },
        { slotId: THU_LATE, driverId: 'maya', reason: 'Late Thursday morning with Maya.' }
      ]
    });
    const options = await planner.plan(req);
    expect(options.map(o => o.label)).toEqual([
      'Thu 11:30 am with Dr Rao, Maya drives',
      'Tue 10:30 am with Dr Rao, Maya drives',
      'Thu 9:15 am with Dr Mehta, Maya drives'
    ]);
    expect(options.map(o => o.rank)).toEqual([1, 2, 3]);
  });

  it('ranks locally when the care team fails or has nothing usable', async () => {
    const local = ['Tue 10:30 am with Dr Rao, Maya drives', 'Thu 9:15 am with Dr Mehta, Maya drives', 'Thu 11:30 am with Dr Rao, Maya drives'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const answer of [new Error('connect ECONNREFUSED'), { options: [] }, { options: [{ slotId: TUE, driverId: 'maya', reason: 42 }] }]) {
      const { planner } = answering(answer as CareTeamAnswer | Error);
      expect((await planner.plan(req)).map(o => o.label)).toEqual(local);
    }
    const { planner } = answering({ options: [] }, 500);
    expect((await planner.plan(req)).map(o => o.label)).toEqual(local);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe('plannedBy', () => {
  it('names the care team engine for its picks and "local" for top-ups and fallbacks', async () => {
    const { planner } = answering({ engine: 'strands-graph:deterministic', options: [{ slotId: THU_LATE, driverId: 'maya', reason: 'Late Thursday morning.' }] });
    expect((await planner.plan(req)).map(o => o.plannedBy)).toEqual(['strands-graph:deterministic', 'local', 'local']);
  });
});
