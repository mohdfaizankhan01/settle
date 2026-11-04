import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDemo } from '../lib/settle/demo';
import { describe, history } from '../lib/settle/history';
import { MemoryDealStore } from '../lib/settle/store';

// The history turns receipts into plain sentences; every kind Settle writes has one.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

test('every receipt the demo writes reads as a sentence; the chain verifies; tampering shows', async () => {
  const store = new MemoryDealStore();
  const s = await startDemo(store);
  const dispute = s.deals.find((d) => d.scenario === 'dispute')!;
  const receipts = await store.listReceipts(dispute.dealId);
  for (const r of receipts) assert.notEqual(describe(r), r.kind, `no sentence for ${r.kind}`);
  const seller = history(receipts, 'seller');
  assert.equal(seller.chain.ok, true);
  assert.ok(seller.items.some((i) => i.text.startsWith('Payment confirmed') && i.replayed));
  const buyer = history(receipts, 'buyer');
  assert.ok(buyer.items.length < seller.items.length, 'seller-only steps are left out for the buyer');
  assert.ok(!buyer.items.some((i) => i.text.includes('label postcode')));
  assert.ok(!buyer.items.some((i) => i.text.startsWith('Ship check')), "the seller's ship check is not the buyer's");
  assert.ok(!buyer.items.some((i) => /RRBVDNUTQMAXN|\d+ warnings?/.test(i.text)), 'no merchant ID or warning counts for the buyer');
  const tampered = receipts.map((r, i) => (i === 2 ? { ...r, data: { ...r.data, by: 'someone' } } : r));
  assert.deepEqual(history(tampered, 'seller').chain, { ok: false, brokenAt: 2, reason: 'receipt was changed' });
});
