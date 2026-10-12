import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { Deps } from '../mcp/context.js';
import type { RefillOrder } from '../store/types.js';
import { effectiveStatus, hashToken, isTokenShaped, readyOn } from '../domain/refill.js';
import { localParts, spokenDate } from '../domain/time.js';

/**
 * The secure checkout page that request_refill links to: GET /checkout/<token>
 * shows the order, POST places or cancels it.
 *
 * - The token is 256 random bits, single-use and short-lived; only its hash is stored.
 * - Nothing is cached or leaked: no-store, same-origin referrers only, no framing, a CSP with
 *   no scripts at all, and form posts only to this same page.
 * - Placing is a compare-and-set from awaiting_checkout, so a double submit or a
 *   submit racing a cancel places at most one order.
 * - POSTs must come from this page: Origin (or Sec-Fetch-Site) is checked
 *   against the request's own host, on top of the app-wide Host/Origin checks.
 * - No payment details are collected; payment is settled with the pharmacy (demo).
 */
export function checkoutRouter(deps: Deps): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '2kb' }));

  async function load(req: Request, res: Response): Promise<RefillOrder | undefined> {
    const token = String(req.params.token ?? '');
    const order = isTokenShaped(token) ? await deps.store.getOrderByTokenHash(hashToken(token)) : undefined;
    if (!order) {
      page(res, 404, 'Link not found', `<p>This checkout link isn't valid. Ask CareCircle to start the refill again.</p>`);
      return undefined;
    }
    return order;
  }

  router.get('/checkout/:token', async (req, res) => {
    const order = await load(req, res);
    if (order) await render(res, order);
  });

  router.post('/checkout/:token', async (req, res) => {
    if (!sameOrigin(req)) {
      page(res, 403, 'Not allowed', '<p>This request did not come from the CareCircle checkout page.</p>');
      return;
    }
    const order = await load(req, res);
    if (!order) return;
    const now = deps.clock();
    const action = req.body?.action;
    if (effectiveStatus(order, now) === 'awaiting_checkout') {
      if (action === 'place') {
        const family = await deps.store.getFamily(order.familyId);
        const fulfilment = req.body?.fulfilment === 'pickup' ? 'pickup' : 'delivery';
        await deps.store.transitionOrder(order.id, 'awaiting_checkout', {
          status: 'placed',
          fulfilment,
          placedAt: now.toISOString(),
          readyOn: readyOn(fulfilment, now, family?.timezone ?? 'UTC')
        });
      } else if (action === 'cancel') {
        await deps.store.transitionOrder(order.id, 'awaiting_checkout', { status: 'cancelled', cancelledAt: now.toISOString() });
      } else {
        page(res, 400, 'Something went wrong', '<p>Please go back and choose Place order or Cancel.</p>');
        return;
      }
      const notify = deps.checkoutWatchers?.get(order.id);
      if (notify) {
        deps.checkoutWatchers?.delete(order.id);
        void notify().catch(() => undefined);
      }
    }
    // Post/redirect/get, so a refresh never resubmits.
    res.redirect(303, req.originalUrl);
  });

  async function render(res: Response, order: RefillOrder) {
    const now = deps.clock();
    const med = await deps.store.getMedication(order.familyId, order.medicationId);
    const pharmacy = await deps.store.getPharmacy(order.pharmacyId);
    const family = await deps.store.getFamily(order.familyId);
    const requester = await deps.store.getMember(order.requestedBy);
    const recipient = family && (await deps.store.getMember(family.recipientId));
    const tz = family?.timezone ?? 'UTC';
    const today = localParts(now, tz).date;
    const name = med ? `${med.name} ${med.strength}` : 'Medicine';
    const pharmacyName = pharmacy?.name ?? 'the pharmacy';
    const unit = med?.form ?? 'tablet';
    const details = `
      <dl>
        <dt>Medicine</dt><dd>${esc(name)}</dd>
        <dt>Quantity</dt><dd>${order.quantity} ${esc(unit)}${order.quantity === 1 ? '' : 's'} (30 days)</dd>
        <dt>For</dt><dd>${esc(recipient?.name ?? 'Your family')}</dd>
        <dt>Pharmacy</dt><dd>${esc(pharmacyName)}</dd>
        <dt>Requested by</dt><dd>${esc(requester?.name ?? order.requestedBy)}</dd>
      </dl>`;

    switch (effectiveStatus(order, now)) {
      case 'awaiting_checkout': {
        const expires = localParts(new Date(order.expiresAt), tz).time;
        const radio = (value: string, label: string) =>
          `<label class="choice"><input type="radio" name="fulfilment" value="${value}"${order.fulfilment === value ? ' checked' : ''}> ${esc(label)}</label>`;
        page(
          res,
          200,
          'Confirm refill',
          `${details}
          <form method="post">
            <fieldset>
              <legend>How should it arrive?</legend>
              ${pharmacy?.delivery !== false ? radio('delivery', 'Home delivery, tomorrow') : ''}
              ${pharmacy?.pickup !== false ? radio('pickup', `Pick up at ${pharmacyName}, today`) : ''}
            </fieldset>
            <p class="note">Payment is settled with ${esc(pharmacyName)} on ${order.fulfilment === 'pickup' ? 'pickup' : 'delivery'}. CareCircle never asks for card details. This is a demo: no real order is sent.</p>
            <div class="actions">
              <button type="submit" name="action" value="place" class="primary">Place order</button>
              <button type="submit" name="action" value="cancel">Cancel</button>
            </div>
          </form>
          <p class="note">This link works until ${esc(expires)} and can be used once.</p>`
        );
        return;
      }
      case 'placed': {
        const when = spokenDate(order.readyOn ?? today, today);
        page(
          res,
          200,
          'Refill ordered',
          `<p class="done">${esc(pharmacyName)} has your order. ${
            order.fulfilment === 'delivery' ? `It arrives ${esc(when)}.` : `It's ready for pickup ${esc(when)}.`
          }</p>${details}<p class="note">You can close this page. Alexa knows the refill is on its way.</p>`
        );
        return;
      }
      case 'cancelled':
        page(res, 200, 'Refill cancelled', `<p>Nothing was ordered. Ask CareCircle any time to start a new refill.</p>${details}`);
        return;
      case 'expired':
        page(res, 410, 'Link expired', `<p>This checkout link has expired and nothing was ordered. Ask CareCircle to start the refill again.</p>`);
        return;
    }
  }

  return router;
}

/** A POST must come from a page on this same host. Browsers always send Origin on form posts. */
function sameOrigin(req: Request): boolean {
  const origin = req.header('origin');
  if (origin) {
    try {
      return new URL(origin).host === req.header('host');
    } catch {
      return false;
    }
  }
  const site = req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(res: Response, status: number, title: string, body: string) {
  const nonce = randomBytes(16).toString('base64');
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on the
      // form post, which the Origin checks reject. same-origin still never leaks the
      // token-bearing URL to other sites.
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
    })
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · CareCircle</title>
<style nonce="${nonce}">
  :root { --bg: #f6f4ef; --card: #fff; --ink: #1d2320; --muted: #5d6662; --line: #e2ded5; --accent: #1f6f5c; --accent-ink: #fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151917; --card: #1e2421; --ink: #e9ece9; --muted: #a2aba6; --line: #323a36; --accent: #5cc2a5; --accent-ink: #0d1411; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 30rem; margin: 0 auto; padding: 2rem 16px; }
  .brand { color: var(--accent); font-weight: 600; letter-spacing: .02em; margin: 0 0 .25rem; }
  h1 { font-size: 1.6rem; margin: 0 0 1.25rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 0 0 1rem; }
  dt { color: var(--muted); } dd { margin: 0; font-weight: 500; }
  fieldset { border: 0; padding: 0; margin: 0 0 1rem; }
  legend { font-weight: 600; margin-bottom: .4rem; }
  .choice { display: block; padding: .6rem .75rem; border: 1px solid var(--line); border-radius: 10px; margin-bottom: .5rem; cursor: pointer; }
  .actions { display: flex; gap: .75rem; flex-wrap: wrap; }
  button { font: inherit; padding: .7rem 1.2rem; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; flex: 1; }
  .note { color: var(--muted); font-size: .9rem; }
  .done { font-size: 1.1rem; font-weight: 500; }
</style>
</head>
<body><main><p class="brand">CareCircle</p><h1>${esc(title)}</h1><div class="card">${body}</div></main></body>
</html>`);
}
