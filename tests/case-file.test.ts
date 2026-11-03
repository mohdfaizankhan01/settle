import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaypalClient } from 'paypal';
import { caseFile } from '../lib/settle/case-file';
import { customIdFor } from '../lib/settle/checkout';
import { disputePlan } from '../lib/settle/dispute-plan';
import { addMessages } from '../lib/settle/deals';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { addTracking, markDelivered, setLabelPostcode } from '../lib/settle/shipping';
import { fakeDispute } from './helpers/dispute';
import { askWith, paidSetup } from './helpers/paid-deal';

// Jev, PayPal and the SDK are mocked. The case file lists proofs; the plan never predicts a win.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';
const sdkOk = () =>
  new PaypalClient({
    oauth2: { clientId: 'id', clientSecret: 's' },
    retry: { maxRetries: 0 },
    logging: { level: 'off' },
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      return url.pathname === '/v1/oauth2/token' ? Response.json({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }) : Response.json({ id: 'ORDER-1', status: 'COMPLETED' });
    },
  });

async function shipped(opts: { tracking?: boolean; delivered?: boolean; label?: string; ask?: ReturnType<typeof askWith> } = {}) {
  const t = await paidSetup(opts.ask);
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  if (opts.label !== undefined) await setLabelPostcode(t.dealId, t.keys.seller, opts.label, t.pdeps);
  if (opts.tracking) {
    t.order.purchase_units![0].shipping!.trackers = [{ id: 'CAP-1-AB123456789GB' }];
    await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk: sdkOk() });
  }
  if (opts.delivered) await markDelivered(t.dealId, t.keys.seller, '2026-11-04', t.pdeps);
  return t;
}

async function fileFor(t: Awaited<ReturnType<typeof shipped>>, over = {}) {
  const d = fakeDispute(customIdFor(await t.get()), over);
  await applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal });
  const deal = await t.get();
  const dispute = deal.disputes![0];
  const cf = caseFile(deal, dispute, await t.store.listReceipts(t.dealId));
  return { cf, plan: disputePlan(cf, dispute), dispute };
}

const statusOf = (cf: ReturnType<typeof caseFile>, id: string) => cf.proofs.find((p) => p.id === id)!.status;

test('not received, fully shipped and delivered to the PayPal address: fight, with every proof on file and cited', async () => {
  const t = await shipped({ label: 'LS1 1AA', tracking: true, delivered: true });
  const { cf, plan } = await fileFor(t);
  for (const id of ['payment', 'shipment', 'delivery', 'address', 'gate', 'method']) assert.equal(statusOf(cf, id), 'on_file', id);
  assert.equal(cf.proofs.find((p) => p.id === 'delivery')!.source, 'Entered by the seller');
  assert.ok(cf.proofs.every((p) => p.cites.length > 0));
  assert.equal(plan.advice, 'fight');
  assert.equal(plan.action!.rel, 'provide_evidence');
  assert.equal(plan.score.total, plan.score.of);
  assert.doesNotMatch(JSON.stringify(plan), /\d+\s*%|\bwin\b|will win|protected/i);
  assert.match(plan.note, /PayPal decides/);
});

test('not received without proof of delivery: refund, even with tracking', async () => {
  const t = await shipped({ label: 'LS1 1AA', tracking: true });
  const { cf, plan } = await fileFor(t);
  assert.equal(statusOf(cf, 'delivery'), 'missing');
  assert.equal(plan.advice, 'refund');
  assert.equal(plan.action!.rel, 'accept_claim');
  assert.match(plan.reasons.join(' '), /SP-PROOF-DELIV/);
  assert.ok(plan.alternatives.some((a) => a.advice === 'send_tracking'), 'still an inquiry: sending tracking is offered too');
});

test('no tracking at all: refund', async () => {
  const t = await shipped({ label: 'LS1 1AA' });
  const { cf, plan } = await fileFor(t);
  assert.equal(statusOf(cf, 'shipment'), 'missing');
  assert.equal(statusOf(cf, 'gate'), 'missing');
  assert.equal(plan.advice, 'refund');
});

test('a label that does not match PayPal\'s address contradicts the claim requirements: refund', async () => {
  const t = await shipped({ label: 'M1 1AE', tracking: true, delivered: true });
  const { cf, plan } = await fileFor(t);
  assert.equal(statusOf(cf, 'address'), 'contradicts');
  assert.equal(statusOf(cf, 'gate'), 'contradicts', 'the gate said hold when tracking went in');
  assert.equal(plan.advice, 'refund');
  assert.ok(plan.score.total < plan.score.of);
});

test('shipping elsewhere after a HOLD shows up as the gate contradicting', async () => {
  const t = await shipped({ label: 'LS1 1AA', ask: askWith(['ship_elsewhere']) });
  await addMessages(t.dealId, t.keys.seller, 'Sam: send it to my cousin please', t.deps);
  t.order.purchase_units![0].shipping!.trackers = [{ id: 'CAP-1-AB123456789GB' }];
  await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk: sdkOk() });
  const { cf } = await fileFor(t);
  assert.equal(statusOf(cf, 'gate'), 'contradicts');
});

test('only actions PayPal offers: no matching link means the Resolution Center fallback', async () => {
  const t = await shipped({ label: 'LS1 1AA', tracking: true, delivered: true });
  const { plan } = await fileFor(t, {
    status: 'UNDER_REVIEW',
    dispute_life_cycle_stage: 'CHARGEBACK',
    links: [{ href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-supporting-info', rel: 'provide_supporting_info', method: 'POST' }],
  });
  assert.equal(plan.advice, 'fight');
  assert.equal(plan.action!.rel, 'provide_supporting_info');
  assert.deepEqual(plan.alternatives, []);

  const t2 = await shipped({ label: 'LS1 1AA', tracking: true });
  const { plan: p2 } = await fileFor(t2, { links: [] });
  assert.equal(p2.advice, 'refund');
  assert.equal(p2.action, undefined);
  assert.match(p2.fallback!, /Resolution Center/);
});

test('not as described: the confirmed card, its source quote and the PayPal order item', async () => {
  const t = await shipped({ label: 'LS1 1AA', tracking: true });
  t.order.purchase_units![0].items = [{ name: (await t.get()).card.item!.value, quantity: '1', unit_amount: { currency_code: 'GBP', value: '350.00' } }];
  await applyVerifiedEvent(t.event('WH-2', 'CAP-1', 'PAYMENT.CAPTURE.UPDATED'), t.pdeps).catch(() => undefined);
  const { cf, plan } = await fileFor(t, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
  assert.equal(statusOf(cf, 'card'), 'on_file');
  assert.equal(statusOf(cf, 'quotes'), 'on_file');
  assert.equal(statusOf(cf, 'order-item'), 'on_file');
  assert.match(cf.notes.join(' '), /SP-SNAD/);
  assert.equal(plan.advice, 'fight');
});

test('marking delivered needs tracking first and a date that is not in the future', async () => {
  const t = await shipped({ label: 'LS1 1AA' });
  await assert.rejects(markDelivered(t.dealId, t.keys.seller, '2026-11-04', t.pdeps), /tracking/);
  const t2 = await shipped({ label: 'LS1 1AA', tracking: true });
  await assert.rejects(markDelivered(t2.dealId, t2.keys.seller, '2027-01-01', t2.pdeps), /future/);
  await assert.rejects(markDelivered(t2.dealId, t2.keys.buyer, '2026-11-04', t2.pdeps), /only the seller/);
});
