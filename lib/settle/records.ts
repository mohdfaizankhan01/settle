// Exporting a deal's signed record (Part B, /verify). Only the seller can: the receipts include
// seller-only steps (ship checks, warning counts). Read-only, like the evidence pack download: it
// writes no receipt, because the evidence PDF lists the receipts and a new one would change the
// PDF whose hash the record carries. Judge-mode deals are signed with the public demo key.

import { actingRole, DealError } from './deals';
import { cardHash } from './card';
import { evidencePdf } from './evidence-pdf';
import { pdfSha256, signingKeyFor, signRecord, type SignedRecord } from './signing';
import type { DealStore } from './store';

export type RecordDeps = { store: DealStore; now?: () => Date; env?: Parameters<typeof signingKeyFor>[1] };

export async function exportRecord(dealId: string, key: string | null, deps: RecordDeps, disputeId?: string): Promise<SignedRecord> {
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (actingRole(stored.value, key) !== 'seller') throw new DealError('only the seller can export the signed record', 403);
  const deal = stored.value;
  const signer = signingKeyFor(!!deal.demo, deps.env);
  if (!signer) throw new DealError('signing is off on this server, so there is no signed record for this deal', 503);
  const receipts = await deps.store.listReceipts(dealId);
  let pdf: { disputeId: string; sha256: string } | undefined;
  if (disputeId) {
    const dispute = deal.disputes?.find((d) => d.id === disputeId);
    if (!dispute) throw new DealError('no such dispute on this deal', 404);
    pdf = { disputeId, sha256: pdfSha256(await evidencePdf(deal, dispute, receipts)) };
  }
  return signRecord({ dealId, demo: !!deal.demo, cardHash: cardHash(deal), receipts, pdf, now: deps.now }, signer);
}
