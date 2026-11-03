import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskJev } from '../lib/jev/deal-check';
import type { Order, OrderRequest } from '../lib/paypal';
import { cardHash } from '../lib/settle/card';
import { captureCheckout, customIdFor, startCheckout, type PayPalDeps } from '../lib/settle/checkout';
import { answerQuestion, confirmCard, createDeal, declineDeal, enterTerm, setPayee, withdrawDecline, type Deps } from '../lib/settle/deals';
import { SIGNALS } from '../lib/settle/signals';
import { MemoryDealStore } from '../lib/settle/store';

// Jev and PayPal are mocked. PayPal "remembers" created orders so GET returns what was created.

const pick = (choice: string) => ({ choice, confidence: 0.95, probabilities: { [choice]: 0.95 } });
const ask: AskJev = async () => {
  const answers: Record<string, unknown> = { price: pick('PRICE_1'), shipBy: pick('none'), delivery: pick('post'), itemMessage: pick('m1'), deliveryMessage: pick('m2') };
  for (const s of SIGNALS) {
    answers[`sig_${s.id}`] = { noul: 0.01 };
    answers[`ev_${s.id}`] = pick('none');
  }
  return { model: 'jev-test', answers };
};

function fakePayPal() {
  const orders = new Map<string, { req: OrderRequest; status: string }>();
  const calls: string[] = [];
  const toOrder = (id: string): Order => {
    const o = orders.get(id)!;
    return { id, status: o.status, purchase_units: [{ reference_id: o.req.dealId, custom_id: o.req.customId, amount: o.req.amount, payee: { merchant_id: o.req.payeeMerchantId } }] };
  };
  const pp: PayPalDeps & { approve(id: string): void; tamper(id: string, f: (r: OrderRequest) => void): void } = {
    async createOrder(req, requestId) {
      calls.push(`create ${requestId}`);
      const id = `ORDER-${orders.size + 1}`;
      orders.set(id, { req: structuredClone(req), status: 'CREATED' });
      return { data: toOrder(id), debugId: 'dbg-create' };
    },
    async getOrder(id) {
      calls.push(`get ${id}`);
      return { data: toOrder(id), debugId: 'dbg-get' };
    },
    async captureOrder(id) {
      calls.push(`capture ${id}`);
      orders.get(id)!.status = 'COMPLETED';
      return { data: { ...toOrder(id), purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] } }] }, debugId: 'dbg-cap' };
    },
    approve: (id) => void (orders.get(id)!.status = 'APPROVED'),
    tamper: (id, f) => f(orders.get(id)!.req),
  };
  return { pp, calls, orders };
}

async function lockedDeal(feePayer: 'seller' | 'buyer' = 'seller') {
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask, now: () => new Date('2026-10-22T12:00:00Z') };
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
  await answerQuestion(deal.id, keys.seller, 'q_fee', feePayer, deps);
  await answerQuestion(deal.id, keys.buyer, 'q_fee', feePayer, deps);
  const stored = await setPayee(deal.id, 'SELLER1', deps);
  await confirmCard(deal.id, keys.seller, cardHash(stored.value), deps);
  await confirmCard(deal.id, keys.buyer, cardHash(stored.value), deps);
  const { pp, calls, orders } = fakePayPal();
  return { deps, keys, dealId: deal.id, pp, calls, orders, co: { store, paypal: pp, publicHost: 'https://settle.test' } };
}

test('the order is built from the locked card and carries dealId:hash in custom_id', async () => {
  const { dealId, keys, co, orders } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  const req = orders.get(orderId)!.req;
  const deal = (await co.store.getDeal(dealId))!.value;
  assert.equal(req.customId, customIdFor(deal));
  assert.match(req.customId, /^[0-9a-f-]{36}:[0-9a-f]{64}$/);
  assert.ok(req.customId.length <= 127);
  assert.deepEqual(req.amount, { currency_code: 'GBP', value: '350.00' });
  assert.equal(req.payeeMerchantId, 'SELLER1');
  assert.equal(req.physical, true);
  assert.equal(req.items.length, 1);
  assert.match(req.items[0].name, /PS5/);
});

test('only the buyer can start checkout, and only on a locked card', async () => {
  const { dealId, keys, co } = await lockedDeal();
  await assert.rejects(startCheckout(dealId, keys.seller, co), /only the buyer/);
  await setPayee(dealId, 'SELLER2', { store: co.store });
  await assert.rejects(startCheckout(dealId, keys.buyer, co), /confirm the card/);
});

test('a second click reuses the open order', async () => {
  const { dealId, keys, co, calls } = await lockedDeal();
  const a = await startCheckout(dealId, keys.buyer, co);
  const b = await startCheckout(dealId, keys.buyer, co);
  assert.equal(a.orderId, b.orderId);
  assert.equal(calls.filter((c) => c.startsWith('create')).length, 1);
});

test('capture happens only after a fresh GET matches the card', async () => {
  const { dealId, keys, co, pp, calls } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  const result = await captureCheckout(dealId, keys.buyer, orderId, co);
  assert.equal(result.status, 'CAPTURE_REQUESTED');
  assert.deepEqual(calls.slice(-2), [`get ${orderId}`, `capture ${orderId}`]);
  const receipts = await co.store.listReceipts(dealId);
  assert.equal(receipts.at(-1)?.kind, 'order.capture_requested');
});

test('a card changed after confirming cannot be paid', async () => {
  const { dealId, keys, co, pp, calls } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  // The payee changes after the order was created (both had confirmed the old card).
  await setPayee(dealId, 'SOMEONE-ELSE', { store: co.store });
  await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /card changed/);
  assert.ok(!calls.some((c) => c.startsWith('capture')));
  assert.equal((await co.store.listReceipts(dealId)).at(-1)?.kind, 'capture.blocked');
});

test('an order whose amount, payee or custom_id differs from the card is not captured', async () => {
  for (const tamper of [
    (r: OrderRequest) => void (r.amount = { currency_code: 'GBP', value: '1.00' }),
    (r: OrderRequest) => void (r.payeeMerchantId = 'ATTACKER'),
    (r: OrderRequest) => void (r.customId = 'other:hash'),
    (r: OrderRequest) => void (r.amount = { currency_code: 'USD', value: '350.00' }),
  ]) {
    const { dealId, keys, co, pp, calls } = await lockedDeal();
    const { orderId } = await startCheckout(dealId, keys.buyer, co);
    pp.approve(orderId);
    pp.tamper(orderId, tamper);
    await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /not captured/);
    assert.ok(!calls.some((c) => c.startsWith('capture')));
  }
});

test('an order the buyer has not approved is not captured; another deal\'s order is refused', async () => {
  const { dealId, keys, co } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /not APPROVED/);
  await assert.rejects(captureCheckout(dealId, keys.buyer, 'ORDER-OTHER', co), /not this deal/);
});

test('PayPal unreachable on the fresh GET fails closed', async () => {
  const { dealId, keys, co, pp } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.getOrder = async () => {
    throw new Error('network');
  };
  await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /nothing was captured/);
});

test('the payee cannot change once payment has started', async () => {
  const { dealId, keys, co, pp } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  await captureCheckout(dealId, keys.buyer, orderId, co);
  await assert.rejects(setPayee(dealId, 'ATTACKER', { store: co.store }), /cannot change after payment/);
});

test('when the buyer covers the fee, the order total and a fee line come from code', async () => {
  const { dealId, keys, co, orders } = await lockedDeal('buyer');
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  const req = orders.get(orderId)!.req;
  // £350 at 2.9% + £0.30 (docs/fees.md FEE-UK), grossed up so the seller still gets £350.
  assert.deepEqual(req.amount, { currency_code: 'GBP', value: '360.76' });
  assert.deepEqual(req.items.map((i) => i.amount.value), ['350.00', '10.76']);
});

test('the seller paying for their own deal is not captured', async () => {
  const { dealId, keys, co, pp } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  const get = pp.getOrder;
  pp.getOrder = async (id, m) => {
    const r = await get(id, m);
    return { ...r, data: { ...r.data, payer: { payer_id: 'SELLER1' } } };
  };
  await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /payer is the seller/);
});

test('a decline blocks paying until it is withdrawn; the other side sees it first', async () => {
  const { dealId, keys, co, deps } = await lockedDeal();
  await declineDeal(dealId, keys.seller, 'wants_ff', deps);
  await assert.rejects(startCheckout(dealId, keys.buyer, co), /confirm the card/);
  const deal = (await co.store.getDeal(dealId))!.value;
  const { dealView } = await import('../lib/settle/view');
  const view = dealView(deal, 'buyer');
  assert.equal(view.warnings[0].signalId, 'declined');
  assert.deepEqual(view.warnings[0].cites, ['PP-FF', 'SP-FF']);
  await assert.rejects(declineDeal(dealId, keys.buyer, 'made-up', deps), /unknown reason/);
  await withdrawDecline(dealId, keys.seller, deps);
  assert.equal((await co.store.getDeal(dealId))!.value.declines?.length, 0);
});

test('a capture whose answer is lost is recorded from a fresh GET, not refused', async () => {
  const { dealId, keys, co, pp } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  const realCapture = pp.captureOrder;
  pp.captureOrder = async (id, rid) => {
    await realCapture(id, rid);
    throw new Error('socket hang up');
  };
  const r = await captureCheckout(dealId, keys.buyer, orderId, co);
  assert.equal(r.status, 'CAPTURE_REQUESTED');
  assert.equal((await co.store.getDeal(dealId))!.value.order!.status, 'CAPTURE_REQUESTED');
  // A retry after the lost answer also records it instead of "not APPROVED".
  const again = await captureCheckout(dealId, keys.buyer, orderId, co);
  assert.equal(again.status, 'CAPTURE_REQUESTED');
});

test('a capture that failed at PayPal still fails', async () => {
  const { dealId, keys, co, pp } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  pp.captureOrder = async () => {
    throw new Error('INSTRUMENT_DECLINED');
  };
  await assert.rejects(captureCheckout(dealId, keys.buyer, orderId, co), /INSTRUMENT_DECLINED/);
  assert.equal((await co.store.getDeal(dealId))!.value.order!.status, 'CREATED');
});

test('the seller cannot rewrite the card once payment has started', async () => {
  const { dealId, keys, co, pp, deps } = await lockedDeal();
  const { orderId } = await startCheckout(dealId, keys.buyer, co);
  pp.approve(orderId);
  await captureCheckout(dealId, keys.buyer, orderId, co);
  await assert.rejects(enterTerm(dealId, keys.seller, 'item', 'phone case', deps), /payment already started/);
});

test("the buyer's checkout payload carries the total, fee included", async () => {
  const { dealId, co } = await lockedDeal('buyer');
  const { dealView } = await import('../lib/settle/view');
  const deal = (await co.store.getDeal(dealId))!.value;
  const view = dealView(deal, 'buyer');
  assert.equal(view.checkout?.amount, view.money?.total.replace(/^[^\d]+/, ''));
  assert.notEqual(view.checkout?.amount, '350.00');
});
