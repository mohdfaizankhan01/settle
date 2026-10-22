// Every decision writes a receipt (CLAUDE.md). Receipts form a hash chain per deal: each one
// stores the hash of the one before, so editing, removing or reordering any receipt breaks
// verifyChain. Receipts hold decisions, IDs, hashes and probabilities, never chat text.

import { canonicalJson, sha256Hex, type Json } from './canonical';

export const GENESIS_HASH = '0'.repeat(64);

export type ReceiptInput = {
  dealId: string;
  /** What was decided, e.g. 'deal.checked', 'card.confirmed', 'order.created'. */
  kind: string;
  /** ISO timestamp. */
  at: string;
  data: { [key: string]: Json };
};

export type Receipt = ReceiptInput & { seq: number; prevHash: string; hash: string };

const hashOf = (r: Omit<Receipt, 'hash'>) =>
  sha256Hex(canonicalJson({ seq: r.seq, dealId: r.dealId, kind: r.kind, at: r.at, data: r.data, prevHash: r.prevHash }));

export function makeReceipt(prev: Receipt | undefined, input: ReceiptInput): Receipt {
  if (prev && prev.dealId !== input.dealId) throw new Error('receipt chain belongs to another deal');
  const body = { ...input, seq: prev ? prev.seq + 1 : 0, prevHash: prev ? prev.hash : GENESIS_HASH };
  return { ...body, hash: hashOf(body) };
}

export type ChainCheck = { ok: true; count: number } | { ok: false; brokenAt: number; reason: string };

export function verifyChain(receipts: readonly Receipt[]): ChainCheck {
  let prevHash = GENESIS_HASH;
  for (const [i, r] of receipts.entries()) {
    if (r.seq !== i) return { ok: false, brokenAt: i, reason: 'sequence gap or reorder' };
    if (r.dealId !== receipts[0].dealId) return { ok: false, brokenAt: i, reason: 'mixed deals' };
    if (r.prevHash !== prevHash) return { ok: false, brokenAt: i, reason: 'previous hash does not match' };
    if (hashOf(r) !== r.hash) return { ok: false, brokenAt: i, reason: 'receipt was changed' };
    prevHash = r.hash;
  }
  return { ok: true, count: receipts.length };
}
