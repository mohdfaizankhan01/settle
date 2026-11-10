// Claim on open (DECISIONS #22): whoever makes a deal gets both links, so each link works only on
// the first device that opens it. A second device is refused, with a message saying why.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardHash } from '../lib/settle/card';
import { answerQuestion, claimLink, confirmCard, createDeal, declineDeal, openLinks, OTHER_DEVICE_LINK, roleFor, UNCLAIMED_LINK, withDevice, type Deps } from '../lib/settle/deals';
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

test('a link must be opened on a device before it can act: the maker cannot confirm or answer as the other side', async () => {
  const s = await setup();
  const deal = await s.get();
  // The maker holds both raw links. Acting with the other side's unopened link is refused...
  await assert.rejects(confirmCard(s.dealId, s.keys.buyer, cardHash(deal), s.deps), (e: Error) => e.message === UNCLAIMED_LINK);
  await assert.rejects(answerQuestion(s.dealId, s.keys.buyer, 'q_fee', 'seller', s.deps), (e: Error) => e.message === UNCLAIMED_LINK);
  await assert.rejects(declineDeal(s.dealId, s.keys.buyer, 'terms_wrong', s.deps), (e: Error) => e.message === UNCLAIMED_LINK);
  assert.deepEqual((await s.get()).confirmations, []);
  assert.equal((await s.store.listReceipts(s.dealId)).some((r) => r.kind === 'card.confirmed' || r.kind === 'question.answered'), false);
  // ...so the real buyer's first open still claims a link nobody has used.
  const device = await claimLink(s.dealId, s.keys.buyer, s.deps);
  assert.ok(device);
  await answerQuestion(s.dealId, withDevice(s.keys.buyer, device), 'q_fee', 'seller', s.deps);
});

test('the attack lab and tests play both people by opening both links first', async () => {
  const s = await setup();
  const keys = await openLinks(s.dealId, s.keys, s.deps);
  await answerQuestion(s.dealId, keys.seller, 'q_fee', 'seller', s.deps);
  await answerQuestion(s.dealId, keys.buyer, 'q_fee', 'seller', s.deps);
  assert.ok((await s.get()).claims?.seller && (await s.get()).claims?.buyer);
});
