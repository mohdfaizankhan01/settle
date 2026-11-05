import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startCheckout } from '../lib/settle/checkout';
import { startConnect } from '../lib/settle/connect';
import { createDeal } from '../lib/settle/deals';
import { demoView, startDemo, SCENARIOS } from '../lib/settle/demo';
import { previewSubmission, submitApproved } from '../lib/settle/dispute-submit';
import { maybeRefreshOnLoad } from '../lib/settle/payment';
import { shipGate } from '../lib/settle/ship-gate';
import type { CheckEngine } from '../lib/model/engine';
import { MemoryDealStore } from '../lib/settle/store';
import { askWith } from './helpers/paid-deal';

// Judge mode runs Settle's real code with PayPal replaced by the recorded run. Global fetch is
// replaced so any attempt to reach the network fails the test.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';
const realFetch = globalThis.fetch;
const reached: string[] = [];
before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reached.push(String(input instanceof Request ? input.url : input));
    throw new Error('network is off in this test');
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

let clock = new Date('2026-11-04T10:00:00Z');
const now = () => clock;

test('a judge session seeds one deal per state through the real code, with no network call', async () => {
  const store = new MemoryDealStore();
  const s = await startDemo(store, now);
  assert.deepEqual(s.deals.map((d) => d.scenario), SCENARIOS.map((x) => x.id));
  const deal = async (id: string) => (await store.getDeal(s.deals.find((d) => d.scenario === id)!.dealId))!.value;
  for (const d of s.deals) assert.equal((await store.getDeal(d.dealId))!.value.demo?.session, s.id);
  assert.equal((await deal('awaiting')).order, undefined);
  assert.equal(shipGate(await deal('ready')).decision, 'SHIP');
  assert.equal(shipGate(await deal('hold')).decision, 'HOLD');
  assert.equal((await deal('dispute')).disputes![0].id, 'PP-R-BTN-10196230');
  // Every PayPal debug ID on a demo deal says it was replayed.
  for (const d of s.deals) {
    for (const r of await store.listReceipts(d.dealId)) {
      if (typeof r.data.debugId === 'string') assert.match(r.data.debugId, /^rec-/, `${d.scenario} ${r.kind}`);
    }
  }
  assert.deepEqual(reached, []);
});

test('demo deals use the replay on page load, tracking and dispute sends; payment and onboarding are refused', async () => {
  const store = new MemoryDealStore();
  const s = await startDemo(store, now);
  const ready = s.deals.find((d) => d.scenario === 'ready')!;
  clock = new Date(clock.getTime() + 10 * 60_000);
  await maybeRefreshOnLoad((await store.getDeal(ready.dealId))!.value, { store, now });
  const disp = s.deals.find((d) => d.scenario === 'dispute')!;
  const { request } = await previewSubmission(disp.dealId, disp.keys.seller, 'PP-R-BTN-10196230', { advice: 'fight' }, { store, now });
  const out = await submitApproved(disp.dealId, disp.keys.seller, 'PP-R-BTN-10196230', { advice: 'fight' }, request.hash, { store, now });
  assert.equal(out.state, 'sent');
  assert.match(out.debugId!, /^rec-/);
  const awaiting = s.deals.find((d) => d.scenario === 'awaiting')!;
  await assert.rejects(startCheckout(awaiting.dealId, awaiting.keys.buyer, { store, publicHost: 'https://x.test' }), /judge mode never takes a payment/);
  await assert.rejects(startConnect(awaiting.dealId, awaiting.keys.seller, { store, publicHost: 'https://x.test' }), /judge mode never connects/);
  assert.deepEqual(reached, []);
});

test('a session only sees its own deals; unknown or malformed session IDs see nothing', async () => {
  const store = new MemoryDealStore();
  const a = await startDemo(store, now);
  const b = await startDemo(store, now);
  const va = (await demoView(store, a.id, now))!;
  assert.deepEqual(va.deals.map((d) => d.dealId), a.deals.map((d) => d.dealId));
  assert.ok(va.deals.every((d) => !b.deals.some((x) => x.dealId === d.dealId)));
  assert.equal(await demoView(store, 'x'.repeat(32)), undefined);
  assert.equal(await demoView(store, "' OR 1=1 --"), undefined);
  assert.equal(await demoView(store, undefined), undefined);
});

test('expired sessions are purged with their demo deals; a live deal is never deleted', async () => {
  const store = new MemoryDealStore();
  const old = await startDemo(store, () => new Date('2026-11-01T00:00:00Z'));
  const live = await createDeal({ chat: 'Sam: PS5 for £350?\nAlex: yes posted\nSam: deal', sellerName: 'Alex', country: 'UK' }, { store, ask: askWith() });
  // Even if a session document named a live deal, the purge skips it (no demo tag).
  await store.saveDemoSession({ ...old, deals: [...old.deals, { dealId: live.deal.id, scenario: 'x', keys: live.keys }] });
  const removed = await store.purgeDemo('2026-11-02T00:00:00Z');
  assert.equal(removed, SCENARIOS.length);
  assert.ok(await store.getDeal(live.deal.id));
  assert.equal(await store.getDeal(old.deals[0].dealId), undefined);
  assert.equal(await store.getDemoSession(old.id), undefined);
});

test('a failed seed still records the deals it created, so the purge can remove them; expired sessions are not served', async () => {
  const store = new MemoryDealStore();
  const t0 = new Date('2026-11-01T00:00:00Z');
  // The warning check fails, so confirming refuses (fail closed) after each deal is created.
  const failing: CheckEngine = async () => ({ run: { status: 'failed', at: t0.toISOString(), reason: 'model down' }, warnings: [], picks: {}, scores: {} });
  await assert.rejects(startDemo(store, () => t0, failing));
  // Every created deal is in a session the purge can find.
  assert.equal(await store.purgeDemo('2026-11-02T00:00:00Z'), SCENARIOS.length);

  const ok = await startDemo(store, () => t0);
  assert.equal(await demoView(store, ok.id, () => new Date('2026-11-03T00:00:00Z')), undefined, 'created two days before, so expired');
  assert.ok(await demoView(store, ok.id, () => new Date('2026-11-01T12:00:00Z')), 'still live within the day');
});
