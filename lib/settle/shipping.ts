// The seller's shipping actions (PLAN M3): type the postcode from the label, and add tracking to
// the PayPal order. Each one updates the record, writes a receipt and re-runs the ship gate.

import { DealError, roleFor } from './deals';
import { normalPostcode, syncGate } from './ship-gate';
import { StaleWriteError, type DealStore } from './store';
import type { Deal } from './types';

export type ShippingDeps = { store: DealStore; now?: () => Date };
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
