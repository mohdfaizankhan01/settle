// Checkout from the locked card (PLAN M2). The order is built on the server from the card both
// sides confirmed, never from browser input, and carries `<dealId>:<card hash>` in custom_id.
// Before capture, a fresh GET of the order must match the card: amount, currency, payee and
// custom_id. A card that changed after confirmation can't be paid. Capturing is not the same
// as confirming payment: that still needs a verified webhook plus a fresh GET (M3).

import * as paypal from '../paypal';
import { cardHash, isHandoverDeal, isLocked, moneyOf, paysByHold } from './card';
import { actingRole, DealError } from './deals';
import { newPayerSecret, OTHER_DEVICE, payerHash, payerMatches } from './handover';
import { StaleWriteError, updateWithRetry, type DealStore } from './store';
import type { Deal } from './types';

export type PayPalDeps = Pick<typeof paypal, 'createOrder' | 'getOrder' | 'captureOrder'> & Partial<Pick<typeof paypal, 'authorizeOrder'>>;
export type CheckoutDeps = { store: DealStore; paypal?: PayPalDeps; publicHost: string; now?: () => Date };

const now = (deps: CheckoutDeps) => (deps.now ?? (() => new Date()))().toISOString();
const debugIdOf = (error: unknown) => (error instanceof paypal.PayPalApiError ? error.debugId : undefined);

export const customIdFor = (deal: Deal) => `${deal.id}:${cardHash(deal)}`;

/** Why a deal can't be paid right now, or undefined if it can. */
export function payBlocker(deal: Deal): string | undefined {
  if (!isLocked(deal)) return 'Both sides must confirm the card as it is now before paying.';
  if (deal.order && deal.order.status !== 'CREATED') return 'This deal already has a payment.';
  return undefined;
}

async function buyerDeal(store: DealStore, dealId: string, key: string | null) {
  const stored = await store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (actingRole(stored.value, key) !== 'buyer') throw new DealError('only the buyer can pay', 403);
  return stored;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function startCheckout(dealId: string, key: string | null, deps: CheckoutDeps, payer?: string | null) {
  const pp = deps.paypal ?? paypal;
  const stored = await buyerDeal(deps.store, dealId, key);
  const deal = stored.value;
  if (deal.demo) throw new DealError('judge mode never takes a payment; this is a demo deal', 409);
  const blocked = payBlocker(deal);
  if (blocked) throw new DealError(blocked, 409);

  // Meet-up deals: the device that starts the hold checkout becomes the payer device (security
  // review, Nov 5). Once claimed, any other device is refused before PayPal holds anything.
  const hold = isHandoverDeal(deal);
  const intent = hold ? ('AUTHORIZE' as const) : ('CAPTURE' as const);
  if (hold && deal.handover?.payer && !payerMatches(deal, payer)) {
    await deps.store.addReceipt({ dealId, kind: 'capture.blocked', at: now(deps), data: { reason: 'checkout started on another device' } });
    throw new DealError(OTHER_DEVICE, 409);
  }

  const hash = cardHash(deal);
  // Reuse an open order for the same card and intent; a changed card, or an order made the other
  // way (before holds existed), never reuses an old order.
  if (deal.order && deal.order.cardHash === hash && deal.order.status === 'CREATED' && (deal.order.intent ?? 'CAPTURE') === intent) {
    return { orderId: deal.order.id, ...(hold && payer ? { payerSecret: payer } : {}) };
  }

  const { item, price, delivery } = deal.card;
  const money = moneyOf(deal)!;
  const currency_code = price!.value.currency;
  const feeLine = deal.card.feePayer!.value === 'buyer'
    ? [{ name: "PayPal's fee, paid by the buyer", description: 'Estimate from PayPal\'s published rate (docs/fees.md)', amount: { currency_code, value: money.fee } }]
    : [];
  const order = await pp.createOrder(
    {
      dealId: deal.id,
      customId: customIdFor(deal),
      payeeMerchantId: deal.payeeMerchantId!,
      amount: { currency_code, value: money.total },
      items: [
        {
          name: clip(item!.value, 127),
          description: clip(`Settle Link deal ${deal.id}. Delivery: ${delivery!.display}.${deal.card.shipBy ? ` Ship by ${deal.card.shipBy.display}.` : ''}`, 127),
          amount: { currency_code, value: price!.value.amount },
        },
        ...feeLine,
      ],
      physical: delivery!.value !== 'digital',
      // In-person deals: PayPal holds the money until the buyer confirms the handover (DECISIONS #20).
      ...(hold ? { intent } : {}),
      returnUrl: `${deps.publicHost}/d/${deal.id}`,
      cancelUrl: `${deps.publicHost}/d/${deal.id}`,
    },
    // Same card and intent, same request ID: a double click can't create two orders.
    `settle-order-${deal.id}-${hash.slice(0, 16)}${hold ? '-hold' : ''}`,
  );
  // The payer claim is saved together with the order, only once PayPal created it: if anything
  // fails before this write, nothing is claimed and the buyer can simply try again (code review).
  const secret = hold ? (payer && payerMatches(deal, payer) ? payer : newPayerSecret()) : undefined;
  const claimed = hold && !deal.handover?.payer;
  const at = now(deps);
  const next: Deal = {
    ...deal,
    order: { id: order.data.id, cardHash: hash, createdAt: at, status: 'CREATED', debugId: order.debugId, intent },
    ...(claimed ? { handover: { ...deal.handover, payer: { hash: payerHash(secret!), at } } } : {}),
  };
  try {
    await deps.store.updateDeal(dealId, stored.version, next);
  } catch (error) {
    // The deal changed meanwhile (the card, or another device claimed the payment): start again.
    if (error instanceof StaleWriteError) throw new DealError('the deal changed; reload and try again', 409);
    throw error;
  }
  await deps.store.addReceipt({
    dealId,
    kind: 'order.created',
    at,
    data: { orderId: order.data.id, cardHash: hash, amount: money.total, currency: currency_code, feePayer: deal.card.feePayer!.value, payee: deal.payeeMerchantId!, intent, debugId: order.debugId ?? null },
  });
  // Every decision writes a receipt: which device may place and release the hold (code review).
  if (claimed) await deps.store.addReceipt({ dealId, kind: 'payer.claimed', at, data: { orderId: order.data.id } });
  return { orderId: order.data.id, ...(secret ? { payerSecret: secret } : {}) };
}

/** Compares a fresh PayPal order with the locked card. Returns the mismatches. */
export function orderMismatches(deal: Deal, order: paypal.Order): string[] {
  const unit = order.purchase_units?.[0];
  const price = deal.card.price?.value;
  const total = moneyOf(deal)?.total;
  const out: string[] = [];
  if (order.purchase_units?.length !== 1) out.push('order must have exactly one purchase unit');
  if (unit?.custom_id !== customIdFor(deal)) out.push('custom_id does not match the confirmed card');
  if (unit?.amount?.currency_code !== price?.currency) out.push('currency does not match the card');
  if (unit?.amount?.value !== total) out.push('amount does not match the card');
  if (unit?.payee?.merchant_id !== deal.payeeMerchantId) out.push('payee is not the connected seller');
  // Nobody pays themselves: a seller "buying" their own deal would fake a paid record.
  if (order.payer?.payer_id && order.payer.payer_id === deal.payeeMerchantId) out.push('the payer is the seller');
  return out;
}

export async function captureCheckout(dealId: string, key: string | null, orderId: string, deps: CheckoutDeps, payer?: string | null) {
  const pp = deps.paypal ?? paypal;
  const stored = await buyerDeal(deps.store, dealId, key);
  const deal = stored.value;
  if (deal.demo) throw new DealError('judge mode never takes a payment; this is a demo deal', 409);
  if (paysByHold(deal) && !payerMatches(deal, payer)) {
    await deps.store.addReceipt({ dealId, kind: 'capture.blocked', at: now(deps), data: { orderId, reason: 'hold requested from another device' } });
    throw new DealError(OTHER_DEVICE, 409);
  }
  if (!deal.order || deal.order.id !== orderId) throw new DealError('that order is not this deal\'s order', 409);
  if (!isLocked(deal) || deal.order.cardHash !== cardHash(deal)) {
    await deps.store.addReceipt({ dealId, kind: 'capture.blocked', at: now(deps), data: { orderId, reason: 'card changed after the order was created' } });
    throw new DealError('the card changed after this order was created, so it cannot be paid', 409);
  }

  // Freeze the card before PayPal hears about the payment: from here on a payee, term or decline
  // change is refused (paymentStarted), so PayPal can't take money for a card the record no longer
  // matches. A call still running elsewhere is refused; one that died long ago may be retried.
  if (deal.order.paying && Date.now() - Date.parse(deal.order.paying) < PAYING_GRACE_MS) {
    throw new DealError('this payment is already being sent to PayPal; wait a moment and reload', 409);
  }
  try {
    await deps.store.updateDeal(dealId, stored.version, { ...deal, order: { ...deal.order, paying: now(deps) } });
  } catch (error) {
    if (error instanceof StaleWriteError) throw new DealError('the deal changed while you were paying; reload and try again', 409);
    throw error;
  }
  try {
    return await sendPayment(dealId, deal, orderId, pp, deps);
  } catch (error) {
    // Nothing was taken: unfreeze, unless the payment is recorded after all.
    await updateWithRetry(deps.store, dealId, (d) => (d.order?.id === orderId && d.order.status === 'CREATED' ? { ...d, order: { ...d.order, paying: undefined } } : d)).catch(() => undefined);
    throw error;
  }
}

/** How long a capture or hold call may be at PayPal before another attempt is allowed. */
export const PAYING_GRACE_MS = 2 * 60_000;

async function sendPayment(dealId: string, deal: Deal, orderId: string, pp: PayPalDeps, deps: CheckoutDeps) {
  let fresh;
  try {
    fresh = await pp.getOrder(orderId, deal.payeeMerchantId!);
  } catch (error) {
    await deps.store.addReceipt({ dealId, kind: 'capture.blocked', at: now(deps), data: { orderId, reason: 'could not read the order from PayPal', debugId: debugIdOf(error) ?? null } });
    throw new DealError('could not check the order with PayPal; nothing was captured', 409);
  }
  const mismatches = orderMismatches(deal, fresh.data);
  // COMPLETED: an earlier capture went through but its answer was lost. Record it, don't refuse.
  const alreadyCaptured = fresh.data.status === 'COMPLETED';
  if (!alreadyCaptured && fresh.data.status !== 'APPROVED') mismatches.push(`order status is ${fresh.data.status}, not APPROVED`);
  if (mismatches.length > 0) {
    await deps.store.addReceipt({ dealId, kind: 'capture.blocked', at: now(deps), data: { orderId, reasons: mismatches, debugId: fresh.debugId ?? null } });
    throw new DealError(`not captured: ${mismatches.join('; ')}`, 409);
  }

  let captured = fresh;
  const hold = paysByHold(deal);
  if (!alreadyCaptured) {
    try {
      // A meet-up deal places a hold; the money is taken only at the handover (handover.ts).
      captured = hold
        ? await (pp.authorizeOrder ?? paypal.authorizeOrder)(orderId, `settle-authorize-${orderId}`)
        : await pp.captureOrder(orderId, `settle-capture-${orderId}`);
    } catch (error) {
      await deps.store.addReceipt({ dealId, kind: 'capture.failed', at: now(deps), data: { orderId, debugId: debugIdOf(error) ?? null } });
      // The capture may have gone through with its answer lost: read PayPal before giving up.
      const after = await pp.getOrder(orderId, deal.payeeMerchantId!).catch(() => null);
      if (!after || after.data.status !== 'COMPLETED' || orderMismatches(deal, after.data).length > 0) throw error;
      captured = after;
    }
  }
  const capture = captured.data.purchase_units?.[0]?.payments?.captures?.[0];
  const authorization = captured.data.purchase_units?.[0]?.payments?.authorizations?.[0];
  const status = captured.data.status === 'COMPLETED' ? (hold ? 'HOLD_REQUESTED' : 'CAPTURE_REQUESTED') : captured.data.status;
  for (let attempt = 0; ; attempt++) {
    const latest = (await deps.store.getDeal(dealId))!;
    try {
      // A verified webhook may already have recorded the payment; don't step its status back.
      const keep = latest.value.order!.status === 'COMPLETED' ? 'COMPLETED' : status;
      if (latest.value.order?.id !== orderId) break; // the order was replaced meanwhile: don't stamp another order
      await deps.store.updateDeal(dealId, latest.version, { ...latest.value, order: { ...latest.value.order!, status: keep, debugId: captured.debugId, paying: undefined } });
      break;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
    }
  }
  await deps.store.addReceipt({
    dealId,
    kind: hold ? 'order.hold_requested' : 'order.capture_requested',
    at: now(deps),
    data: hold
      ? { orderId, orderStatus: captured.data.status, authorizationId: authorization?.id ?? null, authorizationStatus: authorization?.status ?? null, debugId: captured.debugId ?? null }
      : { orderId, orderStatus: captured.data.status, captureId: capture?.id ?? null, captureStatus: capture?.status ?? null, debugId: captured.debugId ?? null },
  });
  return { status, captureStatus: capture?.status, authorizationStatus: authorization?.status };
}
