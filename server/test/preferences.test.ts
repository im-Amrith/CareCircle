import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPreferences } from '../src/mcp/preferences.js';
import { call, connect, said, startServer } from './helpers.js';

const BOOK = { specialty: 'cardiology follow-up', window: 'next week' };

describe('care preferences', () => {
  it('reads times of day and days from what was said', () => {
    expect(readPreferences('Mom prefers mornings')).toEqual([{ key: 'appointment_time', value: 'mornings' }]);
    expect(readPreferences('not on Fridays please')).toEqual([{ key: 'appointment_days', value: 'not Friday' }]);
    expect(readPreferences('afternoons, Tuesday or Thursday')).toEqual([
      { key: 'appointment_time', value: 'afternoons' },
      { key: 'appointment_days', value: 'Tuesday or Thursday' }
    ]);
    expect(readPreferences('she likes Dr Rao')).toEqual([]);
  });

  describe('across sessions and family members', () => {
    let srv: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => {
      srv = await startServer();
    });
    afterAll(async () => {
      await srv.stop();
    });

    it("Rose's preference is remembered and used in Sam's next session", async () => {
      const rose = await connect(srv.url, 'rose');
      const saved = await call(rose, 'set_care_preference', { preference: 'I prefer mornings' });
      expect(saved.structuredContent).toMatchObject({ result: 'saved', preferences: [{ key: 'appointment_time', value: 'mornings', setBy: 'rose' }] });
      expect(said(saved)).toBe("Got it. From now on I'll look for your appointments in the mornings, unless someone asks otherwise.");
      await rose.close();

      // A new session, a different person, no constraints given.
      const sam = await connect(srv.url, 'sam');
      const plan = await call(sam, 'coordinate_appointment', BOOK);
      expect(said(plan)).toMatch(/^I found three times for Rose's cardiology follow-up, mornings, as Rose prefers\./);
      for (const o of plan.structuredContent!.options) expect(Number(o.time.slice(0, 2))).toBeLessThan(12);

      // What the person asks for this time wins over the stored preference.
      const afternoon = await call(sam, 'coordinate_appointment', { ...BOOK, constraints: 'afternoons' });
      expect(said(afternoon)).toMatch(/afternoons\./);
      expect(said(afternoon)).not.toMatch(/prefers/);
      for (const o of afternoon.structuredContent!.options) expect(Number(o.time.slice(0, 2))).toBeGreaterThanOrEqual(12);
      await sam.close();
    });

    it('adds days, forgets on request, and asks when it does not understand', async () => {
      const sam = await connect(srv.url, 'sam');
      const days = await call(sam, 'set_care_preference', { preference: 'Mom would rather not go on Thursdays' });
      expect(said(days)).toMatch(/Rose's appointments not on Thursday/);
      const plan = await call(sam, 'coordinate_appointment', BOOK);
      expect(plan.structuredContent!.options.map((o: any) => o.label)).toEqual([
        'Tue 10:30 am with Dr Rao, Maya drives',
        'Mon 9:30 am with Dr Mehta, taxi',
        'Wed 11 am with Dr Rao, taxi'
      ]);

      const unclear = await call(sam, 'set_care_preference', { preference: 'she likes Dr Rao' });
      expect(unclear.structuredContent?.result).toBe('not_understood');

      const forgot = await call(sam, 'set_care_preference', { preference: "Forget Mom's appointment preferences", forget: true });
      expect(forgot.structuredContent).toMatchObject({ result: 'forgotten', preferences: [] });
      expect(said(forgot)).toBe("Okay, I've forgotten Rose's appointment time of day and appointment days preferences.");
      expect(said(await call(sam, 'coordinate_appointment', BOOK))).not.toMatch(/prefers/);
      await sam.close();
    });
  });
});
