import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskJev } from '../lib/jev/deal-check';
import { PayPalApiError, type Order, type WebhookEvent } from '../lib/paypal';
import { cardHash } from '../lib/settle/card';
import { customIdFor } from '../lib/settle/checkout';
import { answerQuestion, confirmCard, createDeal, setPayee, type Deps } from '../lib/settle/deals';
import { applyVerifiedEvent, isPaid, maybeRefreshOnLoad, type PaymentPayPal } from '../lib/settle/payment';
import { SIGNALS } from '../lib/settle/signals';
import { MemoryDealStore } from '../lib/settle/store';

// Jev and PayPal are mocked. Payment counts only with a verified event plus a fresh GET.

const pick = (choice: string) => ({ choice, confidence: 0.95, probabilities: { [choice]: 0.95 } });
const ask: AskJev = async () => {
  const answers: Record<string, unknown> = { price: pick('PRICE_1'), shipBy: pick('none'), delivery: pick('post'), itemMessage: pick('m1'), deliveryMessage: pick('m2') };
  for (const s of SIGNALS) {
    answers[`sig_${s.id}`] = { noul: 0.01 };
    answers[`ev_${s.id}`] = pick('none');
  }
  return { model: 'jev-test', answers };
};

let clock = new Date('2026-11-04T12:00:00Z');
const now = () => clock;

async function paidSetup() {
  clock = new Date('2026-11-04T12:00:00Z');
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask, now };
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
  await answerQuestion(deal.id, keys.seller, 'q_fee', 'seller', deps);
  await answerQuestion(deal.id, keys.buyer, 'q_fee', 'seller', deps);
  const s = await setPayee(deal.id, 'SELLER1', deps);
  await confirmCard(deal.id, keys.seller, cardHash(s.value), deps);
  const c = await confirmCard(deal.id, keys.buyer, cardHash(s.value), deps);
  // As if checkout created and captured the order.
  const locked = c.value;
  await store.updateDeal(deal.id, c.version, { ...locked, order: { id: 'ORDER-1', cardHash: cardHash(locked), createdAt: clock.toISOString(), status: 'CAPTURE_REQUESTED' } });

  const order: Order = {
    id: 'ORDER-1',
    status: 'COMPLETED',
    payer: { payer_id: 'BUYER1' },
    purchase_units: [{
      custom_id: customIdFor(locked),
      amount: { currency_code: 'GBP', value: '350.00' },
      payee: { merchant_id: 'SELLER1' },
      shipping: { name: { full_name: 'Sam Buyer' }, address: { address_line_1: '1 High St', admin_area_2: 'Leeds', postal_code: 'LS1 1AA', country_code: 'GB' } },
      payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '350.00' }, seller_receivable_breakdown: { paypal_fee: { currency_code: 'GBP', value: '10.80' }, net_amount: { currency_code: 'GBP', value: '339.20' } } }] },
    }],
  };
  const calls: string[] = [];
  const log: WebhookEvent[] = [];
  let failGet = false;
  const pp: PaymentPayPal = {
    async getOrder(id, seller) {
      calls.push(`get ${id} as ${seller}`);
      if (failGet) throw new PayPalApiError(503, '/v2/checkout/orders', 'down', 'dbg-down');
      return { data: structuredClone(order), debugId: 'dbg-get' };
    },
    async webhookEventsFor(captureId) {
      calls.push(`events ${captureId}`);
      return { data: log.filter((e) => (e.resource as { id: string }).id === captureId) };
    },
  };
  const event = (id: string, captureId = 'CAP-1', type = 'PAYMENT.CAPTURE.COMPLETED'): WebhookEvent => ({
    id,
    event_type: type,
    resource: { id: captureId, status: 'COMPLETED', custom_id: customIdFor(locked), supplementary_data: { related_ids: { order_id: 'ORDER-1' } } },
  });
  const get = async () => (await store.getDeal(deal.id))!.value;
  return { store, dealId: deal.id, order, pp, calls, log, event, get, failGet: (v: boolean) => void (failGet = v), pdeps: { store, paypal: pp, now } };
}

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
  const last = receipts.at(-1)!;
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
  assert.equal((await t.store.listReceipts(t.dealId)).at(-1)!.data.ignored, 'event is for another capture');
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
  clock = new Date(clock.getTime() + 61_000);
  deal = await maybeRefreshOnLoad(await t.get(), t.pdeps);
  assert.equal(isPaid(deal), true);
  assert.equal(deal.payment!.webhook!.via, 'event-log');

  // Once paid, page loads stop calling PayPal.
  clock = new Date(clock.getTime() + 61_000);
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
