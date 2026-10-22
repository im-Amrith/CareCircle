import express, { type Router } from 'express';
import type { Deps } from '../mcp/context.js';
import { voiceCheckFor } from '../mcp/identity.js';
import { isTokenShaped } from '../domain/refill.js';
import { esc, page, sameOrigin } from './checkout.js';

/**
 * The phone confirmation for a change asked for on a shared device when the voice match
 * was unsure (low confidence) and the client has no forms. GET /voice-check/<token>
 * asks "Was this you?"; POST answers it, and the waiting tool call goes ahead as that
 * person, or not at all.
 *
 * Simulated: a real deployment would send this to each candidate's own signed-in phone.
 * Same protections as checkout: a one-time 256-bit token (only its hash is kept),
 * no-store, no framing, no scripts, same-origin posts only.
 */
export function voiceCheckRouter(deps: Deps): Router {
  const router = express.Router();
  router.use('/voice-check', express.urlencoded({ extended: false, limit: '1kb' }));

  const load = (token: string) => (isTokenShaped(token) ? voiceCheckFor(deps, token) : undefined);
  const gone = '<p>This confirmation has expired or was already answered. Nothing was changed.</p>';

  router.get('/voice-check/:token', (req, res) => {
    const check = load(String(req.params.token ?? ''));
    if (!check) return page(res, 404, 'Link not found', gone);
    const buttons = check.candidates
      .map(c => `<button class="primary" name="member" value="${esc(c.id)}">Yes, it was me (${esc(c.name)})</button>`)
      .join('');
    page(
      res,
      200,
      'Was this you?',
      `<p>Someone asked CareCircle on ${esc(check.deviceName)}'s device to <strong>${esc(check.attempted)}</strong>, and the voice match wasn't sure who it was.</p>
<form method="post"><div class="actions">${buttons}<button name="member" value="someone_else">No, it wasn't me</button></div></form>
<p class="note">Nothing changes until someone confirms here.</p>`
    );
  });

  router.post('/voice-check/:token', (req, res) => {
    if (!sameOrigin(req)) return page(res, 403, 'Not allowed', '<p>This request did not come from the CareCircle confirmation page.</p>');
    const check = load(String(req.params.token ?? ''));
    if (!check) return page(res, 404, 'Link not found', gone);
    const answer = String(req.body?.member ?? '');
    const member = check.candidates.find(c => c.id === answer);
    if (!member && answer !== 'someone_else') return page(res, 400, 'Try again', '<p>Pick one of the answers on the confirmation page.</p>');
    check.settle(member ? member.id : 'someone_else');
    check.expiresAt = 0; // answered: the link stops working
    page(
      res,
      200,
      member ? `Thanks, ${member.name}` : 'Thanks for letting us know',
      member
        ? `<p class="done">CareCircle will ${esc(check.attempted)} now.</p>`
        : `<p class="done">Nothing was changed. CareCircle has noted it for the family.</p>`
    );
  });

  return router;
}
