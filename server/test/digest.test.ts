import { describe, expect, it } from 'vitest';
import { makeClock } from '../src/config.js';
import type { Deps } from '../src/mcp/context.js';
import { runDigestSchedule } from '../src/notify/digest.js';
import { createNotifier, type SnsPublisher } from '../src/notify/notifier.js';
import { NINE_AM_IST, seededStore } from './helpers.js';

const NINE_PM_IST = '2026-10-10T15:30:00Z';

function deps(nowIso: string, sns?: SnsPublisher): Deps & { store: ReturnType<typeof seededStore> } {
  const store = seededStore(nowIso);
  return { store, clock: makeClock(nowIso), defaultUser: 'sam', notifier: createNotifier(store, sns) };
}

describe('evening summary schedule', () => {
  it('sends once per family per day, only after the digest time', async () => {
    expect(await runDigestSchedule(deps(NINE_AM_IST))).toEqual([]);

    const d = deps(NINE_PM_IST);
    const first = await runDigestSchedule(d);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ familyId: 'fam-rose', date: '2026-10-10', sentBy: 'schedule', to: ['sam', 'maya'] });
    expect(first[0].text).toContain('Medicines: 0 of 5 doses taken so far; 3 still to come.');
    expect(first[0].text).toContain('Not taken: Metformin (morning) and Vitamin D3 (morning).');
    expect(await runDigestSchedule(d)).toEqual([]);
    expect(d.store.messages).toHaveLength(1);
  });

  it('publishes to SNS when a topic is set, and keeps the inbox copy if SNS fails', async () => {
    const published: { subject: string; text: string }[] = [];
    const ok = deps(NINE_PM_IST, { publish: async m => (published.push(m), 'mid-1') });
    const [sent] = await runDigestSchedule(ok);
    expect(sent.delivery).toEqual({ inbox: true, sns: 'sent', snsMessageId: 'mid-1' });
    expect(published[0].subject).toBe("Rose's day: Saturday 10 October");

    const broken = deps(NINE_PM_IST, { publish: async () => Promise.reject(new Error('AuthorizationError')) });
    const [failed] = await runDigestSchedule(broken);
    expect(failed.delivery).toMatchObject({ inbox: true, sns: 'failed', snsError: 'AuthorizationError' });
    expect(broken.store.messages).toHaveLength(1);
  });
});
