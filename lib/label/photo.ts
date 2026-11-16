// The seller's "read it from a photo" action (Part B, label photo). Only the seller, only once the
// buyer has paid (the same gate as typing the postcode). The photo is read and discarded: it is
// never stored, and the receipt holds only what the reader decided, never the image, the
// postcode or any address. The result pre-fills the box the seller types the postcode into; the
// seller confirms it, and the typed path compares it with PayPal's address.

import recorded from '../../data/demo/label-recorded.json';
import { DealError } from '../settle/deals';
import { sellerDeal } from '../settle/shipping';
import type { DealStore } from '../settle/store';
import { readLabel, type LabelDeps, type LabelRead } from './read-label';

export type PhotoDeps = { store: DealStore; now?: () => Date } & LabelDeps;

/** What the page is told. Never the address block the model quoted. */
export type PhotoResult =
  | { status: 'read'; postcode: string; recorded?: { at: string; model: string } }
  | { status: 'unreadable' | 'skipped'; reason: string };

/** The judge-mode sample's real reading, made by npm run label:eval and replayed. */
export const SAMPLE_READING = recorded as { postcode: string; model: string; recordedAt: string; sha256: string };

/**
 * Reads a label photo for the seller. `photo` is the uploaded image; `sample` asks for the
 * judge-mode sample label instead, whose recorded reading is replayed (judge mode only).
 */
export async function readLabelPhoto(dealId: string, key: string | null, photo: Uint8Array | 'sample', deps: PhotoDeps): Promise<PhotoResult> {
  const stored = await sellerDeal(deps.store, dealId, key);
  const deal = stored.value;
  if (photo === 'sample' && !deal.demo) throw new DealError('the sample label is for judge mode only', 400);
  // Judge mode never calls the provider: the sample's recorded reading is replayed, and an
  // uploaded photo is not sent anywhere.
  const reading: LabelRead =
    photo === 'sample'
      ? { status: 'read', postcode: SAMPLE_READING.postcode, model: SAMPLE_READING.model }
      : deal.demo
        ? { status: 'skipped', reason: 'Judge mode reads only the sample label, so nothing is sent; type the postcode instead' }
        : await readLabel(photo, deal.country, { ask: deps.ask, model: deps.model });
  await deps.store.addReceipt({
    dealId,
    kind: 'shipping.label_photo',
    at: (deps.now ?? (() => new Date()))().toISOString(),
    data: { result: reading.status, source: photo === 'sample' ? 'recorded' : 'live', model: reading.status === 'read' ? reading.model : null, reason: reading.status === 'read' ? null : reading.reason },
  });
  if (reading.status !== 'read') return { status: reading.status, reason: reading.reason };
  return photo === 'sample' ? { status: 'read', postcode: reading.postcode, recorded: { at: SAMPLE_READING.recordedAt, model: SAMPLE_READING.model } } : { status: 'read', postcode: reading.postcode };
}
