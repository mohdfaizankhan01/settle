import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, hashJson } from '../lib/settle/canonical';
import { GENESIS_HASH, makeReceipt, verifyChain, type Receipt } from '../lib/settle/receipts';

const chain = (): Receipt[] => {
  const a = makeReceipt(undefined, { dealId: 'd1', kind: 'deal.checked', at: '2026-10-22T10:00:00Z', data: { warnings: 1 } });
  const b = makeReceipt(a, { dealId: 'd1', kind: 'card.confirmed', at: '2026-10-22T10:01:00Z', data: { by: 'buyer' } });
  const c = makeReceipt(b, { dealId: 'd1', kind: 'card.confirmed', at: '2026-10-22T10:02:00Z', data: { by: 'seller' } });
  return [a, b, c];
};

test('canonical JSON sorts keys at every level and refuses lossy values', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(Number.NaN));
});

test('a fresh chain verifies and links each receipt to the previous one', () => {
  const receipts = chain();
  assert.equal(receipts[0].prevHash, GENESIS_HASH);
  assert.equal(receipts[2].prevHash, receipts[1].hash);
  assert.deepEqual(verifyChain(receipts), { ok: true, count: 3 });
  assert.deepEqual(verifyChain([]), { ok: true, count: 0 });
});

test('editing, removing or reordering a receipt breaks the chain', () => {
  const edited = chain();
  edited[1] = { ...edited[1], data: { by: 'seller' } };
  assert.equal(verifyChain(edited).ok, false);

  const removed = chain();
  removed.splice(1, 1);
  assert.equal(verifyChain(removed).ok, false);

  const [a, b, c] = chain();
  assert.equal(verifyChain([a, c, b]).ok, false);

  const rehashedButUnlinked = chain();
  rehashedButUnlinked[1] = makeReceipt(rehashedButUnlinked[0], { ...rehashedButUnlinked[1], data: { by: 'seller' } });
  assert.deepEqual(verifyChain(rehashedButUnlinked), { ok: false, brokenAt: 2, reason: 'previous hash does not match' });
});

test('a chain cannot continue across deals', () => {
  const [a] = chain();
  assert.throws(() => makeReceipt(a, { dealId: 'd2', kind: 'x', at: '2026-10-22T10:00:00Z', data: {} }));
});
