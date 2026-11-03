import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PayPalApiError, type Order, type WebhookEvent } from '../lib/paypal';
import { applyVerifiedEvent, isPaid, maybeRefreshOnLoad } from '../lib/settle/payment';
import { paidSetup, tick } from './helpers/paid-deal';

// Jev and PayPal are mocked. Payment counts only with a verified event plus a fresh GET.

test('a verified capture webhook plus a matching fresh GET confirms payment', async () => {
  const t = await paidSetup();
  const r = await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  assert.deepEqual(r, { handled: true, dealId: t.dealId });
  const deal = await t.get();
  assert.equal(isPaid(deal), true);
  assert.deepEqual(t.calls, ['get ORDER-1 as SELLER1']);
  assert.equal(deal.order!.status, 'COMPLETED');
  assert.equal(deal.payment!.webhook!.via, 'webhook');
  const read = deal.payment!.read!;
  assert.ok(read.ok);
  assert.equal(read.fee, '10.80');
  assert.equal(read.shipTo!.postalCode, 'LS1 1AA');
  const receipts = await t.store.listReceipts(t.dealId);
  const last = receipts.findLast((r) => r.kind === 'payment.checked')!;
  assert.equal(last.kind, 'payment.checked');
  assert.equal(last.data.paid, true);
  assert.equal(last.data.debugId, 'dbg-get');
});

test('a replayed event is a no-op', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  const before = (await t.store.listReceipts(t.dealId)).length;
  const r = await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'already processed');
  assert.equal(t.calls.length, 1);
  assert.equal((await t.store.listReceipts(t.dealId)).length, before);
});

test('an event for a different capture does not confirm payment', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1', 'CAP-OTHER'), t.pdeps);
  const deal = await t.get();
  assert.equal(isPaid(deal), false);
  assert.equal((await t.store.listReceipts(t.dealId)).findLast((r) => r.kind === 'payment.checked')!.data.ignored, 'event is for another capture');
});

test('a fresh GET that does not match the card blocks confirmation', async () => {
  for (const tamper of [
    (o: Order) => void (o.purchase_units![0].amount!.value = '1.00'),
    (o: Order) => void (o.purchase_units![0].payee!.merchant_id = 'SCAMMER'),
    (o: Order) => void (o.purchase_units![0].custom_id = 'x:y'),
    (o: Order) => void (o.purchase_units![0].payments!.captures![0].status = 'PENDING'),
    (o: Order) => void o.purchase_units![0].payments!.captures!.push({ id: 'CAP-2', status: 'COMPLETED' }),
  ]) {
    const t = await paidSetup();
    tamper(t.order);
    await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
    assert.equal(isPaid(await t.get()), false);
  }
});

test('PayPal down: the event is not marked processed, the error surfaces, and the deal says it cannot check', async () => {
  const t = await paidSetup();
  t.failGet(true);
  await assert.rejects(applyVerifiedEvent(t.event('WH-1'), t.pdeps), PayPalApiError);
  assert.equal(await t.store.hasEvent('WH-1'), false);
  const deal = await t.get();
  assert.equal(isPaid(deal), false);
  assert.equal(deal.payment!.read!.ok, false);
  // PayPal sends it again later and it goes through.
  t.failGet(false);
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  assert.equal(isPaid(await t.get()), true);
});

test('a later refund of the capture turns paid off', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  t.order.purchase_units![0].payments!.captures![0].status = 'REFUNDED';
  await applyVerifiedEvent(t.event('WH-2', 'CAP-1', 'PAYMENT.CAPTURE.REFUNDED'), t.pdeps);
  assert.equal(isPaid(await t.get()), false);
});

test('an event for a deal Settle does not have, or a non-capture event, changes nothing', async () => {
  const t = await paidSetup();
  const stray: WebhookEvent = { id: 'WH-9', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1', custom_id: '00000000-0000-0000-0000-000000000000:' + '0'.repeat(64) } };
  assert.equal((await applyVerifiedEvent(stray, t.pdeps)).handled, false);
  assert.equal((await applyVerifiedEvent({ id: 'WH-8', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} }, t.pdeps)).handled, false);
  assert.deepEqual(t.calls, []);
});

test('missed webhook: a page load reads PayPal and its event log, and confirms only if the event is there', async () => {
  const t = await paidSetup();
  let deal = await maybeRefreshOnLoad(await t.get(), t.pdeps);
  assert.equal(isPaid(deal), false, 'no event in the log yet');
  assert.deepEqual(t.calls, ['get ORDER-1 as SELLER1', 'events CAP-1']);

  // Rate-limited: a reload within a minute doesn't call PayPal.
  await maybeRefreshOnLoad(deal, t.pdeps);
  assert.equal(t.calls.length, 2);

  t.log.push(t.event('WH-1'));
  tick(61_000);
  deal = await maybeRefreshOnLoad(await t.get(), t.pdeps);
  assert.equal(isPaid(deal), true);
  assert.equal(deal.payment!.webhook!.via, 'event-log');

  // Once paid, page loads stop calling PayPal.
  tick(61_000);
  await maybeRefreshOnLoad(deal, t.pdeps);
  assert.equal(t.calls.length, 4);
});

test('the page fallback does nothing before capture, and survives PayPal being down', async () => {
  const t = await paidSetup();
  const d = await t.get();
  await maybeRefreshOnLoad({ ...d, order: { ...d.order!, status: 'CREATED' } }, t.pdeps);
  assert.deepEqual(t.calls, []);
  t.failGet(true);
  const after = await maybeRefreshOnLoad(d, t.pdeps);
  assert.equal(isPaid(after), false);
  assert.equal(after.payment!.read!.ok, false);
});
