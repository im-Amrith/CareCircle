import * as z from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { Fulfilment, Language, Medication, RefillOrder } from '../store/types.js';
import { dateHi } from '../domain/hindi.js';
import { matchMedication, refillAlerts, supply } from '../domain/care.js';
import {
  CHECKOUT_MINUTES,
  effectiveStatus,
  newCheckoutToken,
  openOrderFor,
  refillQuantity
} from '../domain/refill.js';
import { spokenDate } from '../domain/time.js';
import { listJoin, plural, sentences } from '../domain/speech.js';
import { uiMeta } from './apps.js';
import { guarded, ok, requireRole, resolveCaller, type Caller, type Deps } from './context.js';

const FulfilmentEnum = z.enum(['delivery', 'pickup']);

export const OrderOut = z.object({
  id: z.string(),
  medicationId: z.string(),
  name: z.string(),
  strength: z.string(),
  quantity: z.number(),
  pharmacy: z.string(),
  fulfilment: FulfilmentEnum,
  status: z.enum(['awaiting_checkout', 'placed', 'cancelled', 'expired']),
  expiresAt: z.string(),
  readyOn: z.string().optional()
});

export async function orderOut(deps: Deps, order: RefillOrder, now: Date): Promise<z.infer<typeof OrderOut>> {
  const med = await deps.store.getMedication(order.familyId, order.medicationId);
  const pharmacy = await deps.store.getPharmacy(order.pharmacyId);
  return {
    id: order.id,
    medicationId: order.medicationId,
    name: med?.name ?? order.medicationId,
    strength: med?.strength ?? '',
    quantity: order.quantity,
    pharmacy: pharmacy?.name ?? 'the pharmacy',
    fulfilment: order.fulfilment,
    status: effectiveStatus(order, now),
    expiresAt: order.expiresAt,
    ...(order.readyOn ? { readyOn: order.readyOn } : {})
  };
}

/** One spoken sentence about an open order, e.g. "A refill arrives tomorrow." */
export function orderSentence(order: RefillOrder, now: Date, today: string, lang: Language = 'en'): string {
  const awaiting = effectiveStatus(order, now) === 'awaiting_checkout';
  if (lang === 'hi') {
    if (awaiting) return 'रीफ़िल का ऑर्डर चेकआउट के इंतज़ार में है।';
    const when = dateHi(order.readyOn ?? today, today);
    return order.fulfilment === 'delivery' ? `रीफ़िल ${when} पहुँच जाएगा।` : `रीफ़िल ${when} दुकान पर लेने के लिए तैयार होगा।`;
  }
  if (awaiting) return 'A refill is waiting for checkout.';
  const when = spokenDate(order.readyOn ?? today, today);
  return order.fulfilment === 'delivery' ? `A refill arrives ${when}.` : `A refill is ready for pickup ${when}.`;
}

/** Open orders keyed by medication id, for status and refill summaries. */
export async function openOrders(deps: Deps, caller: Caller): Promise<Map<string, RefillOrder>> {
  const orders = await deps.store.listOrders(caller.family.id);
  const out = new Map<string, RefillOrder>();
  for (const id of new Set(orders.map(o => o.medicationId))) {
    const open = openOrderFor(orders, id, caller.now, caller.family.timezone);
    if (open) out.set(id, open);
  }
  return out;
}

function baseUrl(deps: Deps, ctx: ServerContext): string {
  if (deps.publicUrl) return deps.publicUrl;
  const url = ctx.http?.req?.url;
  if (url) {
    try {
      return new URL(url).origin;
    } catch {
      // fall through
    }
  }
  return 'http://127.0.0.1:8000';
}

/** Elicitation support as advertised by the client. A bare `elicitation: {}` means form only. */
export function elicitationSupport(server: McpServer) {
  const caps = server.server.getClientCapabilities()?.elicitation as { form?: object; url?: object } | undefined;
  return { form: !!caps && (!!caps.form || !caps.url), url: !!caps?.url };
}

export function registerRefillTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'request_refill',
    {
      title: 'Reorder a medicine',
      description:
        "Start a refill of a medicine that is running low, from the family's pharmacy. Use for 'Reorder my blood pressure tablets', 'Order more Amlodipine', or when the user says yes after hearing a medicine runs low. With no medicine named, picks the one running out soonest. The user must agree first: clients with elicitation get a confirmation form every time; otherwise, if this returns needs_confirmation, ask the question it gives and only call again with confirm set to true after a clear yes. Nothing is ordered until checkout is completed on the secure checkout page. Asking twice never orders twice.",
      inputSchema: z.object({
        spoken_name: z.string().max(120).optional().describe("The medicine as the person said it, e.g. 'my blood pressure tablets'"),
        medication_id: z.string().optional().describe('Exact medication id, if already known'),
        fulfilment: FulfilmentEnum.default('delivery').describe('Home delivery or pharmacy pickup'),
        confirm: z
          .boolean()
          .default(false)
          .describe('Set true only after the user has clearly said yes to the reorder question this tool asked. Ignored when the client supports elicitation: the user is asked directly.')
      }),
      outputSchema: z.object({
        result: z.enum(['needs_confirmation', 'checkout_ready', 'already_ordered', 'declined', 'needs_clarification', 'not_found']),
        order: OrderOut.nullable(),
        // Optional rather than nullable: Zod emits nullable strings as `type: ["string", "null"]`,
        // which single-type schema dialects (e.g. Gemini's OpenAPI subset) reject.
        checkoutUrl: z.string().optional().describe('One-time secure checkout link, when result is checkout_ready. Show it on screen; never read it aloud.'),
        question: z.string().optional().describe('The question to ask, when result is needs_confirmation'),
        options: z.array(z.object({ id: z.string(), name: z.string(), purpose: z.string() }))
      }),
      annotations: { title: 'Reorder a medicine', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      // Purchases go through the conversation and its confirmation, never straight from a view.
      _meta: uiMeta(['model'])
    },
    guarded(async ({ spoken_name, medication_id, fulfilment, confirm }, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      requireRole(caller, ['recipient', 'coordinator'], 'order refills');
      const meds = await deps.store.listMedications(caller.family.id);
      const base = { order: null, options: [] };
      const optionsOf = (list: Medication[]) => list.map(m => ({ id: m.id, name: m.name, purpose: m.purpose }));

      // 1. Which medicine.
      let med: Medication | undefined;
      if (medication_id) {
        med = meds.find(m => m.id === medication_id);
        if (!med) return ok({ ...base, result: 'not_found' as const, options: optionsOf(meds) }, `I don't know that medicine. Which one should I reorder?`);
      } else if (spoken_name) {
        const match = matchMedication(meds, spoken_name);
        if (match.kind === 'none') {
          return ok(
            { ...base, result: 'not_found' as const, options: optionsOf(meds) },
            `I couldn't match "${spoken_name}" to a medicine. Which one should I reorder: ${listJoin(meds.map(m => m.name), 'or')}?`
          );
        }
        if (match.kind === 'ambiguous') {
          return ok(
            { ...base, result: 'needs_clarification' as const, options: optionsOf(match.matches) },
            `Which one should I reorder: ${listJoin(match.matches.map(m => `${m.name} for ${m.purpose}`), 'or')}?`
          );
        }
        med = match.matches[0];
      } else {
        const low = refillAlerts(meds, caller.local.date)[0];
        med = low && meds.find(m => m.id === low.medicationId);
        if (!med) {
          return ok(
            { ...base, result: 'needs_clarification' as const, options: optionsOf(meds) },
            `Nothing is running low right now. Which medicine should I reorder?`
          );
        }
      }

      const pharmacy = await deps.store.getPharmacy(med.pharmacyId);
      const pharmacyName = pharmacy?.name ?? 'the pharmacy';
      const label = `${med.name} ${med.strength}`;

      // 2. Already covered? Then never order again.
      const existing = openOrderFor(await deps.store.listOrders(caller.family.id), med.id, caller.now, caller.family.timezone);
      if (existing) {
        return ok(
          { ...base, result: 'already_ordered' as const, order: await orderOut(deps, existing, caller.now) },
          sentences(
            `${med.name} is already taken care of.`,
            orderSentence(existing, caller.now, caller.local.date),
            'I have not ordered it again.'
          )
        );
      }

      // 3. Ask first. A client with form elicitation always gets the form, even with
      //    confirm=true: the person answers the server directly, so a model can't
      //    supply the yes on their behalf. Voice-only clients ask aloud and send confirm.
      const quantity = refillQuantity(med);
      const left = supply(med, caller.local.date).daysLeft;
      const how = (f: Fulfilment) => (f === 'delivery' ? 'for delivery' : 'for pickup');
      const question = `Should I reorder ${label}, ${plural(quantity, med.form)}, from ${pharmacyName} ${how(fulfilment)}?`;
      const canAsk = elicitationSupport(server).form;
      if (canAsk || !confirm) {
        let answered = false;
        if (canAsk) {
          try {
            const reply = await ctx.mcpReq.elicitInput({
              mode: 'form',
              message: `${med.name} has about ${plural(left, 'day')} left. ${question}`,
              requestedSchema: {
                type: 'object',
                properties: {
                  reorder: { type: 'boolean', title: `Reorder ${label}`, default: true },
                  fulfilment: {
                    type: 'string',
                    title: 'Delivery or pickup',
                    oneOf: [
                      { const: 'delivery', title: 'Home delivery' },
                      { const: 'pickup', title: `Pick up at ${pharmacyName}` }
                    ],
                    default: fulfilment
                  }
                },
                required: ['reorder']
              }
            });
            answered = true;
            const content = reply.content as { reorder?: unknown; fulfilment?: unknown } | undefined;
            if (reply.action !== 'accept' || content?.reorder !== true) {
              return ok({ ...base, result: 'declined' as const }, `Okay, I won't reorder ${med.name}.`);
            }
            if (content.fulfilment === 'delivery' || content.fulfilment === 'pickup') fulfilment = content.fulfilment;
          } catch (err) {
            console.warn('[carecircle] form elicitation failed, asking by voice instead', err);
          }
        }
        if (!answered && !confirm) {
          return ok(
            { ...base, result: 'needs_confirmation' as const, question },
            `${med.name} has about ${plural(left, 'day')} left. ${question}`
          );
        }
      }

      // 4. Create the order, waiting for checkout, with a one-time link.
      const { token, hash } = newCheckoutToken();
      const order: RefillOrder = {
        id: `ord-${caller.now.getTime().toString(36)}-${hash.slice(0, 8)}`,
        familyId: caller.family.id,
        medicationId: med.id,
        pharmacyId: med.pharmacyId,
        quantity,
        fulfilment,
        status: 'awaiting_checkout',
        requestedBy: caller.member.id,
        createdAt: caller.now.toISOString(),
        checkoutTokenHash: hash,
        expiresAt: new Date(caller.now.getTime() + CHECKOUT_MINUTES * 60_000).toISOString()
      };
      await deps.store.addOrder(order);
      const checkoutUrl = `${baseUrl(deps, ctx)}/checkout/${token}`;

      // 5. Hand the link over out of band when the client supports URL elicitation,
      //    so it opens in the browser and never passes through the model.
      const supports = elicitationSupport(server);
      if (supports.url) {
        deps.checkoutWatchers?.set(order.id, server.server.createElicitationCompletionNotifier(order.id));
        try {
          await ctx.mcpReq.elicitInput({
            mode: 'url',
            elicitationId: order.id,
            url: checkoutUrl,
            message: `Confirm the ${med.name} refill on CareCircle's secure checkout page.`
          });
        } catch (err) {
          console.warn('[carecircle] URL elicitation failed; checkout link is in the result', err);
        }
      }

      return ok(
        { ...base, result: 'checkout_ready' as const, order: await orderOut(deps, order, caller.now), checkoutUrl },
        sentences(
          `Okay. I've started a refill of ${label}, ${plural(quantity, med.form)}, from ${pharmacyName} ${how(fulfilment)}.`,
          `To place it, open the checkout link. It works for ${CHECKOUT_MINUTES} minutes, and nothing is ordered until you confirm there.`
        )
      );
    })
  );
}
