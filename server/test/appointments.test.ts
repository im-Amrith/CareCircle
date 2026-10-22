import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { LocalPlanner, mockAppointmentServices, parseConstraints, parseWindow } from '../src/domain/appointments.js';
import { createCareCircleServer } from '../src/mcp/server.js';
import { TaskRegistry } from '../src/mcp/tasks.js';
import type { Deps } from '../src/mcp/context.js';
import { makeClock } from '../src/config.js';
import type { MemoryStore } from '../src/store/memory.js';
import { NINE_AM_IST, call, connect, said, seededStore, startServer } from './helpers.js';

// 09:00 on Saturday 10 October 2026 in Asia/Kolkata: "next week" is Mon 12 to Sun 18.
const TODAY = '2026-10-10';
const BOOK = { specialty: 'cardiology follow-up', window: 'next week', constraints: 'mornings only' };
const members = [
  { id: 'rose', name: 'Rose' },
  { id: 'sam', name: 'Sam' },
  { id: 'maya', name: 'Maya' }
];

const appointmentsIn = (store: MemoryStore) => store.visits.filter(v => v.kind === 'appointment');

describe('appointment planning (mock services, deterministic planner)', () => {
  const planner = new LocalPlanner(mockAppointmentServices());
  const plan = (constraints?: string, specialty = 'cardiology follow-up') =>
    planner.plan({
      familyId: 'fam-rose',
      recipientName: 'Rose',
      specialty,
      window: parseWindow('next week', TODAY),
      constraints: parseConstraints(constraints),
      members
    });

  it('reads "next week" and "mornings only"', () => {
    expect(parseWindow('next week', TODAY)).toMatchObject({ from: '2026-10-12', to: '2026-10-18' });
    expect(parseConstraints('mornings only')).toMatchObject({ latest: '11:59', understood: ['mornings'] });
    expect(parseConstraints('afternoons, not Friday').weekdays).toEqual([1, 2, 3, 4]);
    // A "not" a few words before the day still excludes it, rather than turning into "only".
    expect(parseConstraints('she would rather not go on Thursdays').weekdays).toEqual([1, 2, 3, 5]);
    expect(parseConstraints('never Mondays').weekdays).toEqual([2, 3, 4, 5]);
    expect(parseConstraints('Tuesday or Thursday').weekdays).toEqual([2, 4]);
    // Words between a "not" and the day don't reach across to an unrelated day.
    expect(parseConstraints("not too early, and Tuesday is best").weekdays).toEqual([2]);
  });

  it('returns three morning options, with Maya driving, best first', async () => {
    const options = await plan('mornings');
    expect(options).toHaveLength(3);
    expect(options.map(o => o.label)).toEqual([
      'Tue 10:30 am with Dr Rao, Maya drives',
      'Thu 9:15 am with Dr Mehta, Maya drives',
      'Thu 11:30 am with Dr Rao, Maya drives'
    ]);
    for (const o of options) expect(Number(o.time.slice(0, 2))).toBeLessThan(12);
    expect(options[0]).toMatchObject({ date: '2026-10-13', leaveAt: '10:05', clinic: 'Riverside Heart Clinic', driver: { id: 'maya' } });
    expect(options[0].reason).toMatch(/Maya is free Tuesday morning/);
  });

  it('falls back to a taxi when no one can drive', async () => {
    const options = await plan('afternoons');
    expect(options.every(o => o.driver === null)).toBe(true);
    expect(options[0].reason).toMatch(/taxi/);
  });

  it('finds nothing for a specialty it does not know', async () => {
    expect(await plan('mornings', 'dermatology')).toEqual([]);
  });
});

describe('coordinate_appointment without a task (voice and form)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.stop();
  });
  beforeEach(() => {
    srv.store.visits = srv.store.visits.filter(v => v.kind !== 'appointment');
    srv.store.helperTasks = [];
  });

  it('is listed with task support and an open-world hint', async () => {
    const sam = await connect(srv.url, 'sam');
    const tool = (await sam.listTools()).tools.find(t => t.name === 'coordinate_appointment')!;
    expect(tool.annotations?.openWorldHint).toBe(true);
    expect((tool as { execution?: unknown }).execution).toEqual({ taskSupport: 'optional' });
    expect(sam.getServerCapabilities()?.tasks).toMatchObject({ cancel: {}, requests: { tools: { call: {} } } });
    await sam.close();
  });

  it('voice: offers options, books nothing until a yes to an offered option', async () => {
    const sam = await connect(srv.url, 'sam');
    const first = await call(sam, 'coordinate_appointment', BOOK);
    expect(first.structuredContent?.result).toBe('needs_choice');
    expect(first.structuredContent?.options).toHaveLength(3);
    expect(said(first)).toMatch(/First, Tuesday at 10:30 am with Dr Rao, Maya drives/);
    expect(appointmentsIn(srv.store)).toHaveLength(0);

    const pick = first.structuredContent!.options[0].id;
    // An option without the yes is not a booking.
    expect((await call(sam, 'coordinate_appointment', { ...BOOK, option_id: pick })).structuredContent?.result).toBe('needs_choice');
    // A made-up option is not a booking, even with confirm.
    expect((await call(sam, 'coordinate_appointment', { ...BOOK, option_id: '2026-10-14T11:00-x', confirm: true })).structuredContent?.result).toBe('needs_choice');
    expect(appointmentsIn(srv.store)).toHaveLength(0);

    const booked = await call(sam, 'coordinate_appointment', { ...BOOK, option_id: pick, confirm: true });
    expect(booked.structuredContent).toMatchObject({
      result: 'booked',
      appointment: { date: '2026-10-13', time: '10:30', clinic: 'Riverside Heart Clinic', doctor: 'Dr Rao', driver: 'Maya', leaveAt: '10:05' },
      helperTask: { assignee: 'Maya', text: 'Drive Rose to Riverside Heart Clinic', date: '2026-10-13', time: '10:05' }
    });
    expect(said(booked)).toBe("Booked: Rose's cardiology follow-up with Dr Rao at Riverside Heart Clinic, Tuesday at 10:30 am. Maya is driving, leaving at 10:05 am.");
    expect(appointmentsIn(srv.store)).toHaveLength(1);
    expect(srv.store.helperTasks).toHaveLength(1);

    // It shows in the care status, and Maya hears she's driving.
    const status = await call(sam, 'get_care_status');
    expect(status.structuredContent?.appointments).toEqual([
      expect.objectContaining({ date: '2026-10-13', time: '10:30', place: 'Riverside Heart Clinic', driver: 'Maya', leaveAt: '10:05' })
    ]);
    expect(said(status)).toMatch(/Cardiology follow-up with Dr Rao on Tuesday at 10:30 am. Maya is driving./);
    const maya = await connect(srv.url, 'maya');
    expect(said(await call(maya, 'get_care_status'))).toMatch(/You're driving/);
    await maya.close();
    await sam.close();
  });

  it('voice: a model that sends confirm on the first call still gets the question', async () => {
    const sam = await connect(srv.url, 'sam');
    const r = await call(sam, 'coordinate_appointment', { ...BOOK, option_id: '2026-10-13T10:30-riverside-heart-dr-rao-maya', confirm: true });
    expect(r.structuredContent?.result).toBe('needs_choice');
    expect(appointmentsIn(srv.store)).toHaveLength(0);
    await sam.close();
  });

  it('form: the person picks on the picker; declining books nothing', async () => {
    const answers: ('decline' | number)[] = ['decline', 1];
    const seen: any[] = [];
    const sam = await connect(
      srv.url,
      'sam',
      client =>
        client.setRequestHandler('elicitation/create', async request => {
          seen.push(request.params);
          const answer = answers.shift();
          if (answer === 'decline') return { action: 'decline' };
          const schema = (request.params as any).requestedSchema.properties.option;
          return { action: 'accept', content: { option: schema.oneOf[answer!].const } };
        }),
      { elicitation: { form: {} } }
    );
    // confirm: true from the model doesn't skip the picker.
    const declined = await call(sam, 'coordinate_appointment', { ...BOOK, confirm: true });
    expect(declined.structuredContent?.result).toBe('declined');
    expect(appointmentsIn(srv.store)).toHaveLength(0);
    expect(seen[0].message).toMatch(/three times for Rose's cardiology follow-up next week, mornings/);
    expect(seen[0].requestedSchema.properties.option.oneOf.map((o: any) => o.title)).toEqual([
      'Tue 10:30 am with Dr Rao, Maya drives',
      'Thu 9:15 am with Dr Mehta, Maya drives',
      'Thu 11:30 am with Dr Rao, Maya drives'
    ]);

    const booked = await call(sam, 'coordinate_appointment', BOOK);
    expect(booked.structuredContent).toMatchObject({ result: 'booked', appointment: { date: '2026-10-15', time: '09:15', doctor: 'Dr Mehta' } });
    expect(appointmentsIn(srv.store)).toHaveLength(1);
    await sam.close();
  });

  it('helpers cannot book', async () => {
    const maya = await connect(srv.url, 'maya');
    const r = await call(maya, 'coordinate_appointment', BOOK);
    expect(r.isError).toBe(true);
    expect(said(r)).toMatch(/can't book appointments/);
    await maya.close();
  });
});

/* ---------- MCP Tasks, over raw JSON-RPC ---------- */

/**
 * The 2.3.1 TypeScript client rejects a CreateTaskResult from tools/call (FL-13), so
 * these tests speak JSON-RPC directly to the server over an in-memory transport.
 */
async function rawClient(deps: Deps, opts: { elicit?: (params: any) => any } = {}) {
  const server = createCareCircleServer(deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const pending = new Map<number, (msg: any) => void>();
  const notifications: any[] = [];
  const elicitations: any[] = [];
  let nextId = 1;
  clientSide.onmessage = (msg: any) => {
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if ('id' in msg && msg.method === 'elicitation/create') {
      elicitations.push(msg.params);
      void clientSide.send({ jsonrpc: '2.0', id: msg.id, result: opts.elicit?.(msg.params) ?? { action: 'decline' } } as JSONRPCMessage);
    } else if (!('id' in msg)) {
      notifications.push(msg);
    }
  };
  await clientSide.start();
  const request = (method: string, params: object = {}) =>
    new Promise<any>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
    clientInfo: { name: 'raw-tasks-test', version: '0' }
  });
  expect(init.result?.capabilities?.tasks).toBeDefined();
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

  async function waitFor(taskId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const r = await request('tasks/get', { taskId });
      if (r.result?.status === status) return r.result;
      await new Promise(res => setTimeout(res, 10));
    }
    throw new Error(`task ${taskId} never reached ${status}`);
  }
  return { request, notifications, elicitations, waitFor, close: () => server.close() };
}

describe('coordinate_appointment as an MCP Task', () => {
  let store: MemoryStore;
  let deps: Deps;
  beforeEach(() => {
    store = seededStore();
    deps = { store, clock: makeClock(NINE_AM_IST), defaultUser: 'sam', tasks: new TaskRegistry() };
  });
  const pickFirst = (params: any) => ({ action: 'accept', content: { option: params.requestedSchema.properties.option.oneOf[0].const } });
  const startTask = (c: Awaited<ReturnType<typeof rawClient>>) =>
    c.request('tools/call', { name: 'coordinate_appointment', arguments: BOOK, task: { ttl: 60_000 } });

  it('returns a task handle at once, moves working -> input_required -> completed, and books on the pick', async () => {
    const c = await rawClient(deps, { elicit: pickFirst });
    const created = await startTask(c);
    expect(created.result.task).toMatchObject({ status: 'working', ttl: 60_000, pollInterval: 1000 });
    const taskId = created.result.task.taskId;

    const waiting = await c.waitFor(taskId, 'input_required');
    expect(waiting.statusMessage).toMatch(/Pick one/);
    expect(appointmentsIn(store)).toHaveLength(0);

    const result = await c.request('tasks/result', { taskId });
    expect(c.elicitations).toHaveLength(1);
    expect(c.elicitations[0]._meta['io.modelcontextprotocol/related-task']).toEqual({ taskId });
    expect(result.result.structuredContent).toMatchObject({ result: 'booked', appointment: { date: '2026-10-13', time: '10:30' } });
    expect(result.result._meta['io.modelcontextprotocol/related-task']).toEqual({ taskId });
    expect((await c.request('tasks/get', { taskId })).result.status).toBe('completed');
    expect(appointmentsIn(store)).toHaveLength(1);

    const statuses = c.notifications.filter(n => n.method === 'notifications/tasks/status').map(n => n.params.statusMessage ?? n.params.status);
    expect(statuses.slice(0, 4)).toEqual(['Checking the clinic…', 'Checking who can drive…', 'Working out the ride…', 'Ranking the options…']);
    expect(c.notifications.filter(n => n.method === 'notifications/tasks/status').map(n => n.params.status)).toEqual(
      expect.arrayContaining(['working', 'input_required', 'completed'])
    );
    await c.close();
  });

  it('declining on the picker completes the task without booking', async () => {
    const c = await rawClient(deps, { elicit: () => ({ action: 'decline' }) });
    const taskId = (await startTask(c)).result.task.taskId;
    await c.waitFor(taskId, 'input_required');
    const result = await c.request('tasks/result', { taskId });
    expect(result.result.structuredContent.result).toBe('declined');
    expect((await c.request('tasks/get', { taskId })).result.status).toBe('completed');
    expect(appointmentsIn(store)).toHaveLength(0);
    expect(store.helperTasks).toHaveLength(0);
    await c.close();
  });

  it('cancelling while it waits for a pick books nothing, and cannot be cancelled twice', async () => {
    const c = await rawClient(deps, { elicit: pickFirst });
    const taskId = (await startTask(c)).result.task.taskId;
    await c.waitFor(taskId, 'input_required');
    const cancelled = await c.request('tasks/cancel', { taskId });
    expect(cancelled.result.status).toBe('cancelled');
    const result = await c.request('tasks/result', { taskId });
    expect(result.result.isError).toBe(true);
    expect(c.elicitations).toHaveLength(0);
    expect(appointmentsIn(store)).toHaveLength(0);
    expect((await c.request('tasks/cancel', { taskId })).error.code).toBe(-32602);
    await c.close();
  });

  it('without elicitation, the task completes with needs_choice and books nothing', async () => {
    const c = await rawClient(deps);
    const taskId = (await startTask(c)).result.task.taskId;
    const result = await c.request('tasks/result', { taskId });
    expect(result.result.structuredContent.result).toBe('needs_choice');
    expect(appointmentsIn(store)).toHaveLength(0);
    await c.close();
  });

  it("keeps each member's tasks to themselves", async () => {
    const sam = await rawClient(deps, { elicit: pickFirst });
    const taskId = (await startTask(sam)).result.task.taskId;
    const maya = await rawClient({ ...deps, defaultUser: 'maya' });
    expect((await maya.request('tasks/get', { taskId })).error.code).toBe(-32602);
    expect((await maya.request('tasks/cancel', { taskId })).error.code).toBe(-32602);
    expect((await maya.request('tasks/list')).result.tasks).toEqual([]);
    expect((await sam.request('tasks/list')).result.tasks.map((t: any) => t.taskId)).toEqual([taskId]);
    await sam.close();
    await maya.close();
  });

  it('still runs synchronously when the client does not ask for a task', async () => {
    const c = await rawClient(deps);
    const r = await c.request('tools/call', { name: 'coordinate_appointment', arguments: BOOK, _meta: { progressToken: 'p1' } });
    expect(r.result.structuredContent.result).toBe('needs_choice');
    const progress = c.notifications.filter(n => n.method === 'notifications/progress').map(n => n.params.message);
    expect(progress).toEqual(['Checking the clinic…', 'Checking who can drive…', 'Working out the ride…', 'Ranking the options…']);
    await c.close();
  });
});
