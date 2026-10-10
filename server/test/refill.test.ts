import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveStatus, openOrderFor, readyOn, refillQuantity } from '../src/domain/refill.js';
import type { RefillOrder } from '../src/store/types.js';
import { NINE_AM_IST, call, connect, said, seededStore, startServer } from './helpers.js';

const now = new Date(NINE_AM_IST);
const tz = 'Asia/Kolkata';

function order(patch: Partial<RefillOrder>): RefillOrder {
  return {
    id: 'ord-1',
    familyId: 'fam-rose',
    medicationId: 'med-amlodipine',
    pharmacyId: 'riverside',
    quantity: 30,
    fulfilment: 'delivery',
    status: 'awaiting_checkout',
    requestedBy: 'sam',
    createdAt: now.toISOString(),
    checkoutTokenHash: 'x',
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    ...patch
  };
}

describe('refill rules', () => {
  it('orders a 30-day supply', () => {
    const store = seededStore();
    expect(refillQuantity(store.medications.get('med-amlodipine')!)).toBe(30);
    expect(refillQuantity(store.medications.get('med-metformin')!)).toBe(60);
  });

  it('expires unfinished checkouts and treats them as not open', () => {
    const later = new Date(now.getTime() + 16 * 60_000);
    expect(effectiveStatus(order({}), now)).toBe('awaiting_checkout');
    expect(effectiveStatus(order({}), later)).toBe('expired');
    expect(openOrderFor([order({})], 'med-amlodipine', now, tz)?.id).toBe('ord-1');
    expect(openOrderFor([order({})], 'med-amlodipine', later, tz)).toBeUndefined();
  });

  it('keeps a placed order open until it arrives', () => {
    const placed = order({ status: 'placed', readyOn: '2026-10-11' });
    expect(readyOn('delivery', now, tz)).toBe('2026-10-11');
    expect(readyOn('pickup', now, tz)).toBe('2026-10-10');
    expect(openOrderFor([placed], 'med-amlodipine', now, tz)).toBeDefined();
    expect(openOrderFor([placed], 'med-amlodipine', new Date('2026-10-12T03:30:00Z'), tz)).toBeUndefined();
    expect(openOrderFor([order({ status: 'cancelled' })], 'med-amlodipine', now, tz)).toBeUndefined();
  });
});

describe('voice refill: "Reorder? Yes" then secure checkout', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let origin: string;
  beforeAll(async () => {
    srv = await startServer();
    origin = new URL(srv.url).origin;
  });
  afterAll(async () => {
    await srv.stop();
  });

  let checkoutUrl: string;

  it('asks before ordering, and orders nothing on the question', async () => {
    const sam = await connect(srv.url, 'sam');
    const r = await call(sam, 'request_refill');
    expect(r.structuredContent?.result).toBe('needs_confirmation');
    expect(said(r)).toBe(
      'Amlodipine has about three days left. Should I reorder Amlodipine 5 mg, 30 tablets, from Riverside Pharmacy for delivery?'
    );
    expect(srv.store.orders).toHaveLength(0);
    await sam.close();
  });

  it('on yes, opens a one-time checkout without reading the link aloud', async () => {
    const sam = await connect(srv.url, 'sam');
    const r = await call(sam, 'request_refill', { spoken_name: 'blood pressure tablets', confirm: true });
    expect(r.structuredContent?.result).toBe('checkout_ready');
    expect(r.structuredContent?.order).toMatchObject({ name: 'Amlodipine', quantity: 30, status: 'awaiting_checkout', fulfilment: 'delivery' });
    checkoutUrl = r.structuredContent?.checkoutUrl;
    expect(checkoutUrl).toMatch(new RegExp(`^${origin}/checkout/[A-Za-z0-9_-]{43}$`));
    expect(said(r)).toContain("I've started a refill of Amlodipine 5 mg, 30 tablets, from Riverside Pharmacy for delivery");
    expect(said(r)).toContain('nothing is ordered until you confirm there');
    expect(said(r)).not.toMatch(/http|checkout\//);
    // Only the hash is stored.
    expect(JSON.stringify(srv.store.orders)).not.toContain(checkoutUrl.split('/').at(-1));
    await sam.close();
  });

  it('saying yes twice never orders twice', async () => {
    const rose = await connect(srv.url, 'rose');
    const r = await call(rose, 'request_refill', { spoken_name: 'amlodipine', confirm: true });
    expect(r.structuredContent?.result).toBe('already_ordered');
    expect(said(r)).toContain('A refill is waiting for checkout');
    expect(srv.store.orders).toHaveLength(1);
    await rose.close();
  });

  it('serves the checkout page with strict headers', async () => {
    const res = await fetch(checkoutUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm refill');
    expect(html).toContain('Amlodipine 5 mg');
    expect(html).toContain('Riverside Pharmacy');
    expect(html).not.toMatch(/<script/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('rejects unknown links and cross-site posts', async () => {
    expect((await fetch(`${origin}/checkout/not-a-token`)).status).toBe(404);
    expect((await fetch(`${origin}/checkout/${'A'.repeat(43)}`)).status).toBe(404);
    const crossSite = await fetch(checkoutUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://localhost:${new URL(origin).port}` },
      body: 'action=place&fulfilment=delivery'
    });
    expect(crossSite.status).toBe(403);
    expect(srv.store.orders[0].status).toBe('awaiting_checkout');
  });

  it('places the order exactly once', async () => {
    const post = () =>
      fetch(checkoutUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
        body: 'action=place&fulfilment=delivery'
      });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status]).toEqual([303, 303]);
    expect(srv.store.orders).toHaveLength(1);
    expect(srv.store.orders[0]).toMatchObject({ status: 'placed', readyOn: '2026-10-11' });
    const html = await (await fetch(checkoutUrl)).text();
    expect(html).toContain('Refill ordered');
    expect(html).toContain('It arrives tomorrow');
    expect(html).not.toContain('<form');
  });

  it('status and refill checks now say the refill is on its way', async () => {
    const sam = await connect(srv.url, 'sam');
    const refills = await call(sam, 'check_refills');
    expect(said(refills)).toContain('Amlodipine 5 mg has about three days left, enough until Monday. A refill arrives tomorrow.');
    expect(said(refills)).not.toContain('Want me to reorder');
    expect(refills.structuredContent?.alerts[0].order).toMatchObject({ status: 'placed', readyOn: '2026-10-11' });
    const status = await call(sam, 'get_care_status');
    expect(said(status)).toContain('Amlodipine runs low: about three days left. A refill arrives tomorrow.');
    const again = await call(sam, 'request_refill', { confirm: true });
    expect(again.structuredContent?.result).toBe('already_ordered');
    expect(srv.store.orders).toHaveLength(1);
    await sam.close();
  });

  it('helpers cannot order', async () => {
    const maya = await connect(srv.url, 'maya');
    const r = await call(maya, 'request_refill', { confirm: true });
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("can't order refills");
    await maya.close();
  });
});

describe('refill links that expire or are cancelled', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let origin: string;
  let pickupUrl: string;
  beforeAll(async () => {
    srv = await startServer();
    origin = new URL(srv.url).origin;
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('offers to reorder when nothing is ordered yet', async () => {
    const sam = await connect(srv.url, 'sam');
    expect(said(await call(sam, 'check_refills'))).toContain('It comes from Riverside Pharmacy. Want me to reorder it?');
    await sam.close();
  });

  it('an expired link orders nothing, and a new request starts fresh', async () => {
    const sam = await connect(srv.url, 'sam');
    const first = await call(sam, 'request_refill', { confirm: true });
    srv.store.orders[0].expiresAt = new Date(Date.parse(NINE_AM_IST) - 1000).toISOString();
    expect((await fetch(first.structuredContent?.checkoutUrl)).status).toBe(410);
    await fetch(first.structuredContent?.checkoutUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: 'action=place'
    });
    expect(srv.store.orders[0].status).toBe('awaiting_checkout');
    const second = await call(sam, 'request_refill', { confirm: true, fulfilment: 'pickup' });
    expect(second.structuredContent?.result).toBe('checkout_ready');
    expect(second.structuredContent?.checkoutUrl).not.toBe(first.structuredContent?.checkoutUrl);
    expect(srv.store.orders).toHaveLength(2);
    pickupUrl = second.structuredContent?.checkoutUrl;
    await sam.close();
  });

  it('cancel on the page orders nothing and frees the medicine for a new refill', async () => {
    const res = await fetch(pickupUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: 'action=cancel'
    });
    expect(res.status).toBe(303);
    expect(srv.store.orders[1].status).toBe('cancelled');
    expect(await (await fetch(pickupUrl)).text()).toContain('Nothing was ordered');
    const sam = await connect(srv.url, 'sam');
    expect((await call(sam, 'request_refill')).structuredContent?.result).toBe('needs_confirmation');
    await sam.close();
  });
});

describe('MCP elicitation: form for "Reorder?", URL mode for checkout', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let origin: string;
  beforeAll(async () => {
    srv = await startServer();
    origin = new URL(srv.url).origin;
  });
  afterAll(async () => {
    await srv.stop();
  });

  const caps = { elicitation: { form: {}, url: {} } };

  it('a declined form orders nothing', async () => {
    const rose = await connect(
      srv.url,
      'rose',
      c => c.setRequestHandler('elicitation/create', async () => ({ action: 'decline' as const })),
      caps
    );
    const r = await call(rose, 'request_refill');
    expect(r.structuredContent?.result).toBe('declined');
    expect(said(r)).toBe("Okay, I won't reorder Amlodipine.");
    expect(srv.store.orders).toHaveLength(0);
    await rose.close();
  });

  it('accepting opens checkout out of band and reports completion', async () => {
    const asked: { mode?: string; message: string; url?: string; elicitationId?: string }[] = [];
    let onComplete: (id: string) => void = () => undefined;
    const completed = new Promise<string>(resolve => (onComplete = resolve));
    const rose = await connect(
      srv.url,
      'rose',
      c => {
        c.setRequestHandler('elicitation/create', async req => {
          asked.push(req.params as (typeof asked)[number]);
          return req.params.mode === 'url'
            ? { action: 'accept' as const }
            : { action: 'accept' as const, content: { reorder: true, fulfilment: 'pickup' } };
        });
        c.setNotificationHandler('notifications/elicitation/complete', n => onComplete(n.params.elicitationId));
      },
      caps
    );
    const r = await call(rose, 'request_refill', { spoken_name: 'blood pressure' });
    expect(r.structuredContent?.result).toBe('checkout_ready');
    expect(r.structuredContent?.order.fulfilment).toBe('pickup');
    expect(asked.map(a => a.mode ?? 'form')).toEqual(['form', 'url']);
    expect(asked[0].message).toContain('Should I reorder Amlodipine 5 mg, 30 tablets, from Riverside Pharmacy for delivery?');
    expect(asked[1].url).toBe(r.structuredContent?.checkoutUrl);
    expect(asked[1].elicitationId).toBe(r.structuredContent?.order.id);

    const html = await (await fetch(asked[1].url!)).text();
    expect(html).toMatch(/value="pickup" checked/);
    await fetch(asked[1].url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: 'action=place&fulfilment=pickup'
    });
    expect(await completed).toBe(srv.store.orders[0].id);
    expect(srv.store.orders[0]).toMatchObject({ status: 'placed', fulfilment: 'pickup', readyOn: '2026-10-10' });
    await rose.close();
  });
});
