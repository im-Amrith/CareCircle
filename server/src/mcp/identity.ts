/**
 * "Who's speaking?": identity-aware safety for a shared household device.
 *
 * Each request says how sure the device is about who is speaking (see http/auth.ts).
 * The rules live here, in front of every tool, not in the model:
 *
 * - Read tools work at any confidence.
 * - Change tools at high confidence run as usual.
 * - At low confidence nothing changes until the person says who they are: a form
 *   offering only the household members the match was unsure between, or, on a client
 *   without forms, a confirmation on their phone through URL elicitation.
 * - At unknown confidence the change is refused, recorded in the care log, and listed
 *   in the next family summary.
 *
 * A tool missing from TOOL_KINDS counts as a change (fail closed), and a test fails
 * until it is classified.
 */
import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { Member, SpeakerConfidence, VoiceCheck } from '../store/types.js';
import { isGenericPhrase, matchMedication, slotToLog } from '../domain/care.js';
import { hashToken, newCheckoutToken } from '../domain/refill.js';
import { listJoin, sentences } from '../domain/speech.js';
import { spokenTime } from '../domain/time.js';
import { CareError, fail, resolveCaller, type Caller, type Deps } from './context.js';
import { elicitationSupport } from './refills.js';
import { todayContext } from './status.js';

export type ToolKind = 'read' | 'change';

/** Every tool, by whether it changes anything. Keep in step with the tools the server registers. */
export const TOOL_KINDS: Record<string, ToolKind> = {
  get_care_status: 'read',
  list_medications: 'read',
  check_refills: 'read',
  log_medication: 'change',
  log_wellbeing: 'change',
  request_refill: 'change',
  coordinate_appointment: 'change',
  set_language: 'change',
  set_care_preference: 'change',
  send_daily_summary: 'change'
};

export function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'change';
}

export interface SpeakerMatch {
  confidence: SpeakerConfidence;
  /** With low: the household members the match was unsure between */
  candidates: string[];
}

/** The speaker match a request came with. No match (stdio, tests, older clients) means high. */
export function speakerFrom(ctx: ServerContext | undefined): SpeakerMatch {
  const speaker = (ctx?.http?.authInfo?.extra as { speaker?: Partial<SpeakerMatch> } | undefined)?.speaker;
  const confidence = speaker?.confidence === 'low' || speaker?.confidence === 'unknown' ? speaker.confidence : 'high';
  return { confidence, candidates: Array.isArray(speaker?.candidates) ? speaker.candidates.filter(c => typeof c === 'string') : [] };
}

/** The same request, now from a member the person confirmed they are. */
function asMember(ctx: ServerContext, userId: string): ServerContext {
  const authInfo = ctx.http?.authInfo;
  const extra = { ...(authInfo?.extra ?? {}), userId, speaker: { confidence: 'high', candidates: [], confirmed: true } };
  return { ...ctx, http: { ...ctx.http, authInfo: { ...(authInfo ?? { token: 'confirmed', clientId: 'carecircle', scopes: [] }), extra } } } as ServerContext;
}

/* ---------- what was asked, in words ---------- */

/** "log Rose's 8 am Metformin": the change, said the way the family summary says it. */
export async function describeAttempt(deps: Deps, caller: Caller, tool: string, args: Record<string, unknown>): Promise<string> {
  const name = caller.recipient.name;
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  switch (tool) {
    case 'log_medication': {
      const { meds, states } = await todayContext(deps, caller, caller.local.date);
      const ids = Array.isArray(args.medication_ids) ? (args.medication_ids as unknown[]).filter(i => typeof i === 'string') : [];
      const spoken = text('spoken_name');
      let targets = meds.filter(m => ids.includes(m.id));
      if (!targets.length && spoken && !isGenericPhrase(spoken)) targets = matchMedication(meds, spoken).matches;
      const asked = text('slot');
      const slot = asked ?? slotToLog(states, caller.family, caller.now);
      if (!targets.length && slot) targets = meds.filter(m => m.schedule.some(s => s.slot === slot));
      if (!targets.length) return `log a dose for ${name}`;
      const doses = targets.map(m => {
        const own = states.filter(s => s.medicationId === m.id);
        const pick = (asked && own.find(s => s.slot === asked)) || own.find(s => s.status === 'due') || own.find(s => s.status === 'upcoming') || own[0];
        return { name: m.name, time: pick?.time };
      });
      const times = [...new Set(doses.map(d => d.time))];
      const when = times.length === 1 && times[0] ? `${spokenTime(times[0])} ` : '';
      const verb = args.status === 'skipped' ? 'mark' : 'log';
      return `${verb} ${name}'s ${when}${listJoin(doses.map(d => d.name))}${args.status === 'skipped' ? ' as skipped' : ''}`;
    }
    case 'log_wellbeing':
      return `add a note about how ${name} is feeling`;
    case 'request_refill': {
      const spoken = text('spoken_name');
      const meds = await deps.store.listMedications(caller.family.id);
      const med = meds.find(m => m.id === text('medication_id')) ?? (spoken ? matchMedication(meds, spoken).matches[0] : undefined);
      return med ? `reorder ${name}'s ${med.name}` : `reorder one of ${name}'s medicines`;
    }
    case 'coordinate_appointment':
      return `book ${name}'s ${text('specialty') ?? 'appointment'}`;
    case 'set_language':
      return `change the language CareCircle speaks`;
    case 'set_care_preference':
      return `change ${name}'s care preferences`;
    case 'send_daily_summary':
      return `send the family summary`;
    default:
      return `change ${name}'s care plan`;
  }
}

/* ---------- the care log ---------- */

async function record(deps: Deps, caller: Caller, confidence: VoiceCheck['confidence'], tool: string, attempted: string): Promise<void> {
  await deps.store.addVoiceCheck({
    id: `voice-${caller.now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
    familyId: caller.family.id,
    at: caller.now.toISOString(),
    date: caller.local.date,
    time: caller.local.time,
    device: caller.member.id,
    confidence,
    tool,
    attempted
  });
}

/** "An unrecognised voice tried to log Rose's 8 am Metformin." */
export function voiceCheckSentence(check: VoiceCheck): string {
  return `An unrecognised voice tried to ${check.attempted} at ${spokenTime(check.time)}. Nothing was changed.`;
}

function refused(caller: Caller, attempted: string): CallToolResult {
  return fail(
    caller.lang === 'hi'
      ? 'माफ़ कीजिए, मैं यह आवाज़ पहचान नहीं पाई, इसलिए मैंने कुछ नहीं बदला। मैंने इसे परिवार के लिए देखभाल लॉग में दर्ज कर दिया है। आप अब भी हाल-चाल पूछ सकते हैं।'
      : sentences(
          `Sorry, I don't recognise this voice, so I can't ${attempted}.`,
          `I've noted it in the care log for the family.`,
          `You can still ask how ${caller.recipient.name} is doing.`
        )
  );
}

function unchanged(caller: Caller, why: string): CallToolResult {
  return fail(caller.lang === 'hi' ? 'ठीक है, मैंने कुछ नहीं बदला।' : why);
}

/* ---------- asking who is speaking ---------- */

export const VOICE_CHECK_MINUTES = 5;

/** A phone confirmation waiting on the /voice-check page. */
export interface PendingVoiceCheck {
  id: string;
  familyId: string;
  candidates: { id: string; name: string }[];
  attempted: string;
  deviceName: string;
  expiresAt: number;
  settle: (memberId: string | null) => void;
}

type Answer = { kind: 'member'; id: string } | { kind: 'someone_else' } | { kind: 'no_answer'; why: string };

async function candidatesFor(deps: Deps, caller: Caller, match: SpeakerMatch): Promise<Member[]> {
  const family = await deps.store.listMembers(caller.family.id);
  const named = match.candidates.map(id => family.find(m => m.id === id)).filter((m): m is Member => !!m);
  // A low match with no usable candidates still has the device's own profile to offer.
  return named.length ? [...new Map(named.map(m => [m.id, m])).values()] : [caller.member];
}

async function askOnForm(ctx: ServerContext, candidates: Member[], attempted: string): Promise<Answer> {
  const reply = await ctx.mcpReq.elicitInput({
    mode: 'form',
    message: `I'm not sure who's speaking. Before I ${attempted}, who is this?`,
    requestedSchema: {
      type: 'object',
      properties: {
        speaker: {
          type: 'string',
          title: "Who's speaking?",
          oneOf: [...candidates.map(m => ({ const: m.id, title: m.name })), { const: 'someone_else', title: 'Someone else' }]
        }
      },
      required: ['speaker']
    }
  });
  const picked = (reply.content as { speaker?: unknown } | undefined)?.speaker;
  if (reply.action !== 'accept') return { kind: 'no_answer', why: "Okay, I haven't changed anything." };
  if (picked === 'someone_else') return { kind: 'someone_else' };
  const member = candidates.find(m => m.id === picked);
  return member ? { kind: 'member', id: member.id } : { kind: 'no_answer', why: "I didn't get who was speaking, so I haven't changed anything." };
}

function baseUrl(deps: Deps, ctx: ServerContext): string {
  if (deps.publicUrl) return deps.publicUrl;
  try {
    const url = ctx.http?.req?.url;
    if (url) return new URL(url).origin;
  } catch {
    // fall through
  }
  return 'http://127.0.0.1:8000';
}

/** No form: the person confirms on their phone, through the same URL elicitation flow as checkout. */
async function askOnPhone(server: McpServer, deps: Deps, ctx: ServerContext, caller: Caller, candidates: Member[], attempted: string): Promise<Answer> {
  const pending = (deps.voiceChecks ??= new Map());
  const { token, hash } = newCheckoutToken();
  const id = `voice-check-${randomUUID().slice(0, 12)}`;
  const timeoutMs = deps.voiceCheckTimeoutMs ?? VOICE_CHECK_MINUTES * 60_000;
  let settle!: (memberId: string | null) => void;
  const settled = new Promise<string | null>(resolve => (settle = resolve));
  pending.set(hash, {
    id,
    familyId: caller.family.id,
    candidates: candidates.map(m => ({ id: m.id, name: m.name })),
    attempted,
    deviceName: caller.member.name,
    expiresAt: Date.now() + timeoutMs,
    settle
  });
  const timer = setTimeout(() => settle(null), timeoutMs);
  try {
    const opened = await ctx.mcpReq.elicitInput({
      mode: 'url',
      elicitationId: id,
      url: `${baseUrl(deps, ctx)}/voice-check/${token}`,
      message: `I'm not sure who's speaking. To ${attempted}, confirm it was you on your phone.`
    });
    if (opened.action !== 'accept') return { kind: 'no_answer', why: "Okay, I haven't changed anything." };
    const memberId = await settled;
    void server.server
      .createElicitationCompletionNotifier(id)()
      .catch(() => undefined);
    if (memberId === null) return { kind: 'no_answer', why: "I didn't get a confirmation, so I haven't changed anything." };
    return memberId === 'someone_else' ? { kind: 'someone_else' } : { kind: 'member', id: memberId };
  } finally {
    clearTimeout(timer);
    pending.delete(hash);
  }
}

/** Looks up a phone confirmation by its link token. */
export function voiceCheckFor(deps: Deps, token: string): PendingVoiceCheck | undefined {
  const check = deps.voiceChecks?.get(hashToken(token));
  return check && check.expiresAt > Date.now() ? check : undefined;
}

/* ---------- the gate ---------- */

type Handler = (request: { params?: any }, ctx: ServerContext) => Promise<unknown>;

/**
 * Puts the rules in front of `tools/call`. Install last, after every tool and the task
 * runtime, so task-augmented calls go through it too.
 */
export function installSpeakerGate(server: McpServer, deps: Deps): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const toolsCall = handlers.get('tools/call');
  if (!toolsCall) throw new Error('installSpeakerGate: register tools first');
  handlers.set('tools/call', async (request, ctx) => {
    const name = String(request.params?.name ?? '');
    const match = speakerFrom(ctx);
    if (match.confidence === 'high' || toolKind(name) === 'read') return toolsCall(request, ctx);

    let caller: Caller;
    try {
      caller = await resolveCaller(ctx, deps);
    } catch (err) {
      if (err instanceof CareError) return fail(err.message);
      throw err;
    }
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const attempted = await describeAttempt(deps, caller, name, args).catch(() => `change ${caller.recipient.name}'s care plan`);

    if (match.confidence === 'unknown') {
      await record(deps, caller, 'unknown', name, attempted);
      return refused(caller, attempted);
    }

    // Low: nothing changes until the person says who they are.
    const candidates = await candidatesFor(deps, caller, match);
    const can = elicitationSupport(server);
    let answer: Answer;
    try {
      if (can.form) answer = await askOnForm(ctx, candidates, attempted);
      else if (can.url) answer = await askOnPhone(server, deps, ctx, caller, candidates, attempted);
      else answer = { kind: 'no_answer', why: `I'm not sure who's speaking, so I can't ${attempted} from here. Please ask again from your own device.` };
    } catch (err) {
      console.warn('[carecircle] could not ask who is speaking', err);
      answer = { kind: 'no_answer', why: `I'm not sure who's speaking, so I haven't changed anything.` };
    }
    if (answer.kind === 'member') return toolsCall(request, asMember(ctx, answer.id));
    if (answer.kind === 'someone_else') {
      await record(deps, caller, 'low', name, attempted);
      return refused(caller, attempted);
    }
    return unchanged(caller, answer.why);
  });
}
