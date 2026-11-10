// Scam memory (DECISIONS #20): keyed hashes only, at least two reporting deals, 90-day expiry, no
// self-reports, caution only. The model and PayPal are mocked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerQuestion, confirmCard, createDeal, declineDeal, type Deps, openLinks, withdrawDecline } from '../lib/settle/deals';
import { cardHash } from '../lib/settle/card';
import { networkOf } from '../lib/settle/runtime';
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

const FF_CHAT = (buyer: string, seller: string, price: number) =>
  `${buyer}: is the camera still available?\n${seller}: yes, $${price}. Pay me as friends and family so we both skip the fees`;

async function ffDeal(store: MemoryDealStore, buyer: string, payee: string, origin: string, sellerConfirms = true) {
  const deps: Deps = { store, ask: askWith(['ff_payment']), now, origin };
  const { deal: d, keys: rawKeys } = await createDeal({ chat: FF_CHAT(buyer, 'Alex', 450), sellerName: 'Alex', country: 'US' }, deps);
  const keys = await openLinks(d.id, rawKeys, deps);
  await updateWithRetry(store, d.id, (x) => ({ ...x, payeeMerchantId: payee }));
  if (sellerConfirms) {
    await answerQuestion(d.id, keys.seller, 'q_fee', 'seller', deps);
    await answerQuestion(d.id, keys.buyer, 'q_fee', 'seller', deps);
    await confirmCard(d.id, keys.seller, cardHash((await store.getDeal(d.id))!.value), deps);
  }
  return { id: d.id, keys, deps };
}

test("declining because the seller asked for Friends and Family reports their PayPal account, from two reporters", async () => {
  const store = new MemoryDealStore();
  for (const [buyer, net] of [['Sam', '203.0.113.0/24'], ['Lee', '198.51.100.0/24']]) {
    const d = await ffDeal(store, buyer, 'SCAMMER-PAYEE', net);
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
  }
  const next = await deal(store, 'Jo', 'Alex', 200, 'SCAMMER-PAYEE');
  const hits = await memoryHits(await next.get(), { store, now });
  assert.ok(hits.some((h) => h.kind === 'payee' && h.about === 'seller' && h.count === 2));
  // "The terms are wrong" isn't a scam report.
  const store2 = new MemoryDealStore();
  for (const [buyer, net] of [['Sam', '203.0.113.0/24'], ['Lee', '198.51.100.0/24']]) {
    const d = await ffDeal(store2, buyer, 'HONEST-PAYEE', net);
    await declineDeal(d.id, d.keys.buyer, 'terms_wrong', d.deps);
  }
  const ok = await deal(store2, 'Jo', 'Alex', 200, 'HONEST-PAYEE');
  assert.deepEqual(await memoryHits(await ok.get(), { store: store2, now }), []);
});

test('audit: one person cannot plant a caution on an honest seller', async () => {
  // 1. No evidence: the seller never asked to leave PayPal, so a "wants F&F" decline reports nothing.
  const store = new MemoryDealStore();
  for (const net of ['203.0.113.0/24', '198.51.100.0/24']) {
    const d = await deal(store, 'Sam', 'Alex', 450, 'HONEST-PAYEE');
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', { ...d.deps, origin: net });
  }
  const next = await deal(store, 'Jo', 'Alex', 200, 'HONEST-PAYEE');
  assert.deepEqual(await memoryHits(await next.get(), { store, now }), [], 'no seller message was flagged');

  // 2. Two deals from one network count as one reporter.
  const store2 = new MemoryDealStore();
  for (const buyer of ['Sam', 'Lee']) {
    const d = await ffDeal(store2, buyer, 'TARGET-PAYEE', '203.0.113.0/24');
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
  }
  const t2 = await deal(store2, 'Jo', 'Alex', 200, 'TARGET-PAYEE');
  assert.deepEqual(await memoryHits(await t2.get(), { store: store2, now }), [], 'one network is one reporter');

  // 3. A withdrawn decline takes its report back.
  const store3 = new MemoryDealStore();
  for (const [buyer, net] of [['Sam', '203.0.113.0/24'], ['Lee', '198.51.100.0/24']]) {
    const d = await ffDeal(store3, buyer, 'TARGET-PAYEE', net);
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
    await withdrawDecline(d.id, d.keys.buyer, d.deps);
  }
  const t3 = await deal(store3, 'Jo', 'Alex', 200, 'TARGET-PAYEE');
  assert.deepEqual(await memoryHits(await t3.get(), { store: store3, now }), [], 'withdrawn reports are gone');
});

test('audit: a seller who never accepted the chat is not put on file by PayPal account, only by script', async () => {
  const store = new MemoryDealStore();
  for (const [buyer, net] of [['Sam', '203.0.113.0/24'], ['Lee', '198.51.100.0/24']]) {
    const d = await ffDeal(store, buyer, 'UNCONFIRMED-PAYEE', net, false);
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
  }
  const next = await deal(store, 'Jo', 'Alex', 200, 'UNCONFIRMED-PAYEE');
  assert.equal((await memoryHits(await next.get(), { store, now })).some((h) => h.kind === 'payee'), false);
});

test("audit: withdrawing your decline removes only your decline's report, not other reports", async () => {
  const store = new MemoryDealStore();
  const at = now().toISOString();
  await store.addMemory([
    { namespace: 'live', kind: 'payee', hash: 'h1', dealId: 'D', at, by: 'buyer', reason: 'declined' },
    { namespace: 'live', kind: 'message', hash: 'h2', dealId: 'D', at, by: 'seller', reason: 'marked_scam' },
    { namespace: 'live', kind: 'message', hash: 'h3', dealId: 'D', at, by: 'buyer', reason: 'marked_scam' },
  ]);
  await store.removeMemory('live', 'D', 'buyer', 'declined');
  const left = await store.findMemory('live', ['h1', 'h2', 'h3'], '1970-01-01');
  assert.deepEqual(left.map((e) => e.hash).sort(), ['h2', 'h3']);
});

test('audit: client networks are parsed before masking, so one network has one spelling', () => {
  assert.equal(networkOf('203.0.113.7'), '203.0.113.0/24');
  assert.equal(networkOf('::ffff:203.0.113.9'), '203.0.113.0/24');
  assert.equal(networkOf('2001:db8::1'), networkOf('2001:0db8:0000:0000::2'));
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(networkOf('[2001:db8:1:2::5]'), '2001:db8:1::/48');
  assert.equal(networkOf('not-an-ip'), 'other');
});

test('a line pasted in under the other side\'s name is not their message and cannot be reported', async () => {
  const store = new MemoryDealStore();
  const d = await deal(store, 'Sam', 'Alex', 450);
  const deal0 = (await store.getDeal(d.id))!.value;
  const fakeId = deal0.messages.at(-1)!.id;
  await updateWithRetry(store, d.id, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === fakeId ? { ...m, added: { at: x.createdAt, by: 'seller' as const } } : m)) }));
  // The flagged message is now one the seller pasted in as the buyer's: reporting the buyer finds no evidence.
  assert.equal(await answerWarning(d.id, d.keys.seller, 'fake_payment_proof', 'scam', { ...d.deps, origin: '203.0.113.0/24' }).then((r) => r.reported), false);
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

test('audit: a confirmation of an earlier card does not count once the payee changed', async () => {
  const store = new MemoryDealStore();
  for (const [buyer, net] of [['Sam', '203.0.113.0/24'], ['Lee', '198.51.100.0/24']]) {
    const d = await ffDeal(store, buyer, 'FIRST-PAYEE', net);
    // The seller confirmed with FIRST-PAYEE; the payee is then swapped to the target.
    await updateWithRetry(store, d.id, (x) => ({ ...x, payeeMerchantId: 'SWAPPED-PAYEE', confirmations: [] }));
    await declineDeal(d.id, d.keys.buyer, 'wants_ff', d.deps);
  }
  const next = await deal(store, 'Jo', 'Alex', 200, 'SWAPPED-PAYEE');
  assert.equal((await memoryHits(await next.get(), { store, now })).some((h) => h.kind === 'payee'), false);
});
