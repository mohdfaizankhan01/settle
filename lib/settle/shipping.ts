// The seller's shipping actions (PLAN M3): type the postcode from the label, and add tracking to
// the PayPal order. Each one updates the record, writes a receipt and re-runs the ship gate.

import type { PaypalClient } from 'paypal';
import { PayPalApiError } from '../paypal';
import { addTrackingViaSdk } from '../paypal-sdk';
import { CARRIERS } from './carriers';
import { DealError, roleFor } from './deals';
import { refreshPayment, type PaymentPayPal } from './payment';
import { isPaid, normalPostcode, syncGate } from './ship-gate';
import { StaleWriteError, type DealStore } from './store';
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
  for (let attempt = 0; ; attempt++) {
    const stored = await sellerDeal(deps.store, dealId, key);
    if (!POSTCODE[stored.value.country].test(value)) {
      throw new DealError(stored.value.country === 'US' ? 'enter a ZIP code like 94107' : 'enter a postcode like LS1 1AA');
    }
    const at = nowOf(deps);
    const next: Deal = { ...stored.value, shipping: { ...stored.value.shipping, labelPostcode: { value, at } } };
    try {
      await deps.store.updateDeal(dealId, stored.version, next);
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
      continue;
    }
    const read = next.payment?.read;
    const paypal = read?.ok ? read.shipTo?.postalCode : undefined;
    await deps.store.addReceipt({
      dealId,
      kind: 'shipping.label_postcode',
      at,
      // The postcode is compared, not kept in the receipt: receipts hold decisions, not addresses.
      data: { matchesPayPal: paypal ? normalPostcode(paypal, next.country) === normalPostcode(value, next.country) : null },
    });
    await syncGate(deps.store, dealId, at);
    return (await deps.store.getDeal(dealId))!;
  }
}

const TRACKING_RE = /^[A-Za-z0-9-]{4,40}$/;

export type TrackingRequest = { carrier: string; number: string; carrierName?: string };

const trackerOnOrder = (deal: Deal, number: string) => {
  const read = deal.payment?.read;
  return !!read?.ok && !!read.captureId && (read.trackers ?? []).includes(`${read.captureId}-${number}`);
};

async function writeTracking(deps: ShippingDeps, dealId: string, change: (deal: Deal) => Shipping['tracking']) {
  for (let attempt = 0; ; attempt++) {
    const stored = (await deps.store.getDeal(dealId))!;
    try {
      return await deps.store.updateDeal(dealId, stored.version, { ...stored.value, shipping: { ...stored.value.shipping, tracking: change(stored.value) } });
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
    }
  }
}

/**
 * Adds tracking to the PayPal order through the SDK, then re-reads the order: the tracking check
 * passes only when PayPal shows the tracker. Order: validate → claim on the deal → SDK call →
 * record. A lost answer is "unknown", never "failed": the order is re-read to settle it.
 */
export async function addTracking(dealId: string, key: string | null, input: TrackingRequest, deps: ShippingDeps) {
  const number = input.number.trim().toUpperCase().replace(/\s+/g, '');
  const stored = await sellerDeal(deps.store, dealId, key);
  const deal = stored.value;
  // Invariants, checked before any claim: this deal's order, its confirmed capture, its seller.
  if (!isPaid(deal)) throw new DealError('tracking can be added once PayPal has confirmed the payment', 409);
  const carrier = CARRIERS[deal.country].find((c) => c.id === input.carrier);
  if (!carrier) throw new DealError('pick a carrier from the list');
  if (!TRACKING_RE.test(number)) throw new DealError('a tracking number is 4 to 40 letters, digits or dashes');
  const carrierName = carrier.id === 'OTHER' ? input.carrierName?.trim() : undefined;
  if (carrier.id === 'OTHER' && (!carrierName || carrierName.length < 2 || carrierName.length > 50)) throw new DealError('name the carrier');

  const existing = deal.shipping?.tracking;
  if (existing && existing.number !== number && existing.state !== 'unknown') throw new DealError('tracking is already added for this deal', 409);
  if (existing?.state === 'sending') throw new DealError('this tracking number is being sent to PayPal; reload in a moment', 409);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const captureId = deal.payment!.webhook!.captureId;

  // Already sent, or a lost answer earlier: ask PayPal before sending again.
  if (existing && existing.number === number) {
    const fresh = await refreshPayment(dealId, { kind: 'tracking' }, deps).catch(() => undefined);
    if (fresh && trackerOnOrder(fresh, number)) {
      await writeTracking(deps, dealId, (d) => ({ ...d.shipping!.tracking!, state: 'sent' }));
      await syncGate(deps.store, dealId, at);
      return (await deps.store.getDeal(dealId))!;
    }
    if (existing.state === 'sent') return (await deps.store.getDeal(dealId))!;
  }

  // The claim: a conditional write on the version this request read. A second caller loses here.
  try {
    await deps.store.updateDeal(dealId, stored.version, {
      ...deal,
      shipping: { ...deal.shipping, tracking: { carrier: carrier.id, carrierName, number, state: 'sending', at } },
    });
  } catch (error) {
    if (error instanceof StaleWriteError) throw new DealError('the deal changed while adding tracking; reload and try again', 409);
    throw error;
  }

  const outcome = await addTrackingViaSdk(
    { orderId: deal.order!.id, captureId, sellerMerchantId: deal.payeeMerchantId!, trackingNumber: number, carrier: carrier.id, carrierNameOther: carrierName },
    deps.sdk,
  );

  if (!outcome.ok && (outcome.refused || !outcome.unknown)) {
    // Refused, or never sent: release the claim so a corrected attempt isn't blocked.
    await writeTracking(deps, dealId, () => undefined);
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
  const seen = !!fresh && trackerOnOrder(fresh, number);
  const state = outcome.ok || seen ? 'sent' : 'unknown';
  await writeTracking(deps, dealId, (d) => ({ ...d.shipping!.tracking!, state, ...(outcome.ok && outcome.debugId ? { debugId: outcome.debugId } : {}) }));
  await deps.store.addReceipt({
    dealId,
    kind: 'tracking.added',
    at,
    data: { orderId: deal.order!.id, carrier: carrier.id, number, state, seenOnOrder: seen, via: 'paypal-server-sdk', debugId: outcome.ok ? (outcome.debugId ?? null) : null, unknownKind: outcome.ok ? null : outcome.kind },
  });
  await syncGate(deps.store, dealId, at);
  const saved = (await deps.store.getDeal(dealId))!;
  if (state === 'unknown') throw new DealError("PayPal didn't answer, and the tracking isn't on the order yet. Try again: Settle checks PayPal before sending it twice.", 409);
  return saved;
}
