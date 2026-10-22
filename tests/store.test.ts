import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyChain } from '../lib/settle/receipts';
import { MemoryDealStore, StaleWriteError } from '../lib/settle/store';
import type { Deal } from '../lib/settle/types';

const deal = (): Deal => ({
  id: 'd1',
  createdAt: '2026-10-22T10:00:00Z',
  country: 'UK',
  messages: [],
  tokens: [],
  check: { status: 'ran', at: '2026-10-22T10:00:00Z' },
  warnings: [],
  card: {},
  questions: [],
  cardVersion: 1,
  confirmations: [],
  keyHashes: { seller: 'a', buyer: 'b' },
});

test('a write based on a stale version fails', async () => {
  const store = new MemoryDealStore();
  await store.createDeal(deal());
  const read = (await store.getDeal('d1'))!;
  await store.updateDeal('d1', read.version, { ...read.value, cardVersion: 2 });
  await assert.rejects(store.updateDeal('d1', read.version, { ...read.value, cardVersion: 3 }), StaleWriteError);
  assert.equal((await store.getDeal('d1'))!.value.cardVersion, 2);
});

test('returned deals are copies, so callers cannot change stored state', async () => {
  const store = new MemoryDealStore();
  await store.createDeal(deal());
  (await store.getDeal('d1'))!.value.confirmations.push({ role: 'buyer', at: 'x', cardHash: 'y' });
  assert.equal((await store.getDeal('d1'))!.value.confirmations.length, 0);
});

test('receipts chain per deal', async () => {
  const store = new MemoryDealStore();
  for (const kind of ['a', 'b', 'c']) await store.addReceipt({ dealId: 'd1', kind, at: '2026-10-22T10:00:00Z', data: {} });
  await store.addReceipt({ dealId: 'd2', kind: 'a', at: '2026-10-22T10:00:00Z', data: {} });
  const receipts = await store.listReceipts('d1');
  assert.deepEqual(receipts.map((r) => r.seq), [0, 1, 2]);
  assert.deepEqual(verifyChain(receipts), { ok: true, count: 3 });
});
