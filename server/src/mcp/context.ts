import type { ServerContext, CallToolResult } from '@modelcontextprotocol/server';
import type { CareStore, Family, Language, Member, Role } from '../store/types.js';
import type { ChangeHub } from '../store/changes.js';
import type { Notifier } from '../notify/notifier.js';
import type { Clock } from '../config.js';
import type { AppointmentPlanner } from '../domain/appointments.js';
import type { TaskRegistry } from './tasks.js';
import { localParts, type LocalParts } from '../domain/time.js';
import { voiceSafe } from '../domain/speech.js';

export interface Deps {
  store: CareStore;
  clock: Clock;
  /** Used when a request carries no identity (stdio, in-memory tests, dev mode without a token) */
  defaultUser: string;
  /** Base URL for links the server hands out (checkout). Defaults to the origin the request came in on. */
  publicUrl?: string;
  /**
   * Order id -> callback that sends `notifications/elicitation/complete` to the
   * session that opened the checkout link. Set by request_refill, fired by the checkout page.
   */
  checkoutWatchers?: Map<string, () => Promise<void>>;
  /** Family-wide change feed; sessions turn it into resource update notifications. Set by createHttpApp. */
  changes?: ChangeHub;
  /** Delivers the evening summary (inbox, plus Amazon SNS when configured). Set by createHttpApp. */
  notifier?: Notifier;
  /** Plans appointment options. Defaults to the deterministic planner over synthetic services. */
  appointmentPlanner?: AppointmentPlanner;
  /** MCP Tasks for every session. Created on first use. */
  tasks?: TaskRegistry;
  /** Family id -> appointment options last read out to a voice-only client, for its "yes". */
  issuedAppointmentOptions?: Map<string, { at: number; ids: Set<string> }>;
}

export interface Caller {
  member: Member;
  family: Family;
  recipient: Member;
  now: Date;
  local: LocalParts;
  isRecipient: boolean;
  /** The language replies to this caller are spoken in */
  lang: Language;
}

/** Thrown inside tool handlers; turned into a spoken, user-safe isError result. */
export class CareError extends Error {}

export function userIdFrom(ctx: ServerContext | undefined, deps: Deps): string {
  const extra = ctx?.http?.authInfo?.extra as { userId?: unknown } | undefined;
  return typeof extra?.userId === 'string' ? extra.userId : deps.defaultUser;
}

export async function resolveCaller(ctx: ServerContext | undefined, deps: Deps): Promise<Caller> {
  return callerFor(userIdFrom(ctx, deps), deps);
}

/** The caller for a known member, e.g. when the evening scheduler acts for the family. */
export async function callerFor(userId: string, deps: Deps): Promise<Caller> {
  const member = await deps.store.getMember(userId);
  if (!member) throw new CareError("I couldn't find your CareCircle account. Please link your account and try again.");
  const family = await deps.store.getFamily(member.familyId);
  if (!family) throw new CareError("I couldn't find your family's care plan.");
  const recipient = await deps.store.getMember(family.recipientId);
  if (!recipient) throw new CareError("I couldn't find who this care plan is for.");
  const now = deps.clock();
  return {
    member,
    family,
    recipient,
    now,
    local: localParts(now, family.timezone),
    isRecipient: member.id === recipient.id,
    lang: member.language ?? 'en'
  };
}

export function requireRole(caller: Caller, roles: Role[], action: string): void {
  if (!roles.includes(caller.member.role)) {
    throw new CareError(`Sorry, ${caller.member.name}, your role in this CareCircle can't ${action}. Ask a coordinator to do it.`);
  }
}

/** Builds a tool result with structured data plus a short speakable sentence. */
export function ok<T extends Record<string, unknown>>(structured: T, speech: string, meta?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: voiceSafe(speech) }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {})
  };
}

export function fail(speech: string): CallToolResult {
  return { content: [{ type: 'text', text: voiceSafe(speech) }], isError: true };
}

/** Wraps a handler so CareErrors become spoken errors and anything else becomes a safe generic one. */
export function guarded<A>(fn: (args: A, ctx: ServerContext) => Promise<CallToolResult>) {
  return async (args: A, ctx: ServerContext): Promise<CallToolResult> => {
    try {
      return await fn(args, ctx);
    } catch (err) {
      if (err instanceof CareError) return fail(err.message);
      console.error('[carecircle] tool error', err);
      return fail("Something went wrong on CareCircle's side. Please try again in a minute.");
    }
  };
}

/** "you" when Rose is speaking, otherwise her name. */
export function subject(caller: Caller): { name: string; has: string; is: string; pronoun: string } {
  return caller.isRecipient
    ? { name: 'you', has: 'you have', is: 'you are', pronoun: 'you' }
    : { name: caller.recipient.name, has: `${caller.recipient.name} has`, is: `${caller.recipient.name} is`, pronoun: caller.recipient.pronoun ?? 'they' };
}
