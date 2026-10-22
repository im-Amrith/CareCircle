import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { firstByDay, nextStep, readUntil, settingsOrDefault, usualTime } from '../src/domain/rhythm.js';
import { runCheckIn } from '../src/mcp/checkins.js';
import { call, connect, said, startServer } from './helpers.js';

const TODAY = 'carecircle://family/fam-rose/today';
const INBOX = 'carecircle://family/fam-rose/inbox';
/** 07:30 in Asia/Kolkata on the demo day, before Rose's usual morning (and before her 7:45 note). */
const HALF_SEVEN_IST = '2026-10-10T02:00:00Z';

async function read(client: Client, uri: string) {
  const r = await client.readResource({ uri });
  return JSON.parse((r.contents[0] as { text: string }).text);
}

describe('morning rhythm', () => {
  it('works out the usual time from enough mornings, rounded to five minutes', () => {
    const mornings = (times: string[]) => firstByDay(times.map((time, i) => ({ date: `2026-10-0${i + 1}`, time })));
    expect(usualTime(mornings(['08:07', '08:28', '08:33', '08:12', '08:24']), '2026-10-10')).toBe('08:25');
    expect(usualTime(mornings(['08:07', '08:28', '08:33', '08:12']), '2026-10-10')).toBeUndefined();
    // Today never counts towards the usual time.
    expect(usualTime(mornings(['08:00', '08:00', '08:00', '08:00', '08:00', '11:00']), '2026-10-06')).toBe('08:00');
  });

  it('understands until when a pause should last', () => {
    // 2026-10-10 is a Saturday.
    expect(readUntil('Sunday', '2026-10-10')).toBe('2026-10-11');
    expect(readUntil('till Saturday', '2026-10-10')).toBe('2026-10-10');
    expect(readUntil('tomorrow', '2026-10-10')).toBe('2026-10-11');
    expect(readUntil('next week', '2026-10-10')).toBe('2026-10-17');
    expect(readUntil('3 days', '2026-10-10')).toBe('2026-10-13');
    expect(readUntil('2026-10-20', '2026-10-10')).toBe('2026-10-20');
    expect(readUntil('2026-10-01', '2026-10-10')).toBeUndefined();
    expect(readUntil('a while', '2026-10-10')).toBeUndefined();
  });

  it('asks first, tells the family only after no answer, and never while paused or off', () => {
    const settings = settingsOrDefault('f', undefined);
    const base = { settings, today: '2026-10-10', usual: '08:20', firstToday: undefined, existing: undefined };
    expect(nextStep({ ...base, nowMinutes: 8 * 60 + 49 })).toEqual({ kind: 'none', why: 'not_yet' });
    expect(nextStep({ ...base, nowMinutes: 8 * 60 + 50 })).toEqual({ kind: 'ask', usual: '08:20' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60, firstToday: '08:55' })).toEqual({ kind: 'none', why: 'active' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60, usual: undefined })).toEqual({ kind: 'none', why: 'no_baseline' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60, settings: { ...settings, pausedUntil: '2026-10-11' } })).toEqual({ kind: 'none', why: 'paused' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60, settings: { ...settings, pausedUntil: '2026-10-09' } }).kind).toBe('ask');
    expect(nextStep({ ...base, nowMinutes: 9 * 60, settings: { ...settings, enabled: false } })).toEqual({ kind: 'none', why: 'off' });

    const asked = { id: 'c', familyId: 'f', date: '2026-10-10', usual: '08:20', stage: 'asked' as const, askedAt: '', askedTime: '08:50' };
    expect(nextStep({ ...base, nowMinutes: 9 * 60 + 19, existing: asked })).toEqual({ kind: 'none', why: 'waiting' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60 + 20, existing: asked })).toEqual({ kind: 'tell_family' });
    expect(nextStep({ ...base, nowMinutes: 9 * 60 + 25, existing: asked, firstToday: '09:24' })).toEqual({ kind: 'answered' });
  });
});

describe('morning check-in, end to end', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const advance = (minutes: number) => srv.deps.clock.advance!(minutes * 60_000);
  beforeEach(async () => {
    srv = await startServer(HALF_SEVEN_IST);
  });
  afterEach(async () => {
    await srv.stop();
  });

  it('knows Rose is usually up by 8:20 and calls out the late Wednesday', async () => {
    const sam = await connect(srv.url, 'sam');
    const r = await call(sam, 'get_morning_rhythm');
    expect(r.structuredContent).toMatchObject({ usual: '08:20', checkIn: 'none', settings: { enabled: true } });
    expect(r.structuredContent!.firstToday).toBeUndefined();
    expect(said(r)).toBe(
      "Not yet this morning. Rose is usually up by 8:20 am; if I haven't heard anything by 8:50 am, I'll check in. This week she has usually been up by 8:20 am, but she was later than usual on Wednesday, at 9:27 am."
    );
    expect(r.structuredContent!.week.filter((d: any) => d.late).map((d: any) => d.date)).toEqual(['2026-10-07']);
    await sam.close();
  });

  it("checks in with Rose, tells Sam and Maya only when she doesn't answer, then tells them she's fine", async () => {
    const familyId = 'fam-rose';
    expect(await runCheckIn(srv.deps, familyId)).toBe('none');

    advance(80); // 08:50
    expect(await runCheckIn(srv.deps, familyId)).toBe('asked');
    const rose = await connect(srv.url, 'rose');
    const sam = await connect(srv.url, 'sam');
    const roseToday = await read(rose, TODAY);
    expect(roseToday.alerts.map((a: any) => a.text)).toEqual([
      "Good morning, Rose. Just checking in, as I haven't heard from you yet this morning. How are you feeling today?"
    ]);
    // The family hears nothing yet.
    expect((await read(sam, TODAY)).alerts).toEqual([]);
    expect((await read(sam, INBOX)).messages.filter((m: any) => m.kind === 'check_in')).toEqual([]);
    expect(await runCheckIn(srv.deps, familyId)).toBe('none');

    advance(30); // 09:20
    expect(await runCheckIn(srv.deps, familyId)).toBe('family_told');
    const told = (await read(sam, TODAY)).alerts;
    expect(told.map((a: any) => a.text)).toEqual([
      "CareCircle check-in: Rose hasn't been active this morning. She is usually up by 8:20 am, and didn't answer when I checked in at 8:50 am. You might give her a call. CareCircle is not an emergency service; if you think something is wrong, call emergency services."
    ]);
    const inbox = (await read(sam, INBOX)).messages.filter((m: any) => m.kind === 'check_in');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: 'Checking on Rose this morning', to: ['sam', 'maya'] });
    const rhythm = await call(sam, 'get_morning_rhythm');
    expect(said(rhythm)).toMatch(/^I haven't heard from Rose yet this morning\. I checked in at 8:50 am with no answer, and told the family at 9:20 am\./);

    // Rose answers. Anything she says counts, and the family is told straight away.
    advance(5); // 09:25
    await call(rose, 'log_wellbeing', { note: "I'm fine, I just slept in" });
    expect((await read(rose, TODAY)).alerts.filter((a: any) => a.id.startsWith('checkin'))).toEqual([]);
    const after = (await read(sam, TODAY)).alerts.map((a: any) => a.text);
    expect(after[1]).toBe('Good news: Rose answered at 9:25 am. No need to worry about this morning.');
    const all = (await read(sam, INBOX)).messages.filter((m: any) => m.kind === 'check_in');
    expect(all.map((m: any) => m.title)).toEqual(['Rose is fine', 'Checking on Rose this morning']);
    expect(said(await call(sam, 'get_morning_rhythm'))).toMatch(/^Rose answered my check-in at 9:25 am\./);
    expect(await runCheckIn(srv.deps, familyId)).toBe('none');

    // The evening summary mentions the morning.
    const summary = await call(sam, 'send_daily_summary');
    expect(summary.structuredContent?.text).toContain('Morning: Rose was quiet; CareCircle checked in at 8:50 am and told the family at 9:20 am. Rose answered at 9:25 am.');
    await rose.close();
    await sam.close();
  });

  it('a morning that has started needs no check-in', async () => {
    const rose = await connect(srv.url, 'rose');
    advance(20); // 07:50
    await call(rose, 'get_care_status');
    advance(120); // 09:50
    expect(await runCheckIn(srv.deps, 'fam-rose')).toBe('none');
    const sam = await connect(srv.url, 'sam');
    expect(said(await call(sam, 'get_morning_rhythm'))).toMatch(/^Yes, Rose was up and about at 7:50 am this morning, a bit earlier than usual\./);
    await rose.close();
    await sam.close();
  });

  it('pauses until a day and resumes by itself; turning off needs a yes', async () => {
    const maya = await connect(srv.url, 'maya');
    const unclear = await call(maya, 'set_check_ins', { action: 'pause' });
    expect(unclear.structuredContent?.result).toBe('needs_detail');
    const paused = await call(maya, 'set_check_ins', { action: 'pause', until: 'Sunday', reason: 'Mom is staying with me' });
    expect(said(paused)).toBe("Okay. I've paused Rose's morning check-ins through tomorrow. They start again Monday by themselves.");
    expect(paused.structuredContent?.settings).toEqual({ enabled: true, pausedUntil: '2026-10-11', pauseReason: 'Mom is staying with Maya' });

    advance(120); // 09:30, a quiet morning
    expect(await runCheckIn(srv.deps, 'fam-rose')).toBe('none');
    expect(said(await call(maya, 'get_morning_rhythm'))).toMatch(/Morning check-ins are paused \(Mom is staying with Maya\) and start again Monday\.$/);
    advance(48 * 60); // Monday 09:30: the pause is over
    expect(await runCheckIn(srv.deps, 'fam-rose')).toBe('asked');

    const tooLong = await call(maya, 'set_check_ins', { action: 'pause', until: '2026-12-31' });
    expect(tooLong.isError).toBe(true);

    // Rose decides for herself, and turning off waits for a yes.
    const rose = await connect(srv.url, 'rose');
    const ask = await call(rose, 'set_check_ins', { action: 'turn_off' });
    expect(ask.structuredContent).toMatchObject({ result: 'needs_confirmation', settings: { enabled: true } });
    expect(said(ask)).toMatch(/^Turn off your morning check-ins\?/);
    const off = await call(rose, 'set_check_ins', { action: 'turn_off', confirm: true });
    expect(off.structuredContent).toMatchObject({ result: 'turned_off', settings: { enabled: false } });
    advance(24 * 60);
    expect(await runCheckIn(srv.deps, 'fam-rose')).toBe('none');
    const on = await call(maya, 'set_check_ins', { action: 'turn_on' });
    expect(on.structuredContent?.settings).toEqual({ enabled: true });
    await rose.close();
    await maya.close();
  });

  it('moves the frozen demo clock forward and runs the check-in at once', async () => {
    const base = srv.url.replace(/\/mcp$/, '');
    const bad = await fetch(`${base}/dev/clock?minutes=0`, { method: 'POST' });
    expect(bad.status).toBe(400);
    const res = await fetch(`${base}/dev/clock?minutes=80`, { method: 'POST' });
    expect(await res.json()).toEqual({ now: '2026-10-10T03:20:00.000Z' });
    const rose = await connect(srv.url, 'rose');
    expect((await read(rose, TODAY)).alerts.map((a: any) => a.id)).toEqual(['checkin-ask-2026-10-10']);
    await rose.close();
    // ?to= goes to the next time it is that o'clock for the family: 08:50 now, so tomorrow.
    const next = await fetch(`${base}/dev/clock?to=08:30`, { method: 'POST' });
    expect(await next.json()).toEqual({ now: '2026-10-11T03:00:00.000Z' });
    expect((await fetch(`${base}/dev/clock?to=8am`, { method: 'POST' })).status).toBe(400);
  });
});
