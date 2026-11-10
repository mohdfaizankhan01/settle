// Scam memory (DECISIONS #20): keyed hashes only, at least two reporting deals, 90-day expiry, no
// self-reports, caution only. The model and PayPal are mocked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeal, declineDeal, type Deps, openLinks } from '../lib/settle/deals';
import { startDemo } from '../lib/settle/demo';
import { answerWarning } from '../lib/settle/feedback';
import { memorySecret, memoryHits, refreshMemory, reportOtherSide } from '../lib/settle/memory';
import { MemoryDealStore, updateWithRetry } from '../lib/settle/store';
import { dealView } from '../lib/settle/view';
import { askWith } from './helpers/paid-deal';

const SCRIPT = (buyer: string, seller: string, price: number) =>
  `${buyer}: is the camera still available?\n${seller}: yes, $${price}, posted tracked\n${buyer}: deal\n${buyer}: I've paid already, PayPal emailed you. The money is on hold until you send me the tracking number, so ship it first`;

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

let clock = new Date('2026-11-06T12:00:00Z');
const now = () => clock;

async function deal(store: MemoryDealStore, buyer = 'Sam', seller = 'Alex', price = 450, payee?: string) {
  const deps: Deps = { store, ask: askWith(['fake_payment_proof']), now };
  const { deal: d, keys: rawKeys } = await createDeal({ chat: SCRIPT(buyer, seller, price), sellerName: seller, country: 'US' }, deps);
  const keys = await openLinks(d.id, rawKeys, deps);
  if (payee) await updateWithRetry(store, d.id, (x) => ({ ...x, payeeMerchantId: payee }));
  return { id: d.id, keys, deps, get: async () => (await store.getDeal(d.id))!.value };
}

test('the same scam script, reported by two other deals, warns the next seller; one report is not enough', async () => {
  const store = new MemoryDealStore();
  const first = await deal(store, 'Sam', 'Alex', 450);
  await answerWarning(first.id, first.keys.seller, 'fake_payment_proof', 'scam', first.deps);
  const victim = await deal(store, 'Jo', 'Pat', 300);
  assert.deepEqual(await memoryHits(await victim.get(), { store, now }), [], 'one report is not enough');

  const second = await deal(store, 'Lee', 'Kim', 120);
  await answerWarning(second.id, second.keys.seller, 'fake_payment_proof', 'scam', second.deps);
  // Different names and prices, same script: matched.
  const v = await refreshMemory(await victim.get(), { store, now }, true);
  assert.equal(v.memory?.hits.length, 1);
  assert.deepEqual([v.memory!.hits[0].kind, v.memory!.hits[0].about, v.memory!.hits[0].count], ['message', 'buyer', 2]);

  // Shown to the seller (the side at risk), never to the buyer it is about.
  assert.ok(dealView(v, 'seller').warnings.some((w) => w.title === 'This message was reported before'));
  assert.ok(!dealView(v, 'buyer').warnings.some((w) => w.title.includes('reported before')));
  // Caution only: nothing about confirming changes.
  assert.deepEqual(dealView(v, 'seller').blockers, dealView({ ...v, memory: undefined }, 'seller').blockers);
});

test('only hashes are stored, never the message, names or the PayPal account', async () => {
  const store = new MemoryDealStore();
  const a = await deal(store, 'Sam', 'Alex', 450, 'PAYEE-SECRET-ID');
  await declineDeal(a.id, a.keys.buyer, 'wants_ff', a.deps).catch(() => undefined);
  await answerWarning(a.id, a.keys.seller, 'fake_payment_proof', 'scam', a.deps);
  const all = JSON.stringify(await store.findMemory('live', [], '2000-01-01'));
  const raw = JSON.stringify((store as unknown as { memory: Map<string, unknown> }).memory ? [...(store as unknown as { memory: Map<string, unknown> }).memory.values()] : []);
  for (const s of ['PAYEE-SECRET-ID', 'tracking number', 'Sam', 'Alex', 'paid already']) assert.ok(!raw.includes(s) && !all.includes(s), s);
  assert.ok(raw.includes('"hash"'));
});

test('a side cannot report itself; each deal counts once; a deal never matches its own report', async () => {
  const store = new MemoryDealStore();
  const a = await deal(store);
  // The buyer marking the warning about their own message reports nothing (it isn't shown to them anyway).
  await assert.rejects(answerWarning(a.id, a.keys.buyer, 'fake_payment_proof', 'scam', a.deps), /no such warning for you/);
  // The same deal reporting twice still counts once.
  await answerWarning(a.id, a.keys.seller, 'fake_payment_proof', 'scam', a.deps);
  await answerWarning(a.id, a.keys.seller, 'fake_payment_proof', 'scam', a.deps);
  const b = await deal(store, 'Jo', 'Pat', 99);
  assert.deepEqual(await memoryHits(await b.get(), { store, now }), []);
  assert.deepEqual(await memoryHits(await a.get(), { store, now }), [], 'its own report never counts');
});

test('reports expire after 90 days, and memory is off in production without the key', async () => {
  const store = new MemoryDealStore();
  for (const [b, s] of [['Sam', 'Alex'], ['Lee', 'Kim']]) {
    const r = await deal(store, b, s);
    await reportOtherSide(await r.get(), 'seller', 'marked_scam', { store, now }, ['fake_payment_proof']);
  }
  const v = await deal(store, 'Jo', 'Pat', 75);
  assert.equal((await memoryHits(await v.get(), { store, now })).length, 1);
  clock = new Date(clock.getTime() + 91 * 24 * 3600_000);
  assert.equal((await memoryHits(await v.get(), { store, now })).length, 0, 'forgotten after 90 days');
  clock = new Date('2026-11-06T12:00:00Z');

  assert.equal(memorySecret({ NODE_ENV: 'production' }), undefined);
  assert.equal(memorySecret({ NODE_ENV: 'production', SETTLE_MEMORY_KEY: 'short' }), undefined);
  assert.ok(memorySecret({ NODE_ENV: 'production', SETTLE_MEMORY_KEY: 'k'.repeat(32) }));
});

test('declining because they want Friends and Family reports their PayPal account', async () => {
  const store = new MemoryDealStore();
  for (const buyer of ['Sam', 'Lee']) {
    const d = await deal(store, buyer, 'Alex', 450, 'SCAMMER-PAYEE');
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
  }
  const next = await deal(store, 'Jo', 'Alex', 200, 'SCAMMER-PAYEE');
  const hits = await memoryHits(await next.get(), { store, now });
  assert.ok(hits.some((h) => h.kind === 'payee' && h.about === 'seller' && h.count === 2));
  // "The terms are wrong" isn't a scam report.
  const store2 = new MemoryDealStore();
  for (const buyer of ['Sam', 'Lee']) {
    const d = await deal(store2, buyer, 'Alex', 450, 'HONEST-PAYEE');
    await declineDeal(d.id, d.keys.buyer, 'terms_wrong', d.deps);
  }
  const ok = await deal(store2, 'Jo', 'Alex', 200, 'HONEST-PAYEE');
  assert.deepEqual(await memoryHits(await ok.get(), { store: store2, now }), []);
});

test('judge mode: the fake-email deal matches two seeded reports in its own session only', async () => {
  const store = new MemoryDealStore();
  const a = await startDemo(store, now);
  const fake = (await store.getDeal(a.deals.find((d) => d.scenario === 'fake-email')!.dealId))!.value;
  assert.equal(fake.memory?.hits[0]?.count, 2);
  assert.match(dealView(fake, 'seller').warnings.find((w) => w.title === 'This message was reported before')!.means, /seeded demo data/);
  // A real deal with the same script sees nothing from a judge session.
  const real = await deal(store);
  assert.deepEqual(await memoryHits(await real.get(), { store, now }), []);
});
