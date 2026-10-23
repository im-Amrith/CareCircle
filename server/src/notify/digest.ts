/**
 * The evening summary: one short message to the family about the cared-for person's day.
 * Sent by the scheduler at the family's digest time, or on request with send_daily_summary.
 */
import type { FamilyMessage } from '../store/types.js';
import { addDays, localParts, spokenTime } from '../domain/time.js';
import { listJoin, plural } from '../domain/speech.js';
import { callerFor, type Caller, type Deps } from '../mcp/context.js';
import { careStatus } from '../mcp/status.js';
import { orderSentence, openOrders } from '../mcp/refills.js';
import { safetyCheck } from '../domain/care.js';
import { voiceCheckSentence } from '../mcp/identity.js';
import { digestLine } from '../mcp/checkins.js';

export const DEFAULT_DIGEST_TIME = '20:30';

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Plain text that reads well as an email, an SMS or a phone notification. */
export async function composeDigest(deps: Deps, caller: Caller, date: string): Promise<{ title: string; text: string }> {
  const name = caller.recipient.name;
  const { structured: s } = await careStatus(deps, caller, date, 'brief');
  const lines: string[] = [];

  const { taken, total, upcoming, due } = s.counts;
  const notTaken = s.doses.filter(d => d.status === 'missed' || d.status === 'skipped');
  const toCome = upcoming + due;
  lines.push(
    toCome > 0
      ? `Medicines: ${taken} of ${total} doses taken so far; ${toCome} still to come.`
      : `Medicines: ${taken} of ${total} doses taken.`
  );
  if (notTaken.length) lines.push(`Not taken: ${listJoin(notTaken.map(d => `${d.name} (${d.slot === 'noon' ? 'lunchtime' : d.slot})`))}.`);

  const notes = await deps.store.listWellbeing(caller.family.id, date, date);
  for (const n of notes.filter(n => n.redFlag)) {
    const reason = safetyCheck(n.note).reasons[0];
    lines.push(`Alert, ${spokenTime(n.time)}: "${n.note.replace(/\.$/, '')}"${reason ? ` (${reason})` : ''}.`);
  }
  const calm = notes.filter(n => !n.redFlag);
  if (calm.length) lines.push(`Notes: ${calm.map(n => `${spokenTime(n.time)}, ${n.note.replace(/\.$/, '')}`).join('; ')}.`);

  const orders = await openOrders(deps, caller);
  for (const a of s.refillAlerts) {
    const order = orders.get(a.medicationId);
    lines.push(`Supply: ${a.name} has about ${plural(a.daysLeft, 'day')} left.${order ? ` ${orderSentence(order, caller.now, caller.local.date)}` : ' No refill ordered yet.'}`);
  }
  const morning = await digestLine(deps, caller);
  if (morning) lines.push(morning);
  if (s.visits.length) lines.push(`Visits: ${listJoin(s.visits.map(v => `${v.who} at ${spokenTime(v.time)}`))}.`);
  if (s.missedLast7Days) lines.push(`Past 7 days: ${plural(s.missedLast7Days, 'dose')} missed.`);

  // Changes refused because CareCircle couldn't tell who was speaking, since the last summary.
  const lastSummary = (await deps.store.listMessages(caller.family.id, 50)).find(m => m.kind === 'daily_summary');
  const checks = (await deps.store.listVoiceChecks(caller.family.id, addDays(date, -7), date))
    .filter(c => !lastSummary || c.at > lastSummary.sentAt)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const c of checks) lines.push(`Voice check: ${voiceCheckSentence(c)}`);

  const title = `${name}'s day: ${dayLabel(date)}`;
  const text = [title, '', ...lines, '', 'CareCircle coordinates care. It does not give medical advice.'].join('\n');
  return { title, text };
}

/** Composes today's summary and sends it to everyone in the family except the cared-for person. */
export async function sendDailySummary(deps: Deps, familyId: string, sentBy: string): Promise<FamilyMessage> {
  if (!deps.notifier) throw new Error('No notifier configured');
  const family = await deps.store.getFamily(familyId);
  if (!family) throw new Error(`Unknown family ${familyId}`);
  const caller = await callerFor(family.recipientId, deps);
  const date = caller.local.date;
  const { title, text } = await composeDigest(deps, caller, date);
  const to = (await deps.store.listMembers(familyId)).filter(m => m.id !== family.recipientId).map(m => m.id);
  return deps.notifier.send({
    id: `msg-${date}-${caller.now.getTime()}`,
    familyId,
    kind: 'daily_summary',
    date,
    title,
    text,
    to,
    sentAt: caller.now.toISOString(),
    sentBy
  });
}

/**
 * Called every minute: sends each family's summary once, at or after its digest time.
 * Returns the messages sent, for tests.
 */
export async function runDigestSchedule(deps: Deps, digestTime = DEFAULT_DIGEST_TIME): Promise<FamilyMessage[]> {
  const sent: FamilyMessage[] = [];
  for (const family of await deps.store.listFamilies()) {
    const local = localParts(deps.clock(), family.timezone);
    if (local.time < digestTime) continue;
    const already = (await deps.store.listMessages(family.id, 50)).some(m => m.kind === 'daily_summary' && m.date === local.date);
    if (already) continue;
    sent.push(await sendDailySummary(deps, family.id, 'schedule'));
  }
  return sent;
}

/** "Sam and Maya" for spoken replies. */
export async function recipientsSpoken(deps: Deps, message: FamilyMessage): Promise<string> {
  const members = await deps.store.listMembers(message.familyId);
  return listJoin(message.to.map(id => members.find(m => m.id === id)?.name ?? id));
}
