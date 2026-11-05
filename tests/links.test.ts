// Claim on open (DECISIONS #22): whoever makes a deal gets both links, so each link works only on
// the first device that opens it. A second device is refused, with a message saying why.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardHash } from '../lib/settle/card';
import { claimLink, confirmCard, createDeal, OTHER_DEVICE_LINK, roleFor, withDevice, type Deps } from '../lib/settle/deals';
import { MemoryDealStore, updateWithRetry } from '../lib/settle/store';
import { askWith } from './helpers/paid-deal';

async function setup() {
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask: askWith() };
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
  const get = async () => (await store.getDeal(deal.id))!.value;
  return { store, deps, dealId: deal.id, keys, get };
}

test('the first device to open a link claims it; only that device can use it afterwards', async () => {
  const s = await setup();
  const device = await claimLink(s.dealId, s.keys.buyer, s.deps);
  assert.ok(device);
  assert.ok(!JSON.stringify(await s.get()).includes(device!), 'only the hash is stored');
  await assert.rejects(claimLink(s.dealId, s.keys.buyer, s.deps), /already opened on another device/, 'another device is refused');
  assert.equal(await claimLink(s.dealId, withDevice(s.keys.buyer, device), s.deps), undefined, 'the same device gets no new secret');

  // The link alone, e.g. the copy the deal's maker kept, no longer works.
  const d = await s.get();
  assert.throws(() => roleFor(d, s.keys.buyer), (e: Error) => e.message === OTHER_DEVICE_LINK);
  assert.throws(() => roleFor(d, withDevice(s.keys.buyer, 'another-device')), /already opened on another device/);
  assert.equal(roleFor(d, withDevice(s.keys.buyer, device)), 'buyer');
  await assert.rejects(confirmCard(s.dealId, s.keys.buyer, cardHash(await s.get()), s.deps), /already opened on another device/);

  // The other side's link is unaffected until it is opened itself.
  assert.equal(roleFor(await s.get(), s.keys.seller), 'seller');
  assert.deepEqual((await s.store.listReceipts(s.dealId)).filter((r) => r.kind === 'link.claimed').map((r) => (r.data as { role: string }).role), ['buyer']);
});

test('judge-mode deals are never claimed: one judge plays both sides in one browser', async () => {
  const s = await setup();
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, demo: { session: 'x', scenario: 'ff', seededAt: '2026-11-05T00:00:00Z' } }));
  assert.equal(await claimLink(s.dealId, s.keys.buyer, s.deps), undefined);
  assert.equal(roleFor(await s.get(), s.keys.buyer), 'buyer');
});
