// The seller's shipping actions (PLAN M3): type the postcode from the label, and add tracking to
// the PayPal order. Each one updates the record, writes a receipt and re-runs the ship gate.

import type { PaypalClient } from 'paypal';
import { PayPalApiError } from '../paypal';
import { addTrackingViaSdk } from '../paypal-sdk';
import { replaySdk } from './demo-paypal';
import { CARRIERS } from './carriers';
import { DealError, roleFor } from './deals';
import { refreshPayment, type PaymentPayPal } from './payment';
import { isPaid, normalPostcode, syncGate, trackerShown } from './ship-gate';
import { updateWithRetry, type DealStore } from './store';
import type { Deal, Shipping } from './types';

export type ShippingDeps = {
  store: DealStore;
  now?: () => Date;
  /** For the fresh GET after tracking (plain fetch). */
  paypal?: PaymentPayPal;
  /** The SDK client for add-tracking; tests pass one built over a fake fetch. */
  sdk?: PaypalClient;
};
const nowOf = (deps: ShippingDeps) => (deps.now ?? (() => new Date()))().toISOString();

/** Reads the deal as the seller; only the seller ships. */
export async function sellerDeal(store: DealStore, dealId: string, key: string | null) {
  const stored = await store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (roleFor(stored.value, key) !== 'seller') throw new DealError('only the seller can do this', 403);
  if (!stored.value.order || stored.value.order.status === 'CREATED') throw new DealError('the buyer has not paid yet', 409);
  return stored;
}

const POSTCODE: Record<Deal['country'], RegExp> = {
  UK: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
  US: /^\d{5}(?:-\d{4})?$/,
};

export async function setLabelPostcode(dealId: string, key: string | null, raw: string, deps: ShippingDeps) {
  const value = raw.trim().toUpperCase();
  const stored = await sellerDeal(deps.store, dealId, key);
  if (!POSTCODE[stored.value.country].test(value)) {
    throw new DealError(stored.value.country === 'US' ? 'enter a ZIP code like 94107' : 'enter a postcode like LS1 1AA');
  }
  const at = nowOf(deps);
  const { after } = await updateWithRetry(deps.store, dealId, (d) => ({ ...d, shipping: { ...d.shipping, labelPostcode: { value, at } } }));
  const read = after.payment?.read;
  const paypal = read?.ok ? read.shipTo?.postalCode : undefined;
  await deps.store.addReceipt({
    dealId,
    kind: 'shipping.label_postcode',
    at,
    // The postcode is compared, not kept in the receipt: receipts hold decisions, not addresses.
    data: { matchesPayPal: paypal ? normalPostcode(paypal, after.country) === normalPostcode(value, after.country) : null },
  });
  await syncGate(deps.store, dealId, at);
  return (await deps.store.getDeal(dealId))!;
}

const TRACKING_RE = /^[A-Za-z0-9-]{4,40}$/;
/** A 'sending' claim older than this belongs to a call that died; it is treated as unknown. */
export const SENDING_STALE_MS = 2 * 60_000;

export type TrackingRequest = { carrier: string; number: string; carrierName?: string };

const setTracking = (deps: ShippingDeps, dealId: string, change: (deal: Deal) => Shipping['tracking']) =>
  updateWithRetry(deps.store, dealId, (d) => ({ ...d, shipping: { ...d.shipping, tracking: change(d) } }));

/**
 * Adds tracking to the PayPal order through the SDK, then re-reads the order: the tracking check
 * passes only when PayPal shows the tracker. Order: validate → claim on the deal → SDK call →
 * record. A lost answer is "unknown", never "failed": the order is re-read to settle it.
 */
export async function addTracking(dealId: string, key: string | null, input: TrackingRequest, deps: ShippingDeps) {
  const number = input.number.trim().toUpperCase().replace(/\s+/g, '');
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const at = new Date(nowMs).toISOString();
  const deal = (await sellerDeal(deps.store, dealId, key)).value;
  // Invariants, checked before any claim: this deal's order, its confirmed capture, its seller.
  if (!isPaid(deal)) throw new DealError('tracking can be added once PayPal has confirmed the payment', 409);
  const carrier = CARRIERS[deal.country].find((c) => c.id === input.carrier);
  if (!carrier) throw new DealError('pick a carrier from the list');
  if (!TRACKING_RE.test(number)) throw new DealError('a tracking number is 4 to 40 letters, digits or dashes');
  const carrierName = carrier.id === 'OTHER' ? input.carrierName?.trim() : undefined;
  if (carrier.id === 'OTHER' && (!carrierName || carrierName.length < 2 || carrierName.length > 50)) throw new DealError('name the carrier');
  const captureId = deal.payment!.webhook!.captureId;

  const live = (t: Shipping['tracking']) => t?.state === 'sending' && nowMs - Date.parse(t.at) < SENDING_STALE_MS;
  const existing = deal.shipping?.tracking;
  if (live(existing)) throw new DealError('this tracking number is being sent to PayPal; reload in a moment', 409);
  if (existing?.state === 'sent' && existing.number !== number) throw new DealError('tracking is already added for this deal', 409);

  // Sent before, or an earlier answer was lost: ask PayPal before sending again.
  if (existing) {
    const fresh = await refreshPayment(dealId, { kind: 'tracking' }, deps).catch(() => undefined);
    if (fresh && trackerShown(fresh, existing.number)) {
      await setTracking(deps, dealId, (d) => ({ ...d.shipping!.tracking!, state: 'sent' }));
      if (existing.state !== 'sent') {
        await deps.store.addReceipt({ dealId, kind: 'tracking.added', at, data: { orderId: deal.order!.id, carrier: existing.carrier, number: existing.number, state: 'sent', seenOnOrder: true, via: 'apimatic-paypal-sdk', debugId: existing.debugId ?? null, unknownKind: 'recovered' } });
      }
      await syncGate(deps.store, dealId, at);
      if (existing.number !== number) throw new DealError('tracking is already added for this deal', 409);
      return (await deps.store.getDeal(dealId))!;
    }
    if (existing.state === 'sent') return (await deps.store.getDeal(dealId))!;
  }

  // The claim: a conditional write on the latest version. A concurrent caller sees it and stops.
  await updateWithRetry(deps.store, dealId, (d) => {
    if (live(d.shipping?.tracking)) throw new DealError('this tracking number is being sent to PayPal; reload in a moment', 409);
    if (d.shipping?.tracking?.state === 'sent') throw new DealError('tracking is already added for this deal', 409);
    return { ...d, shipping: { ...d.shipping, tracking: { carrier: carrier.id, carrierName, number, state: 'sending', at } } };
  });

  let outcome: Awaited<ReturnType<typeof addTrackingViaSdk>>;
  try {
    outcome = await addTrackingViaSdk(
      { orderId: deal.order!.id, captureId, sellerMerchantId: deal.payeeMerchantId!, trackingNumber: number, carrier: carrier.id, carrierNameOther: carrierName },
      // Demo deals never reach PayPal: they get the recorded replay (judge mode, M5).
      deps.sdk ?? (deal.demo ? replaySdk(deps.store, dealId) : undefined),
    );
  } catch (error) {
    // Thrown before or outside the SDK's answer (config, a bug): nothing to settle, release the claim.
    await setTracking(deps, dealId, () => undefined);
    await deps.store.addReceipt({ dealId, kind: 'tracking.failed', at, data: { orderId: deal.order!.id, status: null, reason: error instanceof Error ? error.name : 'error', debugId: null } });
    throw error;
  }

  if (!outcome.ok && (outcome.refused || !outcome.unknown)) {
    // Refused, or never sent: release the claim so a corrected attempt isn't blocked.
    await setTracking(deps, dealId, () => undefined);
    const data = outcome.refused
      ? { status: outcome.status, reason: outcome.reason ?? null, debugId: outcome.debugId ?? null }
      : { status: null, reason: outcome.kind, debugId: null };
    await deps.store.addReceipt({ dealId, kind: 'tracking.failed', at, data: { orderId: deal.order!.id, ...data } });
    if (!outcome.refused) throw new Error(`tracking not sent: ${outcome.kind}`);
    if (outcome.status === 401 || outcome.status === 403 || outcome.status === 429 || outcome.status >= 500) {
      throw new PayPalApiError(outcome.status, '/v2/checkout/orders/{id}/track', 'tracking refused', outcome.debugId);
    }
    throw new DealError(`PayPal didn't add the tracking${outcome.reason ? `: ${outcome.reason}` : ''}`, 409);
  }

  // Sent, or no answer: the fresh read decides what the record says.
  const fresh = await refreshPayment(dealId, { kind: 'tracking' }, deps).catch(() => undefined);
  const seen = !!fresh && trackerShown(fresh, number);
  const state = outcome.ok || seen ? 'sent' : 'unknown';
  await setTracking(deps, dealId, (d) => ({ ...d.shipping!.tracking!, state, ...(outcome.ok && outcome.debugId ? { debugId: outcome.debugId } : {}) }));
  await deps.store.addReceipt({
    dealId,
    kind: 'tracking.added',
    at,
    data: { orderId: deal.order!.id, carrier: carrier.id, number, state, seenOnOrder: seen, via: 'apimatic-paypal-sdk', debugId: outcome.ok ? (outcome.debugId ?? null) : null, unknownKind: outcome.ok ? null : outcome.kind },
  });
  await syncGate(deps.store, dealId, at);
  const saved = (await deps.store.getDeal(dealId))!;
  if (state === 'unknown') throw new DealError("PayPal didn't answer, and the tracking isn't on the order yet. Try again: Settle checks PayPal before sending it twice.", 409);
  return saved;
}

/** The seller records that the carrier shows the parcel delivered (proof of delivery, SP-PROOF-DELIV). */
export async function markDelivered(dealId: string, key: string | null, date: string, deps: ShippingDeps) {
  const deal = (await sellerDeal(deps.store, dealId, key)).value;
  if (!deal.shipping?.tracking || deal.shipping.tracking.state !== 'sent') throw new DealError('add tracking to PayPal first', 409);
  const at = nowOf(deps);
  // A real calendar date (2026-02-30 is refused), not before the tracking went in, and not after
  // tomorrow in UTC (sellers' local dates run up to a day ahead).
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : undefined;
  const tomorrow = new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new DealError('enter the delivery date as shown by the carrier');
  if (date > tomorrow) throw new DealError('the delivery date can\'t be in the future');
  if (date < deal.shipping.tracking.at.slice(0, 10)) throw new DealError('the delivery date is before the tracking was added');
  await updateWithRetry(deps.store, dealId, (d) => ({ ...d, shipping: { ...d.shipping, delivered: { date, at } } }));
  await deps.store.addReceipt({ dealId, kind: 'shipping.delivered', at, data: { date, by: 'seller', tracking: deal.shipping.tracking.number } });
  await syncGate(deps.store, dealId, at);
  return (await deps.store.getDeal(dealId))!;
}
