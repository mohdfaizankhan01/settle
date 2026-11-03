import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionPath } from '../lib/paypal';
import { customIdFor } from '../lib/settle/checkout';
import { maybeRefreshDisputes } from '../lib/settle/disputes';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { shipGate } from '../lib/settle/ship-gate';
import { fakeDispute } from './helpers/dispute';
import { paidSetup, tick } from './helpers/paid-deal';

// PayPal is mocked. A dispute webhook only triggers a fresh GET; the GET must name this deal's capture.

async function disputed(over = {}) {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  const d = fakeDispute(customIdFor(await t.get()), over);
  const deps = { ...t.pdeps, disputes: d.paypal };
  return { t, d, deps };
}

test('a verified dispute webhook reads the dispute as the seller and links it to the deal', async () => {
  const { t, d, deps } = await disputed();
  const r = await applyVerifiedEvent(d.event('WH-D1'), deps);
  assert.equal(r.handled, true);
  assert.deepEqual(d.calls, ['get PP-D-1 as SELLER1']);
  const rec = (await t.get()).disputes![0];
  assert.equal(rec.reason, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  assert.equal(rec.dueDate, '2026-11-15T10:00:00.000Z');
  assert.deepEqual(rec.actions.map((a) => a.rel), ['provide_evidence', 'accept_claim', 'make_offer']);
  assert.equal(rec.actions[0].path, '/v1/customer/disputes/PP-D-1/provide-evidence');
  const receipt = (await t.store.listReceipts(t.dealId)).findLast((x) => x.kind === 'dispute.read')!;
  assert.equal(receipt.data.debugId, 'dbg-dispute');
});

test('an open dispute holds the ship gate (SP-RELEASE)', async () => {
  const { t, d, deps } = await disputed();
  await applyVerifiedEvent(d.event('WH-D1'), deps);
  const gate = shipGate(await t.get());
  assert.equal(gate.decision, 'HOLD');
  const pay = gate.checks.find((c) => c.id === 'payment')!;
  assert.equal(pay.status, 'fail');
  assert.ok(pay.cites.includes('SP-RELEASE'));
});

test('a replayed dispute event is a no-op', async () => {
  const { d, deps } = await disputed();
  await applyVerifiedEvent(d.event('WH-D1'), deps);
  assert.equal((await applyVerifiedEvent(d.event('WH-D1'), deps)).handled, false);
  assert.equal(d.calls.length, 1);
});

test('a dispute whose fresh read names another capture is ignored', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  const custom = customIdFor(await t.get());
  const d = fakeDispute(custom, { disputed_transactions: [{ seller_transaction_id: 'CAP-OTHER', custom }] });
  await applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal });
  assert.equal((await t.get()).disputes, undefined);
  assert.equal((await t.store.listReceipts(t.dealId)).findLast((x) => x.kind === 'dispute.ignored')!.data.reason, "the dispute is not about this deal's payment");
});

test('only action links on PayPal\'s API host, for this dispute, as POST, are kept', () => {
  const ok = { href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence', rel: 'provide_evidence', method: 'POST' };
  assert.equal(actionPath('PP-D-1', ok), '/v1/customer/disputes/PP-D-1/provide-evidence');
  assert.equal(actionPath('PP-D-1', { ...ok, href: 'https://evil.example/v1/customer/disputes/PP-D-1/provide-evidence' }), undefined);
  assert.equal(actionPath('PP-D-1', { ...ok, href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-2/accept-claim' }), undefined);
  assert.equal(actionPath('PP-D-1', { ...ok, href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/x/../../../../v2/payments' }), undefined);
  assert.equal(actionPath('PP-D-1', { ...ok, method: 'GET' }), undefined);
});

test('PayPal down: the event is retried later, and a page load re-reads open disputes once a minute', async () => {
  const { t, d, deps } = await disputed();
  d.failGet(true);
  await assert.rejects(applyVerifiedEvent(d.event('WH-D1'), deps));
  assert.equal(await t.store.hasEvent('WH-D1'), false);
  d.failGet(false);
  await applyVerifiedEvent(d.event('WH-D1'), deps);
  d.dispute.dispute_life_cycle_stage = 'CHARGEBACK';
  d.dispute.status = 'UNDER_REVIEW';
  d.dispute.links = [{ href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-supporting-info', rel: 'provide_supporting_info', method: 'POST' }];
  const dd = { store: t.store, paypal: d.paypal, now: deps.now };
  let deal = await maybeRefreshDisputes(await t.get(), dd);
  assert.equal(deal.disputes![0].stage, 'INQUIRY', 'rate-limited');
  tick(61_000);
  deal = await maybeRefreshDisputes(await t.get(), dd);
  assert.equal(deal.disputes![0].stage, 'CHARGEBACK');
  assert.deepEqual(deal.disputes![0].actions.map((a) => a.rel), ['provide_supporting_info']);
});

test('a resolved dispute no longer holds the gate on its own', async () => {
  const { t, d, deps } = await disputed({ status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } });
  await applyVerifiedEvent(d.event('WH-D9', 'CUSTOMER.DISPUTE.RESOLVED'), deps);
  const pay = shipGate(await t.get()).checks.find((c) => c.id === 'payment')!;
  assert.equal(pay.status, 'pass');
  assert.equal((await t.get()).disputes![0].outcome, 'RESOLVED_SELLER_FAVOUR');
});

test('a dispute event before the capture is recorded is not marked processed, so PayPal retries it', async () => {
  const t = await paidSetup();
  const d = fakeDispute(customIdFor(await t.get()));
  await assert.rejects(applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal }), /not recorded yet/);
  assert.equal(await t.store.hasEvent('WH-D1'), false);
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  await applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal });
  assert.equal((await t.get()).disputes![0].id, 'PP-D-1');
});
