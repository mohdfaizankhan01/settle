import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskJev } from '../lib/jev/deal-check';
import type { SellerStatus } from '../lib/paypal';
import { checkConnect, finishConnect, startConnect, type ConnectPayPal } from '../lib/settle/connect';
import { createDeal } from '../lib/settle/deals';
import { MemoryDealStore } from '../lib/settle/store';

// PayPal is mocked. Jev fails (irrelevant here; the deal is still created).
const ask: AskJev = async () => {
  throw new Error('offline');
};

function setup(status: SellerStatus | undefined) {
  const store = new MemoryDealStore();
  const referrals: { trackingId: string; returnUrl: string }[] = [];
  const pp: ConnectPayPal = {
    async createPartnerReferral(trackingId, returnUrl) {
      referrals.push({ trackingId, returnUrl });
      return { data: { actionUrl: 'https://sandbox.paypal.com/onboard' }, debugId: 'dbg-ref' };
    },
    async sellerByTrackingId() {
      return status;
    },
  };
  return { store, referrals, deps: { store, paypal: pp, publicHost: 'https://settle.test' } };
}

const ok: SellerStatus = { merchantId: 'SELLER1', paymentsReceivable: true, primaryEmailConfirmed: true, granted: true };

async function newDeal(store: MemoryDealStore) {
  return createDeal({ chat: 'Sam: hi\nAlex: hello', sellerName: 'Alex', country: 'US' }, { store, ask });
}

test('the seller starts onboarding with our own tracking ID in the return URL', async () => {
  const { store, referrals, deps } = setup(ok);
  const { deal, keys } = await newDeal(store);
  const { actionUrl } = await startConnect(deal.id, keys.seller, deps);
  assert.equal(actionUrl, 'https://sandbox.paypal.com/onboard');
  assert.match(referrals[0].trackingId, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(referrals[0].returnUrl, `https://settle.test/api/paypal/onboarded?t=${referrals[0].trackingId}`);
  await assert.rejects(startConnect(deal.id, keys.buyer, deps), /only the seller/);
});

test('the payee is the merchant ID PayPal reports for the tracking ID', async () => {
  const { store, referrals, deps } = setup(ok);
  const { deal, keys } = await newDeal(store);
  await startConnect(deal.id, keys.seller, deps);
  assert.deepEqual(await finishConnect(referrals[0].trackingId, deps), { dealId: deal.id, connected: true });
  assert.equal((await store.getDeal(deal.id))!.value.payeeMerchantId, 'SELLER1');
  // Repeating is harmless.
  assert.equal((await checkConnect(deal.id, keys.seller, deps)).connected, true);
});

test('no payee until PayPal reports the grant and a receivable, confirmed account', async () => {
  for (const status of [undefined, { ...ok, granted: false }, { ...ok, paymentsReceivable: false }, { ...ok, primaryEmailConfirmed: false }]) {
    const { store, referrals, deps } = setup(status);
    const { deal, keys } = await newDeal(store);
    await startConnect(deal.id, keys.seller, deps);
    const result = await finishConnect(referrals[0].trackingId, deps);
    assert.equal(result.connected, false);
    assert.ok(result.reason);
    assert.equal((await store.getDeal(deal.id))!.value.payeeMerchantId, undefined);
  }
});

test('an unknown tracking ID is refused', async () => {
  const { deps } = setup(ok);
  await assert.rejects(finishConnect('made-up', deps), /unknown onboarding link/);
});

test('an earlier onboarding link no longer sets the payee', async () => {
  const { store, referrals, deps } = setup(ok);
  const { deal, keys } = await newDeal(store);
  await startConnect(deal.id, keys.seller, deps);
  await startConnect(deal.id, keys.seller, deps);
  await assert.rejects(finishConnect(referrals[0].trackingId, deps), /replaced/);
  assert.equal((await finishConnect(referrals[1].trackingId, deps)).connected, true);
});
