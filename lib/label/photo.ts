// The seller's "read it from a photo" action (Part B, label photo). Only the seller, only once the
// buyer has paid (the same gate as typing the postcode). The photo is read and discarded: it is
// never stored, and the receipt holds only what the reader decided, never the image, the
// postcode or any address. The result pre-fills the box the seller types the postcode into; the
// seller confirms it, and the typed path compares it with PayPal's address.

import { sellerDeal } from '../settle/shipping';
import type { DealStore } from '../settle/store';
import { readLabel, type LabelDeps, type LabelRead } from './read-label';

export type PhotoDeps = { store: DealStore; now?: () => Date } & LabelDeps;

/** What the page is told. Never the address block the model quoted. */
export type PhotoResult = { status: 'read'; postcode: string } | { status: 'unreadable' | 'skipped'; reason: string };

export async function readLabelPhoto(dealId: string, key: string | null, photo: Uint8Array, deps: PhotoDeps): Promise<PhotoResult> {
  const stored = await sellerDeal(deps.store, dealId, key);
  const deal = stored.value;
  // Judge mode never calls the provider: its deals are replayed, and nothing leaves the server.
  const reading: LabelRead = deal.demo
    ? { status: 'skipped', reason: 'Judge mode does not read photos; type the postcode instead' }
    : await readLabel(photo, deal.country, { ask: deps.ask, model: deps.model });
  await deps.store.addReceipt({
    dealId,
    kind: 'shipping.label_photo',
    at: (deps.now ?? (() => new Date()))().toISOString(),
    data: { result: reading.status, model: reading.status === 'read' ? reading.model : null, reason: reading.status === 'read' ? null : reading.reason },
  });
  return reading.status === 'read' ? { status: 'read', postcode: reading.postcode } : { status: reading.status, reason: reading.reason };
}
