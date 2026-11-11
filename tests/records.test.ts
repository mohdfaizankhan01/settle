import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { claimLink, DealError, withDevice } from '../lib/settle/deals';
import { startDemo } from '../lib/settle/demo';
import { evidencePack } from '../lib/settle/dispute-submit';
import { exportRecord } from '../lib/settle/records';
import { encodeSeed, liveSigningKey, pdfSha256, publishedKeys, verifyRecord } from '../lib/settle/signing';
import { MemoryDealStore } from '../lib/settle/store';

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

async function demo() {
  const store = new MemoryDealStore();
  const s = await startDemo(store);
  const dispute = s.deals.find((d) => d.scenario === 'dispute')!;
  return { store, s, dispute, seller: dispute.keys.seller, buyer: dispute.keys.buyer };
}
const rejects = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (e) => e instanceof DealError && e.status === status);
};

test('the seller exports a signed record of a judge-mode deal; it verifies and says it is demo data', async () => {
  const { store, dispute, seller } = await demo();
  const record = await exportRecord(dispute.dealId, seller, { store });
  const out = verifyRecord(JSON.parse(JSON.stringify(record)), publishedKeys({}));
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'demo');
  assert.equal(record.body.demo, true);
  assert.equal(record.body.dealId, dispute.dealId);
  const receipts = await store.listReceipts(dispute.dealId);
  assert.equal(record.body.receiptCount, receipts.length);
  assert.equal(record.body.chainHead, receipts.at(-1)!.hash);
  assert.equal(record.body.pdf, null);
});

test('a record that covers a dispute carries the hash of the evidence pack the seller can download', async () => {
  const { store, dispute, seller } = await demo();
  const deal = (await store.getDeal(dispute.dealId))!.value;
  const id = deal.disputes![0].id;
  const record = await exportRecord(dispute.dealId, seller, { store }, id);
  const pack = await evidencePack(dispute.dealId, seller, id, { store });
  assert.equal(record.body.pdf!.disputeId, id);
  assert.equal(record.body.pdf!.sha256, pdfSha256(pack));
  assert.equal(verifyRecord(record, publishedKeys({})).ok, true);
  await rejects(exportRecord(dispute.dealId, seller, { store }, 'PP-D-NOPE'), 404);
});

test('the export writes no receipt, so the record and the evidence pack describe the same chain', async () => {
  const { store, dispute, seller } = await demo();
  const before = (await store.listReceipts(dispute.dealId)).length;
  await exportRecord(dispute.dealId, seller, { store });
  await exportRecord(dispute.dealId, seller, { store });
  assert.equal((await store.listReceipts(dispute.dealId)).length, before);
});

test('only the seller can export: the buyer, a wrong key, no key and an unknown deal are refused', async () => {
  const { store, dispute, buyer } = await demo();
  await rejects(exportRecord(dispute.dealId, buyer, { store }), 403);
  await rejects(exportRecord(dispute.dealId, 'not-a-key', { store }), 403);
  await rejects(exportRecord(dispute.dealId, null, { store }), 403);
  await rejects(exportRecord('nope', 'x', { store }), 404);
});

test('a live deal is signed with the live key; without one in production there is no record', async () => {
  const { store, dispute, seller } = await demo();
  const stored = (await store.getDeal(dispute.dealId))!;
  await store.updateDeal(dispute.dealId, stored.version, { ...stored.value, demo: undefined });
  // A live deal's link needs its device secret, as in a browser: before the link is claimed it is refused.
  await rejects(exportRecord(dispute.dealId, seller, { store }), 409);
  const device = (await claimLink(dispute.dealId, seller, { store }))!;
  const sellerOnDevice = withDevice(seller, device);

  await rejects(exportRecord(dispute.dealId, sellerOnDevice, { store, env: { NODE_ENV: 'production' } }), 503);

  const env = { NODE_ENV: 'production', SETTLE_SIGNING_KEY: encodeSeed(randomBytes(32)) };
  const record = await exportRecord(dispute.dealId, sellerOnDevice, { store, env });
  assert.equal(record.body.demo, false);
  assert.equal(record.signature.kind, 'live');
  const live = liveSigningKey(env)!;
  assert.equal(verifyRecord(record, [live.info]).ok, true);
  assert.equal(verifyRecord(record, publishedKeys({})).ok, false, 'not valid against the demo key alone');
});

test('a judge-mode deal is never signed with the live key', async () => {
  const { store, dispute, seller } = await demo();
  const env = { NODE_ENV: 'production', SETTLE_SIGNING_KEY: encodeSeed(randomBytes(32)) };
  const record = await exportRecord(dispute.dealId, seller, { store, env });
  assert.equal(record.signature.kind, 'demo');
});
