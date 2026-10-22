import * as z from 'zod';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { HelperTask, Visit } from '../store/types.js';
import {
  LocalPlanner,
  dayName,
  mockAppointmentServices,
  parseWindow,
  type AppointmentOption,
  type AppointmentPlanner,
  type PlanStep
} from '../domain/appointments.js';
import { spokenDate, spokenTime } from '../domain/time.js';
import { listJoin, plural, sentences } from '../domain/speech.js';
import { uiMeta } from './apps.js';
import { CareError, guarded, ok, requireRole, resolveCaller, type Caller, type Deps } from './context.js';
import { TaskCancelled, installTasks, type TaskHandle } from './tasks.js';
import { withPreferences } from './preferences.js';

/** Options shown to the person stay valid for a voice "yes" this long. */
export const OPTIONS_VALID_MINUTES = 30;

export const STEP_MESSAGES: Record<PlanStep, string> = {
  clinic: 'Checking the clinic…',
  calendar: 'Checking who can drive…',
  transport: 'Working out the ride…',
  planner: 'Ranking the options…'
};

const OptionOut = z.object({
  id: z.string(),
  rank: z.number(),
  date: z.string(),
  time: z.string(),
  clinic: z.string(),
  specialty: z.string(),
  doctor: z.string(),
  driver: z.string().optional().describe('Who drives; absent means a taxi'),
  leaveAt: z.string(),
  label: z.string(),
  reason: z.string()
});

const AppointmentOut = z.object({
  id: z.string(),
  date: z.string(),
  time: z.string(),
  clinic: z.string(),
  doctor: z.string(),
  purpose: z.string(),
  driver: z.string().optional(),
  leaveAt: z.string()
});

const HelperTaskOut = z.object({ id: z.string(), assignee: z.string(), text: z.string(), date: z.string(), time: z.string() });

export const InputSchema = z.object({
  specialty: z.string().min(2).max(60).describe("The kind of appointment, e.g. 'cardiology follow-up'"),
  window: z.string().max(60).default('next week').describe("When, e.g. 'next week', 'this week'"),
  constraints: z.string().max(200).optional().describe("Anything the person asked for, e.g. 'mornings only', 'not Friday'"),
  option_id: z
    .string()
    .max(120)
    .optional()
    .describe('Voice-only clients: the id of the option the person picked from a needs_choice result'),
  confirm: z
    .boolean()
    .default(false)
    .describe('Voice-only clients: true only after the person clearly said yes to that option. Ignored when the client supports elicitation: the person picks on the form.')
});
type Args = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  result: z.enum(['booked', 'needs_choice', 'declined', 'already_booked', 'no_options']),
  options: z.array(OptionOut),
  question: z.string().optional().describe('When result is needs_choice: ask this, then call again with option_id and confirm true after a clear yes'),
  appointment: AppointmentOut.optional(),
  helperTask: HelperTaskOut.optional()
});

/** How the person gets asked to pick: a form now, a task's input step, or not at all (voice). */
type Choice = { kind: 'chosen'; optionId: string } | { kind: 'declined' } | { kind: 'unavailable' };
type Chooser = (message: string, options: AppointmentOption[]) => Promise<Choice>;

interface Hooks {
  step(step: PlanStep): void;
  choose: Chooser;
  signal?: AbortSignal;
}

function plannerOf(deps: Deps): AppointmentPlanner {
  return (deps.appointmentPlanner ??= new LocalPlanner(mockAppointmentServices()));
}

function formSupported(server: McpServer): boolean {
  const caps = server.server.getClientCapabilities()?.elicitation as { form?: object; url?: object } | undefined;
  return !!caps && (!!caps.form || !caps.url);
}

/** The slot picker. Up to three ranked options; declining books nothing. */
async function pickOnForm(ctx: ServerContext, message: string, options: AppointmentOption[], meta?: Record<string, unknown>): Promise<Choice> {
  const reply = await ctx.mcpReq.elicitInput({
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        option: {
          type: 'string',
          title: 'Appointment',
          description: options.map(o => `${o.label}: ${o.reason}`).join(' '),
          oneOf: options.map(o => ({ const: o.id, title: o.label }))
        }
      },
      required: ['option']
    },
    ...(meta ? { _meta: meta } : {})
  });
  const picked = (reply.content as { option?: unknown } | undefined)?.option;
  if (reply.action !== 'accept' || typeof picked !== 'string') return { kind: 'declined' };
  return { kind: 'chosen', optionId: picked };
}

function optionOut(o: AppointmentOption) {
  return {
    id: o.id,
    rank: o.rank,
    date: o.date,
    time: o.time,
    clinic: o.clinic,
    specialty: o.specialty,
    doctor: o.doctor,
    ...(o.driver ? { driver: o.driver.name } : {}),
    leaveAt: o.leaveAt,
    label: o.label,
    reason: o.reason
  };
}

const titleCase = (s: string) => s[0].toUpperCase() + s.slice(1);

/** "cardiology follow-up" from what the person said, or the clinic's specialty plus "appointment". */
function purposeOf(specialty: string, clinicSpecialty: string): string {
  return /follow[- ]?up/i.test(specialty) ? `${clinicSpecialty} follow-up` : `${clinicSpecialty} appointment`;
}

/**
 * Plans, asks, books. Nothing is written to the store unless the person picked an
 * option: on the form, in the task's input step, or (voice) by naming an option this
 * server offered them in the last half hour and saying yes.
 */
export async function coordinateAppointment(deps: Deps, caller: Caller, args: Args, hooks: Hooks): Promise<CallToolResult> {
  requireRole(caller, ['recipient', 'coordinator'], 'book appointments');
  const members = await deps.store.listMembers(caller.family.id);
  const window = parseWindow(args.window, caller.local.date);
  // What the person asked for wins; stored preferences ("Mom prefers mornings") fill the gaps.
  const { constraints, used } = await withPreferences(deps, caller, args.constraints);
  const recipient = caller.recipient.name;
  const whose = caller.isRecipient ? 'your' : `${recipient}'s`;

  const options = await plannerOf(deps).plan(
    {
      familyId: caller.family.id,
      recipientName: recipient,
      specialty: args.specialty,
      window,
      constraints,
      members: members.map(m => ({ id: m.id, name: m.name }))
    },
    step => hooks.step(step)
  );
  const base = { options: options.map(optionOut) };
  const prefers = used.length ? `, as ${caller.isRecipient ? 'you prefer' : `${recipient} prefers`}` : '';
  const wanted = constraints.understood.length ? `, ${listJoin(constraints.understood)}${prefers}` : '';
  if (options.length === 0) {
    return ok({ ...base, result: 'no_options' as const }, `I couldn't find a ${args.specialty} slot ${window.label}${wanted}. Should I look at a different week?`);
  }

  const purpose = purposeOf(args.specialty, options[0].specialty);
  const message = `I found ${plural(options.length, 'time')} for ${whose} ${purpose} ${window.label}${wanted}. Pick one, or decline and I won't book anything.`;
  const choice = await hooks.choose(message, options);
  if (hooks.signal?.aborted) throw new TaskCancelled();

  let picked: AppointmentOption | undefined;
  if (choice.kind === 'declined') {
    return ok({ ...base, result: 'declined' as const }, `Okay, I haven't booked anything.`);
  } else if (choice.kind === 'chosen') {
    picked = options.find(o => o.id === choice.optionId);
    if (!picked) return ok({ ...base, result: 'declined' as const }, `That time isn't one I offered, so I haven't booked anything.`);
  } else {
    // Voice only. The option must be one this server offered this family recently, and still be open.
    const issued = (deps.issuedAppointmentOptions ??= new Map()).get(caller.family.id);
    const fresh = issued && caller.now.getTime() - issued.at <= OPTIONS_VALID_MINUTES * 60_000;
    if (args.option_id && args.confirm && fresh && issued.ids.has(args.option_id)) picked = options.find(o => o.id === args.option_id);
    if (!picked) {
      deps.issuedAppointmentOptions.set(caller.family.id, { at: caller.now.getTime(), ids: new Set(options.map(o => o.id)) });
      const spoken = options.map((o, i) => `${['First', 'Second', 'Third'][i]}, ${dayName(o.date)} at ${spokenTime(o.time)} with ${o.doctor}, ${o.driver ? `${o.driver.name} drives` : 'by taxi'}.`);
      const question = `Which one should I book?`;
      return ok({ ...base, result: 'needs_choice' as const, question }, sentences(`I found ${plural(options.length, 'time')} for ${whose} ${purpose}${wanted}.`, ...spoken, question));
    }
  }

  // Book: the visit, and a task for whoever drives. Booking the same slot twice never doubles up.
  const existing = (await deps.store.listVisits(caller.family.id, picked.date, picked.date)).find(
    v => v.kind === 'appointment' && v.time === picked.time && v.place === picked.clinic
  );
  if (existing) {
    return ok(
      { ...base, result: 'already_booked' as const, appointment: appointmentOut(existing, picked) },
      `That's already booked: ${spokenDate(picked.date, caller.local.date)} at ${spokenTime(picked.time)}. I haven't booked it again.`
    );
  }
  const stamp = caller.now.getTime().toString(36);
  const visit: Visit = {
    id: `appt-${stamp}-${picked.time.replace(':', '')}`,
    familyId: caller.family.id,
    date: picked.date,
    time: picked.time,
    who: caller.recipient.id,
    purpose: `${titleCase(purpose)} with ${picked.doctor}`,
    kind: 'appointment',
    place: picked.clinic,
    doctor: picked.doctor,
    bookedBy: caller.member.id
  };
  await deps.store.addVisit(visit);
  let task: HelperTask | undefined;
  if (picked.driver) {
    task = {
      id: `task-${stamp}-${picked.driver.id}`,
      familyId: caller.family.id,
      assigneeId: picked.driver.id,
      text: `Drive ${recipient} to ${picked.clinic}`,
      date: picked.date,
      time: picked.leaveAt,
      visitId: visit.id,
      createdBy: caller.member.id,
      createdAt: caller.now.toISOString()
    };
    await deps.store.addHelperTask(task);
  }
  deps.issuedAppointmentOptions?.delete(caller.family.id);

  const driver = picked.driver ? members.find(m => m.id === picked.driver!.id) : undefined;
  const when = `${spokenDate(picked.date, caller.local.date)} at ${spokenTime(picked.time)}`;
  const ride = driver
    ? `${driver.id === caller.member.id ? "You're" : `${driver.name} is`} driving, leaving at ${spokenTime(picked.leaveAt)}.`
    : `No one is free to drive, so plan a taxi; it's about ${picked.travelMinutes} minutes.`;
  return ok(
    {
      ...base,
      result: 'booked' as const,
      appointment: appointmentOut(visit, picked),
      ...(task ? { helperTask: { id: task.id, assignee: driver?.name ?? task.assigneeId, text: task.text, date: task.date, time: task.time } } : {})
    },
    sentences(`Booked: ${whose} ${purpose} with ${picked.doctor} at ${picked.clinic}, ${when}.`, ride)
  );
}

function appointmentOut(visit: Visit, option: AppointmentOption) {
  return {
    id: visit.id,
    date: visit.date,
    time: visit.time,
    clinic: visit.place ?? option.clinic,
    doctor: visit.doctor ?? option.doctor,
    purpose: visit.purpose,
    ...(option.driver ? { driver: option.driver.name } : {}),
    leaveAt: option.leaveAt
  };
}

export function registerAppointmentTools(server: McpServer, deps: Deps): void {
  const tool = server.registerTool(
    'coordinate_appointment',
    {
      title: 'Book an appointment and a ride',
      description:
        "Find and book a doctor's appointment for the care recipient, and sort out who drives them. Use for 'Book Mom's cardiology follow-up next week, mornings only, and sort out a ride'. Checks the clinic, the family's calendars and travel time, then offers up to three ranked options. Nothing is booked until the person picks one: clients with elicitation get a picker form; otherwise, if this returns needs_choice, read the options, and call again with option_id and confirm true only after a clear yes. Supports MCP Tasks: send a task param to run it in the background.",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: { title: 'Book an appointment and a ride', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      // Bookings go through the conversation and its picker, never straight from a view.
      _meta: uiMeta(['model'])
    },
    guarded(async (args: Args, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let progress = 0;
      return coordinateAppointment(deps, caller, args, {
        step: step => {
          if (progressToken === undefined) return;
          void ctx.mcpReq
            .notify({ method: 'notifications/progress', params: { progressToken, progress: ++progress, total: 4, message: STEP_MESSAGES[step] } })
            .catch(() => undefined);
        },
        choose: async (message, options) => {
          if (!formSupported(server)) return { kind: 'unavailable' };
          try {
            return await pickOnForm(ctx, message, options);
          } catch (err) {
            console.warn('[carecircle] appointment picker failed, asking by voice instead', err);
            return { kind: 'unavailable' };
          }
        }
      });
    })
  );
  // registerTool() drops `execution` (SDK 2.3.1), so set it on the registered tool for tools/list.
  (tool as unknown as { execution?: object }).execution = { taskSupport: 'optional' };

  installTasks(server, deps, {
    coordinate_appointment: {
      parse: args => InputSchema.parse(args),
      run: async (args, ctx, handle: TaskHandle) => {
        let caller: Caller;
        try {
          caller = await resolveCaller(ctx, deps);
        } catch (err) {
          if (err instanceof CareError) return { content: [{ type: 'text', text: err.message }], isError: true };
          throw err;
        }
        const canAsk = formSupported(server);
        try {
          return await coordinateAppointment(deps, caller, args as Args, {
            step: step => handle.status(STEP_MESSAGES[step]),
            signal: handle.signal,
            choose: async (message, options) => {
              if (!canAsk) return { kind: 'unavailable' };
              return handle.input(message, askCtx => pickOnForm(askCtx, message, options, { 'io.modelcontextprotocol/related-task': { taskId: handle.taskId } }));
            }
          });
        } catch (err) {
          if (err instanceof CareError) return { content: [{ type: 'text', text: err.message }], isError: true };
          throw err;
        }
      }
    }
  });
}
