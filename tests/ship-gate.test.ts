import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMessages } from '../lib/settle/deals';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { shipGate } from '../lib/settle/ship-gate';
import { setLabelPostcode } from '../lib/settle/shipping';
import type { Deal } from '../lib/settle/types';
import { askWith, paidSetup } from './helpers/paid-deal';

// The ship gate is pure; these tests drive it through the real deal service with Jev and PayPal mocked.

const check = (deal: Deal, id: string) => shipGate(deal).checks.find((c) => c.id === id)!;

async function paid(ask = askWith()) {
  const t = await paidSetup(ask);
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  return t;
}

test('an unpaid deal holds, with every check citing protection-terms rows', async () => {
  const t = await paidSetup();
  const gate = shipGate(await t.get());
  assert.equal(gate.decision, 'HOLD');
  assert.equal(check(await t.get(), 'payment').status, 'not_yet');
  for (const c of gate.checks.filter((c) => c.id !== 'warnings')) assert.ok(c.cites.length > 0, c.id);
  assert.equal(gate.note, 'Meets the checks we can verify. PayPal decides eligibility.');
  assert.doesNotMatch(JSON.stringify(gate), /\b(?:protected|safe)\b/i);
});

test('paid deal: review until the label postcode is typed, then ship; a different postcode holds', async () => {
  const t = await paid();
  let deal = await t.get();
  assert.equal(check(deal, 'payment').status, 'pass');
  assert.equal(shipGate(deal).decision, 'REVIEW');
  assert.equal(check(deal, 'tracking').status, 'not_yet');

  deal = (await setLabelPostcode(t.dealId, t.keys.seller, 'ls11aa', t.pdeps)).value;
  assert.equal(check(deal, 'address').status, 'pass');
  assert.equal(shipGate(deal).decision, 'SHIP');

  deal = (await setLabelPostcode(t.dealId, t.keys.seller, 'M1 1AE', t.pdeps)).value;
  assert.equal(check(deal, 'address').status, 'fail');
  assert.equal(shipGate(deal).decision, 'HOLD');
  assert.match(shipGate(deal).reasons.join(' '), /SP-ADDR/);
});

test('only the seller types the label postcode, and only after payment started', async () => {
  const t = await paidSetup();
  await assert.rejects(setLabelPostcode(t.dealId, t.keys.buyer, 'LS1 1AA', t.pdeps), /only the seller/);
  await assert.rejects(setLabelPostcode(t.dealId, t.keys.seller, 'not a postcode', t.pdeps), /postcode like/);
});

test('"send it to my cousin" after payment turns the gate to HOLD, naming SP-ADDR', async () => {
  const t = await paid(askWith(['ship_elsewhere']));
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  assert.equal(shipGate(await t.get()).decision, 'SHIP');
  const deal = (await addMessages(t.dealId, t.keys.seller, 'Sam: actually can you send it to my cousin instead?', t.deps)).value;
  const gate = shipGate(deal);
  assert.equal(gate.decision, 'HOLD');
  assert.equal(check(deal, 'address').status, 'fail');
  assert.match(check(deal, 'address').detail, /m4/);
  assert.ok(check(deal, 'address').cites.includes('SP-ADDR'));
  const kinds = (await t.store.listReceipts(t.dealId)).map((r) => r.kind);
  assert.ok(kinds.includes('messages.added'));
  assert.equal((await t.store.listReceipts(t.dealId)).findLast((r) => r.kind === 'gate.decided')!.data.decision, 'HOLD');
});

test('a new postcode in a message after payment holds, found in code, not by the model', async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  const deal = (await addMessages(t.dealId, t.keys.buyer, 'Sam: oh my address is now M1 1AE', t.deps)).value;
  assert.equal(check(deal, 'address').status, 'fail');
  assert.match(check(deal, 'address').detail, /M1 1AE/);
  assert.equal(shipGate(deal).decision, 'HOLD');
  // The same postcode PayPal has is fine.
  const t2 = await paid();
  await setLabelPostcode(t2.dealId, t2.keys.seller, 'LS1 1AA', t2.pdeps);
  assert.equal(shipGate((await addMessages(t2.dealId, t2.keys.buyer, 'Sam: it is LS1 1AA right?', t2.deps)).value).decision, 'SHIP');
});

test('a failed warning check on added messages is REVIEW, never a pass', async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  const deal = (await addMessages(t.dealId, t.keys.seller, 'Sam: hi', { ...t.deps, ask: async () => { throw new Error('jev down'); } })).value;
  assert.equal(check(deal, 'warnings').status, 'cant_check');
  assert.equal(shipGate(deal).decision, 'REVIEW');
});

test('messages can only be added after payment started, with the deal\'s speaker names', async () => {
  const t = await paidSetup();
  const d = await t.get();
  await t.store.updateDeal(t.dealId, (await t.store.getDeal(t.dealId))!.version, { ...d, order: { ...d.order!, status: 'CREATED' } });
  await assert.rejects(addMessages(t.dealId, t.keys.seller, 'Sam: hi', t.deps), /once payment has started/);
  const t2 = await paidSetup();
  await assert.rejects(addMessages(t2.dealId, t2.keys.seller, 'Mallory: hi', t2.deps), /sender's name/);
});

test('in-person handover fails the delivery check and asks for review; digital can\'t be checked', async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  const deal = await t.get();
  const collect = { ...deal, card: { ...deal.card, delivery: { ...deal.card.delivery!, value: 'collect' as const } } };
  assert.equal(check(collect, 'delivery').status, 'fail');
  assert.ok(check(collect, 'delivery').cites.includes('SP-INPERSON'));
  assert.equal(shipGate(collect).decision, 'REVIEW');
  const digital = { ...deal, card: { ...deal.card, delivery: { ...deal.card.delivery!, value: 'digital' as const } } };
  assert.equal(check(digital, 'delivery').status, 'cant_check');
});

test('PayPal unreachable is "can\'t check" and holds; a refund after payment holds', async () => {
  const t = await paid();
  t.failGet(true);
  t.order.status = 'COMPLETED';
  await assert.rejects(applyVerifiedEvent(t.event('WH-2', 'CAP-1', 'PAYMENT.CAPTURE.REFUNDED'), t.pdeps));
  let deal = await t.get();
  assert.equal(check(deal, 'payment').status, 'cant_check');
  assert.equal(shipGate(deal).decision, 'HOLD');
  t.failGet(false);
  t.order.purchase_units![0].payments!.captures![0].status = 'REFUNDED';
  await applyVerifiedEvent(t.event('WH-2', 'CAP-1', 'PAYMENT.CAPTURE.REFUNDED'), t.pdeps);
  deal = await t.get();
  assert.equal(check(deal, 'payment').status, 'fail');
  assert.equal(shipGate(deal).decision, 'HOLD');
});

test('gate receipts are written only when the decision or a check changes', async () => {
  const t = await paid();
  const count = async () => (await t.store.listReceipts(t.dealId)).filter((r) => r.kind === 'gate.decided').length;
  const before = await count();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  assert.equal(await count(), before + 1);
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  assert.equal(await count(), before + 1);
});

test('a warning on added messages with no evidence message still counts', async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  const base = askWith(['ship_elsewhere']);
  const noEvidence: typeof base = async (req) => {
    const r = await base(req);
    return { ...r, answers: { ...r.answers, ev_ship_elsewhere: { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } } } };
  };
  const deal = (await addMessages(t.dealId, t.keys.seller, 'Sam: one more thing', { ...t.deps, ask: noEvidence })).value;
  assert.equal(shipGate(deal).decision, 'HOLD');
});

test("the seller's own postcode in a message after payment does not hold", async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  const deal = (await addMessages(t.dealId, t.keys.seller, 'Alex: posting from M1 1AE today', t.deps)).value;
  assert.equal(check(deal, 'address').status, 'pass');
  assert.equal(shipGate(deal).decision, 'SHIP');
});

test('a failed read after a good one is "can\'t check" and holds', async () => {
  const t = await paid();
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  t.failGet(true);
  await assert.rejects(applyVerifiedEvent(t.event('WH-5', 'CAP-1', 'PAYMENT.CAPTURE.REVERSED'), t.pdeps));
  const deal = await t.get();
  assert.equal(check(deal, 'payment').status, 'cant_check');
  assert.equal(shipGate(deal).decision, 'HOLD');
});
