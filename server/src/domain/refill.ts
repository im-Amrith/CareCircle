/**
 * Refill ordering rules. Pure apart from token generation: no MCP, no HTTP.
 *
 * Flow: request_refill confirms by voice ("Reorder? Yes"), creates an order in
 * awaiting_checkout with a one-time checkout link, and the order is only placed
 * when someone completes the checkout page. Nothing is ever ordered without
 * both the spoken yes and the checkout step.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Fulfilment, Medication, OrderStatus, RefillOrder } from '../store/types.js';
import { addDays, localParts } from './time.js';
import { pillsPerDay } from './care.js';

/** Days of supply in a standard refill. */
export const REFILL_DAYS = 30;
/** How long a checkout link stays valid. */
export const CHECKOUT_MINUTES = 15;

export function refillQuantity(med: Medication): number {
  return Math.max(1, pillsPerDay(med) * REFILL_DAYS);
}

/** A fresh one-time checkout token (256 bits, URL-safe) and the hash that gets stored. */
export function newCheckoutToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Tokens are exactly 43 base64url characters; anything else is rejected before a lookup. */
export function isTokenShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** The status as of `now`: an unfinished checkout past its expiry reads as expired. */
export function effectiveStatus(order: RefillOrder, now: Date): OrderStatus {
  if (order.status === 'awaiting_checkout' && Date.parse(order.expiresAt) <= now.getTime()) return 'expired';
  return order.status;
}

/** Delivery arrives the next day; pickup is ready the same day. Family-local date. */
export function readyOn(fulfilment: Fulfilment, now: Date, timezone: string): string {
  const today = localParts(now, timezone).date;
  return fulfilment === 'delivery' ? addDays(today, 1) : today;
}

/**
 * The order that already covers this medicine, if any: a checkout still in
 * progress, or a placed order that hasn't arrived yet. Saying "yes" twice
 * finds this instead of ordering twice.
 */
export function openOrderFor(orders: RefillOrder[], medicationId: string, now: Date, timezone: string): RefillOrder | undefined {
  const today = localParts(now, timezone).date;
  return orders
    .filter(o => o.medicationId === medicationId)
    .reverse()
    .find(o => {
      const status = effectiveStatus(o, now);
      return status === 'awaiting_checkout' || (status === 'placed' && (o.readyOn ?? today) >= today);
    });
}
