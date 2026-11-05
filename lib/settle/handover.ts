// Meet-up mode (PLAN M6, DECISIONS #20, spike D4). For a deal handed over in person, the buyer
// pays with intent AUTHORIZE: PayPal holds the money on the buyer's account, and Settle never
// holds it. At the meet-up the seller shows a one-time code; the buyer scans it on their own deal
// link and confirms, and only then does Settle ask PayPal to take the money. Walking away, or the
// hold getting older than PayPal's 3-day guarantee, releases it and the buyer is never charged.
//
// Rules, same as the ship gate: the hold counts only after a verified PAYMENT.AUTHORIZATION.CREATED
// webhook plus a fresh GET of the order that matches the locked card. The seller can never take
// the money alone: release needs the buyer's link key and the seller's code together. Fail closed:
// any PayPal error leaves the money held, never "paid". Every step writes a receipt. Wording: never
// "protected"; an in-person handover stays outside Seller Protection (SP-INPERSON, PP-COLLECT).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as paypal from '../paypal';
import { cardHash, isHandoverDeal, isLocked } from './card';
import { orderMismatches } from './checkout';
import { roleFor, DealError } from './deals';
import { paypalFor } from './demo-paypal';
import { refreshPayment, type PaymentDeps } from './payment';
import { updateWithRetry, type DealStore } from './store';
import type { Deal } from './types';

/** PayPal guarantees the held funds for 3 days (honor period, D4). */
export const HOLD_DAYS = 3;
const DAY_MS = 24 * 3600_000;
/** How long the seller's code works once shown. */
export const CODE_TTL_MS = 10 * 60_000;

export type HandoverPayPal = Pick<typeof paypal, 'getOrder' | 'captureAuthorization' | 'voidAuthorization'>;
export type HandoverDeps = { store: DealStore; paypal?: HandoverPayPal; now?: () => Date };

const nowOf = (deps: { now?: () => Date }) => (deps.now ?? (() => new Date()))();
const debugIdOf = (error: unknown) => (error instanceof paypal.PayPalApiError ? error.debugId : undefined);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export { isHandoverDeal };

/**
 * PayPal holds the money for this deal: a verified hold webhook, and the latest fresh read shows
 * that same authorization CREATED on an order that matches the card. Nothing taken or released yet.
 */
export function isHeld(deal: Deal): boolean {
  const { holdWebhook, read } = deal.payment ?? {};
  return (
    isHandoverDeal(deal) &&
    !!holdWebhook &&
    !!read?.ok &&
    read.authorizationId === holdWebhook.authorizationId &&
    read.authorizationStatus === 'CREATED' &&
    read.mismatches.length === 0 &&
    !deal.handover?.outcome &&
    !deal.handover?.inFlight
  );
}

/** When Settle releases an unused hold: 3 days after PayPal placed it. */
export function holdDeadline(deal: Deal): Date | undefined {
  const read = deal.payment?.read;
  const created = read?.ok ? read.authorizationCreated : undefined;
  return created ? new Date(Date.parse(created) + HOLD_DAYS * DAY_MS) : undefined;
}

async function load(store: DealStore, dealId: string) {
  const stored = await store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  return stored.value;
}

/** The seller shows a one-time code at the meet-up. Only its hash is kept. */
export async function showHandoverCode(dealId: string, key: string | null, deps: HandoverDeps) {
  const deal = await load(deps.store, dealId);
  if (roleFor(deal, key) !== 'seller') throw new DealError('only the seller shows the handover code', 403);
  if (!isHandoverDeal(deal)) throw new DealError('this deal is not handed over in person', 409);
  if (!isHeld(deal)) throw new DealError('PayPal does not show the money held for this deal yet, so there is nothing to hand over', 409);
  const at = nowOf(deps);
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(at.getTime() + CODE_TTL_MS).toISOString();
  await updateWithRetry(deps.store, dealId, (d) => ({ ...d, handover: { ...d.handover, token: { hash: sha256(token), createdAt: at.toISOString(), expiresAt } } }));
  await deps.store.addReceipt({ dealId, kind: 'handover.code_shown', at: at.toISOString(), data: { expiresAt, cardHash: cardHash(deal) } });
  return { token, expiresAt };
}

function tokenMatches(deal: Deal, token: string, at: Date): string | undefined {
  const t = deal.handover?.token;
  if (!t) return "The seller hasn't shown a handover code. Ask them to open theirs and scan it again.";
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(t.hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "This code isn't the seller's current one. Ask them to show it again and scan the new one.";
  if (Date.parse(t.expiresAt) < at.getTime()) return 'This code has expired. Ask the seller to show a new one.';
  return undefined;
}

/**
 * The buyer confirms the handover: their link key plus the seller's current code. A fresh read of
 * the order must still match the card and show the hold, then PayPal takes the money. Payment is
 * confirmed afterwards the usual way (verified capture webhook plus a fresh GET), not by this call.
 */
export async function releaseHandover(dealId: string, key: string | null, token: string, deps: HandoverDeps) {
  const deal = await load(deps.store, dealId);
  if (roleFor(deal, key) !== 'buyer') throw new DealError('only the buyer can release the money at the handover', 403);
  const at = nowOf(deps);
  const iso = at.toISOString();
  const refuse = async (reason: string, debugId?: string) => {
    await deps.store.addReceipt({ dealId, kind: 'handover.blocked', at: iso, data: { reason, debugId: debugId ?? null } });
    throw new DealError(reason, 409);
  };
  if (!isHandoverDeal(deal)) return refuse('This deal is not handed over in person.');
  const wrong = tokenMatches(deal, token, at);
  if (wrong) return refuse(wrong);
  if (!isLocked(deal) || deal.order?.cardHash !== cardHash(deal)) return refuse('The card changed after payment, so the money stays held.');
  if (!isHeld(deal)) return refuse('PayPal does not show the money held for this deal, so nothing can be taken. Nothing was charged.');

  const pp = paypalFor(deps.store, deal, deps.paypal, paypal as HandoverPayPal) as HandoverPayPal;
  // A fresh read right before taking the money: same order, same card, the hold still there.
  let fresh;
  try {
    fresh = await pp.getOrder(deal.order!.id, deal.payeeMerchantId!);
  } catch (error) {
    return refuse("Couldn't check the hold with PayPal. Nothing was taken; try again in a moment.", debugIdOf(error));
  }
  const auth = fresh.data.purchase_units?.[0]?.payments?.authorizations?.[0];
  const mismatches = orderMismatches(deal, fresh.data);
  if (!auth || auth.id !== deal.payment!.holdWebhook!.authorizationId) mismatches.push('the hold is not the one PayPal confirmed');
  else if (auth.status !== 'CREATED') mismatches.push(`PayPal shows the hold as ${auth.status}`);
  if (mismatches.length > 0) return refuse(`Not taken: ${mismatches.join('; ')}.`, fresh.debugId);

  // Claim the release first, so a second scan can't send a second capture.
  await updateWithRetry(deps.store, dealId, (d) => {
    if (d.handover?.inFlight || d.handover?.outcome) throw new DealError('This handover is already being completed.', 409);
    return { ...d, handover: { ...d.handover, token: undefined, inFlight: { kind: 'release', at: iso } } };
  });
  await deps.store.addReceipt({ dealId, kind: 'handover.release_requested', at: iso, data: { authorizationId: auth!.id, cardHash: cardHash(deal) } });

  try {
    const captured = await pp.captureAuthorization(auth!.id, `settle-handover-${auth!.id}`, deal.payeeMerchantId!);
    await finish(deps, dealId, { kind: 'released', at: iso, by: 'buyer', debugId: captured.debugId, captureId: captured.data.id });
    await deps.store.addReceipt({ dealId, kind: 'handover.released', at: iso, data: { authorizationId: auth!.id, captureId: captured.data.id, captureStatus: captured.data.status, debugId: captured.debugId ?? null } });
  } catch (error) {
    // The answer may be lost after PayPal took the money: a re-read decides, never a guess.
    const after = await pp.getOrder(deal.order!.id, deal.payeeMerchantId!).catch(() => null);
    const a = after?.data.purchase_units?.[0]?.payments?.authorizations?.[0];
    const cap = after?.data.purchase_units?.[0]?.payments?.captures?.[0];
    if (a?.status === 'CAPTURED' && cap) {
      await finish(deps, dealId, { kind: 'released', at: iso, by: 'buyer', debugId: after?.debugId, captureId: cap.id });
      await deps.store.addReceipt({ dealId, kind: 'handover.released', at: iso, data: { authorizationId: a.id, captureId: cap.id, captureStatus: cap.status, recovered: true, debugId: after?.debugId ?? null } });
    } else {
      const reason = error instanceof paypal.PayPalApiError ? `PayPal refused (${error.status})` : 'PayPal did not answer';
      await updateWithRetry(deps.store, dealId, (d) => ({ ...d, handover: { ...d.handover, inFlight: undefined, failed: { kind: 'release', at: iso, reason, debugId: debugIdOf(error) } } }));
      await deps.store.addReceipt({ dealId, kind: 'handover.release_failed', at: iso, data: { authorizationId: auth!.id, reason, debugId: debugIdOf(error) ?? null } });
      throw new DealError(`${reason}. Nothing was taken, so don't hand the item over yet.`, 409);
    }
  }
  await refreshAfter(deps, dealId);
  return { released: true };
}

async function finish(deps: HandoverDeps, dealId: string, outcome: NonNullable<NonNullable<Deal['handover']>['outcome']>) {
  await updateWithRetry(deps.store, dealId, (d) => ({ ...d, handover: { ...d.handover, inFlight: undefined, failed: undefined, token: undefined, outcome } }));
}

/** A fresh read after a capture or void, so both screens show PayPal's own state. Best effort. */
async function refreshAfter(deps: HandoverDeps, dealId: string) {
  await refreshPayment(dealId, { kind: 'page' }, { store: deps.store, paypal: deps.paypal as PaymentDeps['paypal'], now: deps.now }).catch(() => undefined);
}

/**
 * Releases the hold so the buyer is never charged: the buyer walks away, the seller calls it off,
 * or the hold passed PayPal's 3-day guarantee without a handover.
 */
export async function voidHold(dealId: string, by: 'buyer' | 'seller' | 'meet_by_passed', deps: HandoverDeps) {
  const deal = await load(deps.store, dealId);
  if (!isHeld(deal)) throw new DealError('There is no hold to release on this deal.', 409);
  const pp = paypalFor(deps.store, deal, deps.paypal, paypal as HandoverPayPal) as HandoverPayPal;
  const iso = nowOf(deps).toISOString();
  const authorizationId = deal.payment!.holdWebhook!.authorizationId;
  await updateWithRetry(deps.store, dealId, (d) => {
    if (d.handover?.inFlight || d.handover?.outcome) throw new DealError('This handover is already being completed.', 409);
    return { ...d, handover: { ...d.handover, token: undefined, inFlight: { kind: 'void', at: iso } } };
  });
  try {
    const voided = await pp.voidAuthorization(authorizationId, `settle-void-${authorizationId}`, deal.payeeMerchantId!);
    await finish(deps, dealId, { kind: 'voided', at: iso, by, debugId: voided.debugId });
    await deps.store.addReceipt({ dealId, kind: 'handover.voided', at: iso, data: { authorizationId, by, status: voided.data.status, debugId: voided.debugId ?? null } });
  } catch (error) {
    const after = await pp.getOrder(deal.order!.id, deal.payeeMerchantId!).catch(() => null);
    const a = after?.data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (a?.status === 'VOIDED') {
      await finish(deps, dealId, { kind: 'voided', at: iso, by, debugId: after?.debugId });
      await deps.store.addReceipt({ dealId, kind: 'handover.voided', at: iso, data: { authorizationId, by, status: a.status, recovered: true, debugId: after?.debugId ?? null } });
    } else {
      const reason = error instanceof paypal.PayPalApiError ? `PayPal refused (${error.status})` : 'PayPal did not answer';
      await updateWithRetry(deps.store, dealId, (d) => ({ ...d, handover: { ...d.handover, inFlight: undefined, failed: { kind: 'void', at: iso, reason, debugId: debugIdOf(error) } } }));
      await deps.store.addReceipt({ dealId, kind: 'handover.void_failed', at: iso, data: { authorizationId, by, reason, debugId: debugIdOf(error) ?? null } });
      throw new DealError(`${reason}. The money is still held; try again in a moment.`, 409);
    }
  }
  await refreshAfter(deps, dealId);
  return { voided: true };
}

/** The buyer walks away, or the seller calls it off: either side may release the hold. */
export async function cancelHandover(dealId: string, key: string | null, deps: HandoverDeps) {
  const deal = await load(deps.store, dealId);
  const role = roleFor(deal, key);
  if (!role) throw new DealError('this link is not valid for the deal', 403);
  return voidHold(dealId, role, deps);
}

/** On a page load: a hold past PayPal's 3-day guarantee with no handover is released. */
export async function releaseExpiredHold(deal: Deal, deps: HandoverDeps): Promise<Deal> {
  const deadline = holdDeadline(deal);
  if (!isHeld(deal) || !deadline || nowOf(deps) < deadline) return deal;
  await voidHold(deal.id, 'meet_by_passed', deps).catch(() => undefined);
  return (await deps.store.getDeal(deal.id))?.value ?? deal;
}
