import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskJev } from '../lib/jev/deal-check';
import type { Order, OrderRequest } from '../lib/paypal';
import { cardHash } from '../lib/settle/card';
import { captureCheckout, customIdFor, startCheckout, type PayPalDeps } from '../lib/settle/checkout';
import { confirmCard, createDeal, setPayee, type Deps } from '../lib/settle/deals';
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

async function lockedDeal() {
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask, now: () => new Date('2026-10-22T12:00:00Z') };
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
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
  assert.equal(req.item.physical, true);
  assert.match(req.item.name, /PS5/);
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
