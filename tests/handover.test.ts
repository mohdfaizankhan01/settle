// Meet-up mode (DECISIONS #20, spike D4), with PayPal mocked: the hold counts only after a
// verified webhook plus a fresh GET; only the buyer with the seller's current code releases the
// money; any PayPal error leaves it held; walking away or the 3-day limit releases the hold.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PayPalApiError, type Authorization, type Capture, type Order, type OrderRequest, type WebhookEvent } from '../lib/paypal';
import { cardHash } from '../lib/settle/card';
import { captureCheckout, customIdFor, startCheckout } from '../lib/settle/checkout';
import { answerQuestion, confirmCard, createDeal, setPayee, type Deps, openLinks } from '../lib/settle/deals';
import { cancelHandover, CODE_TTL_MS, isHeld, payerHash, releaseExpiredHold, releaseHandover as release, showHandoverCode, type HandoverDeps, type HandoverPayPal } from '../lib/settle/handover';
import { paidCheck } from '../lib/settle/paid-check';
import { applyVerifiedEvent, isPaid } from '../lib/settle/payment';
import { MemoryDealStore, updateWithRetry } from '../lib/settle/store';
import { dealView } from '../lib/settle/view';
import { askWith, clock, tick } from './helpers/paid-deal';

const now = () => clock.at;
/** The secret the buyer's phone got when it started the hold checkout. */
const PAYER = 'payer-secret-of-the-buyers-phone';
const releaseHandover = (dealId: string, key: string, token: string, deps: HandoverDeps, payer: string | null = PAYER) => release(dealId, key, token, payer, deps);

async function meetupSetup() {
  clock.at = new Date('2026-11-05T12:00:00Z');
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask: askWith(), now };
  const { deal, keys: rawKeys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, meet at the station on Saturday\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
  const keys = await openLinks(deal.id, rawKeys, deps);
  // The card's delivery is a meet-up (the mocked check always picks post, so set it here).
  await updateWithRetry(store, deal.id, (d) => ({ ...d, card: { ...d.card, delivery: { value: 'meetup', display: 'Meet up in person', source: { kind: 'message', messageId: 'm2' } } } }));
  await answerQuestion(deal.id, keys.seller, 'q_fee', 'seller', deps);
  await answerQuestion(deal.id, keys.buyer, 'q_fee', 'seller', deps);
  const s = await setPayee(deal.id, 'SELLER1', deps);
  await confirmCard(deal.id, keys.seller, cardHash(s.value), deps);
  const c = await confirmCard(deal.id, keys.buyer, cardHash(s.value), deps);
  const locked = c.value;
  await store.updateDeal(deal.id, c.version, { ...locked, order: { id: 'ORDER-1', cardHash: cardHash(locked), createdAt: clock.at.toISOString(), status: 'HOLD_REQUESTED', intent: 'AUTHORIZE' }, handover: { payer: { hash: payerHash(PAYER), at: clock.at.toISOString() } } });

  // PayPal, in memory: one order with one hold that can be captured or voided once.
  const state = { auth: 'CREATED', capture: undefined as Capture | undefined, failCapture: undefined as 'refuse' | 'lost' | undefined, captureStatus: 'COMPLETED' };
  const calls: string[] = [];
  const order = (): Order => ({
    id: 'ORDER-1',
    status: 'COMPLETED',
    payer: { payer_id: 'BUYER1' },
    purchase_units: [{
      custom_id: customIdFor(locked),
      amount: { currency_code: 'GBP', value: '350.00' },
      payee: { merchant_id: 'SELLER1' },
      payments: {
        authorizations: [{ id: 'AUTH-1', status: state.auth, amount: { currency_code: 'GBP', value: '350.00' }, create_time: '2026-11-05T12:00:00Z', expiration_time: '2026-12-04T12:00:00Z' }],
        ...(state.capture ? { captures: [state.capture] } : {}),
      },
    }],
  });
  const pp: HandoverPayPal = {
    async getOrder(id, seller) {
      calls.push(`get ${id} as ${seller}`);
      return { data: order(), debugId: 'dbg-get' };
    },
    async captureAuthorization(id, requestId, seller) {
      calls.push(`capture ${id} as ${seller} (${requestId})`);
      if (state.failCapture === 'refuse') throw new PayPalApiError(422, `/v2/payments/authorizations/${id}/capture`, 'no', 'dbg-refused');
      state.auth = 'CAPTURED';
      state.capture = { id: 'CAP-1', status: state.captureStatus, amount: { currency_code: 'GBP', value: '350.00' } };
      if (state.failCapture === 'lost') throw new PayPalApiError(500, `/v2/payments/authorizations/${id}/capture`, 'lost', 'dbg-lost');
      return { data: state.capture, debugId: 'dbg-capture' };
    },
    async voidAuthorization(id, requestId, seller) {
      calls.push(`void ${id} as ${seller} (${requestId})`);
      state.auth = 'VOIDED';
      return { data: { id, status: 'VOIDED' } satisfies Authorization, debugId: 'dbg-void' };
    },
  };
  const holdEvent = (id = 'WH-HOLD-1', authId = 'AUTH-1'): WebhookEvent => ({ id, event_type: 'PAYMENT.AUTHORIZATION.CREATED', resource: { id: authId, status: 'CREATED', custom_id: customIdFor(locked) } });
  const captureEvent = (id = 'WH-CAP-1'): WebhookEvent => ({ id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1', status: 'COMPLETED', custom_id: customIdFor(locked) } });
  const hdeps = { store, paypal: pp, now };
  const get = async () => (await store.getDeal(deal.id))!.value;
  const held = async () => applyVerifiedEvent(holdEvent(), hdeps);
  return { store, keys, dealId: deal.id, state, calls, pp, hdeps, holdEvent, captureEvent, get, held, locked };
}

test('a meet-up deal pays as a PayPal hold: AUTHORIZE order, then authorize (never capture) after approval', async () => {
  const s = await meetupSetup();
  // Back to before checkout.
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, order: undefined, handover: undefined }));
  let sent: OrderRequest | undefined;
  const calls: string[] = [];
  const paypal = {
    async createOrder(o: OrderRequest) {
      sent = o;
      return { data: { id: 'ORDER-2', status: 'PAYER_ACTION_REQUIRED' } as Order, debugId: 'dbg-create' };
    },
    async getOrder() {
      return { data: { id: 'ORDER-2', status: 'APPROVED', payer: { payer_id: 'BUYER1' }, purchase_units: [{ custom_id: customIdFor(await s.get()), amount: { currency_code: 'GBP', value: '350.00' }, payee: { merchant_id: 'SELLER1' } }] } as Order };
    },
    async captureOrder(): Promise<never> {
      calls.push('captureOrder');
      throw new Error('a meet-up deal must never be captured at checkout');
    },
    async authorizeOrder(id: string) {
      calls.push(`authorize ${id}`);
      return { data: { id, status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: 'AUTH-2', status: 'CREATED' }] } }] } as Order, debugId: 'dbg-auth' };
    },
  };
  const deps = { store: s.store, paypal, publicHost: 'https://x.test', now };
  const first = await startCheckout(s.dealId, s.keys.buyer, deps);
  assert.equal(sent?.intent, 'AUTHORIZE');
  assert.ok(first.payerSecret, 'the device that starts checkout gets the payer secret');
  assert.ok(!JSON.stringify(await s.get()).includes(first.payerSecret!), 'only its hash is stored');
  // Someone else holding the buyer link (its maker has both links) is refused before any hold.
  await assert.rejects(startCheckout(s.dealId, s.keys.buyer, deps), /started on another device/);
  await assert.rejects(captureCheckout(s.dealId, s.keys.buyer, 'ORDER-2', deps, 'guess'), /started on another device/);
  assert.deepEqual(calls, []);
  assert.equal((await startCheckout(s.dealId, s.keys.buyer, deps, first.payerSecret)).orderId, 'ORDER-2', 'the same device carries on');
  const out = await captureCheckout(s.dealId, s.keys.buyer, 'ORDER-2', deps, first.payerSecret);
  assert.deepEqual(calls, ['authorize ORDER-2']);
  assert.equal(out.status, 'HOLD_REQUESTED');
  assert.ok((await s.store.listReceipts(s.dealId)).some((r) => r.kind === 'order.hold_requested'));
});

test('the hold counts only after a verified hold webhook naming the hold a fresh GET shows', async () => {
  const s = await meetupSetup();
  assert.equal(isHeld(await s.get()), false);
  await applyVerifiedEvent(s.holdEvent('WH-OTHER', 'AUTH-OTHER'), s.hdeps);
  assert.equal(isHeld(await s.get()), false, 'an event for another hold is ignored');
  await s.held();
  assert.equal(isHeld(await s.get()), true);
  assert.equal(isPaid(await s.get()), false, 'a hold is not a payment');
  const seller = dealView(await s.get(), 'seller');
  assert.equal(seller.afterPayment?.handover?.state, 'held');
  assert.equal(seller.afterPayment?.gate, null, 'no ship gate for a handover');
  assert.equal(seller.terms.find((t) => t.key === 'shipBy')?.label, 'Meet by');
  assert.ok(!(await s.store.listReceipts(s.dealId)).some((r) => r.kind === 'gate.decided'));
});

test('only the buyer, with the code the seller shows, releases the money, once', async () => {
  const s = await meetupSetup();
  await assert.rejects(showHandoverCode(s.dealId, s.keys.seller, s.hdeps), /nothing to hand over/, 'no code before PayPal confirms the hold');
  await s.held();
  await assert.rejects(showHandoverCode(s.dealId, s.keys.buyer, s.hdeps), /only the seller/);
  const { token } = await showHandoverCode(s.dealId, s.keys.seller, s.hdeps);
  assert.ok(!JSON.stringify(await s.get()).includes(token), 'only the hash is stored');

  await assert.rejects(releaseHandover(s.dealId, s.keys.seller, token, s.hdeps), /only the buyer/, 'the seller can never take the money alone');
  // The buyer link without the paying phone's secret: e.g. the seller who made the link.
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps, null), /Only the phone that placed the PayPal hold/);
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps, 'another-phone'), /Only the phone that placed the PayPal hold/);
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, 'not-the-code', s.hdeps), /isn't the seller's current one/);
  assert.ok(!s.calls.some((c) => c.startsWith('capture')));

  await releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps);
  assert.deepEqual(s.calls.filter((c) => c.startsWith('capture')), ['capture AUTH-1 as SELLER1 (settle-handover-AUTH-1)']);
  assert.equal((await s.get()).handover?.outcome?.kind, 'released');
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps), /handover code|isn't the seller's/, 'the code is single-use');
  assert.equal(s.calls.filter((c) => c.startsWith('capture')).length, 1);

  // Paid only once PayPal's verified capture notification arrives, as for any deal.
  assert.equal(isPaid(await s.get()), false);
  await applyVerifiedEvent(s.captureEvent(), s.hdeps);
  assert.equal(isPaid(await s.get()), true);
  const kinds = (await s.store.listReceipts(s.dealId)).map((r) => r.kind);
  for (const k of ['handover.code_shown', 'handover.release_requested', 'handover.released']) assert.ok(kinds.includes(k), k);
});

test('an expired code, a changed card or a hold PayPal no longer shows: nothing is taken', async () => {
  const s = await meetupSetup();
  await s.held();
  const { token } = await showHandoverCode(s.dealId, s.keys.seller, s.hdeps);
  tick(CODE_TTL_MS + 1000);
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps), /expired/);

  const fresh = (await showHandoverCode(s.dealId, s.keys.seller, s.hdeps)).token;
  s.state.auth = 'VOIDED';
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, fresh, s.hdeps), /PayPal shows the hold as VOIDED/);
  s.state.auth = 'CREATED';

  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, card: { ...d.card, item: { ...d.card.item!, value: 'PS4' } } }));
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, fresh, s.hdeps), /card changed/);
  assert.ok(!s.calls.some((c) => c.startsWith('capture')));
  assert.ok((await s.store.listReceipts(s.dealId)).filter((r) => r.kind === 'handover.blocked').length >= 3);
});

test('PayPal refusing the capture leaves the money held; a lost answer is settled by a re-read', async () => {
  const s = await meetupSetup();
  await s.held();
  s.state.failCapture = 'refuse';
  const t1 = (await showHandoverCode(s.dealId, s.keys.seller, s.hdeps)).token;
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, t1, s.hdeps), /Nothing was taken/);
  assert.equal(isHeld(await s.get()), true, 'still held after a refusal');
  assert.equal((await s.get()).handover?.failed?.kind, 'release');

  s.state.failCapture = 'lost';
  const t2 = (await showHandoverCode(s.dealId, s.keys.seller, s.hdeps)).token;
  await releaseHandover(s.dealId, s.keys.buyer, t2, s.hdeps);
  assert.equal((await s.get()).handover?.outcome?.kind, 'released', 'the re-read shows PayPal took it');
});

test('walking away releases the hold; so does passing PayPal\'s 3-day guarantee', async () => {
  const s = await meetupSetup();
  await s.held();
  await cancelHandover(s.dealId, s.keys.buyer, s.hdeps);
  assert.deepEqual(s.calls.filter((c) => c.startsWith('void')), ['void AUTH-1 as SELLER1 (settle-void-AUTH-1)']);
  assert.deepEqual([(await s.get()).handover?.outcome?.kind, (await s.get()).handover?.outcome?.by], ['voided', 'buyer']);
  await assert.rejects(showHandoverCode(s.dealId, s.keys.seller, s.hdeps), /nothing to hand over/);
  assert.equal(dealView(await s.get(), 'buyer').afterPayment?.payment.state, 'voided');

  const e = await meetupSetup();
  await e.held();
  tick(2 * 24 * 3600_000);
  await releaseExpiredHold(await e.get(), e.hdeps);
  assert.equal((await e.get()).handover?.outcome, undefined, 'inside 3 days: still held');
  tick(24 * 3600_000 + 60_000);
  await releaseExpiredHold(await e.get(), e.hdeps);
  assert.equal((await e.get()).handover?.outcome?.by, 'meet_by_passed');
});

test('a PENDING capture is recorded as not completed, so nobody is told to hand over', async () => {
  const s = await meetupSetup();
  await s.held();
  s.state.captureStatus = 'PENDING';
  const { token } = await showHandoverCode(s.dealId, s.keys.seller, s.hdeps);
  const out = await releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps);
  assert.equal(out.captureStatus, 'PENDING');
  assert.equal((await s.get()).handover?.outcome?.captureStatus, 'PENDING');
  const seller = dealView(await s.get(), 'seller').afterPayment!;
  assert.equal(seller.handover?.state, 'pending');
  assert.notEqual(seller.payment.state, 'paid');
});

test('money taken outside the handover (e.g. in PayPal\'s own dashboard) never counts as paid', async () => {
  const s = await meetupSetup();
  await s.held();
  // PayPal shows a capture Settle never asked for.
  s.state.auth = 'CAPTURED';
  s.state.capture = { id: 'CAP-ROGUE', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '350.00' } };
  await applyVerifiedEvent({ ...s.captureEvent('WH-ROGUE'), resource: { id: 'CAP-ROGUE', status: 'COMPLETED', custom_id: customIdFor(s.locked) } }, s.hdeps);
  const d = await s.get();
  assert.equal(isPaid(d), false);
  const read = d.payment?.read;
  assert.ok(read?.ok && read.mismatches.some((m) => m.includes("without the buyer's handover")));
  assert.equal(dealView(d, 'buyer').afterPayment?.payment.state, 'problem', 'the buyer is shown the problem');
});

test('a fake message that PayPal is holding the money gets the answer from PayPal, and no handover code', async () => {
  const s = await meetupSetup();
  // No verified hold yet: whatever the message says, there is nothing to hand over.
  const answer = await paidCheck(s.dealId, s.keys.seller, 'PayPal: $350 is held for you. Hand the item over now.', { store: s.store, paypal: s.pp });
  assert.equal(answer.verdict, 'not_paid');
  await assert.rejects(showHandoverCode(s.dealId, s.keys.seller, s.hdeps), /nothing to hand over/);
});

test('a capture that appears while a release of the hold is being sent is still flagged', async () => {
  const s = await meetupSetup();
  await s.held();
  // Settle is releasing the hold (void in flight) when PayPal shows a capture instead.
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, handover: { ...d.handover, inFlight: { kind: 'void', at: clock.at.toISOString() } } }));
  s.state.auth = 'CAPTURED';
  s.state.capture = { id: 'CAP-ROGUE', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '350.00' } };
  await applyVerifiedEvent({ ...s.captureEvent('WH-ROGUE-2'), resource: { id: 'CAP-ROGUE', status: 'COMPLETED', custom_id: customIdFor(s.locked) } }, s.hdeps);
  const read = (await s.get()).payment?.read;
  assert.ok(read?.ok && read.mismatches.some((m) => m.includes("without the buyer's handover")));
  assert.equal(isPaid(await s.get()), false);
});

test('code review: a failed order creation claims nothing, so the buyer can simply try again', async () => {
  const s = await meetupSetup();
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, order: undefined, handover: undefined }));
  let fail = true;
  const paypal = {
    async createOrder() {
      if (fail) throw new PayPalApiError(503, '/v2/checkout/orders', 'down', 'dbg-down');
      return { data: { id: 'ORDER-3', status: 'PAYER_ACTION_REQUIRED' } as Order };
    },
    async getOrder(): Promise<never> { throw new Error('not used'); },
    async captureOrder(): Promise<never> { throw new Error('not used'); },
  };
  const deps = { store: s.store, paypal, publicHost: 'https://x.test', now };
  await assert.rejects(startCheckout(s.dealId, s.keys.buyer, deps), /down|503/);
  assert.equal((await s.get()).handover?.payer, undefined, 'nothing claimed');
  fail = false;
  const ok = await startCheckout(s.dealId, s.keys.buyer, deps);
  assert.ok(ok.payerSecret);
  assert.equal((await s.get()).order?.intent, 'AUTHORIZE');
  assert.ok((await s.store.listReceipts(s.dealId)).some((r) => r.kind === 'payer.claimed'), 'the claim writes a receipt');
});

test('code review: the seller is told "handed over" only after PayPal confirms the payment', async () => {
  const s = await meetupSetup();
  await s.held();
  const { token } = await showHandoverCode(s.dealId, s.keys.seller, s.hdeps);
  await releaseHandover(s.dealId, s.keys.buyer, token, s.hdeps);
  // Captured, but no verified capture notification yet.
  assert.equal(dealView(await s.get(), 'seller').afterPayment?.handover?.state, 'pending');
  await applyVerifiedEvent(s.captureEvent(), s.hdeps);
  assert.equal(dealView(await s.get(), 'seller').afterPayment?.handover?.state, 'released');
});

test('code review: a lost capture answer with a failed re-read is never a guess; the next read settles it', async () => {
  const s = await meetupSetup();
  await s.held();
  const { resolveInFlight } = await import('../lib/settle/handover');
  const { refreshPayment } = await import('../lib/settle/payment');
  // PayPal takes the money, but its answer and the re-read are both lost.
  let reads = 0;
  const flaky: HandoverPayPal = {
    ...s.pp,
    async getOrder(id, seller) {
      reads++;
      if (reads === 2) throw new PayPalApiError(503, '/v2/checkout/orders', 'down', 'dbg-down');
      return s.pp.getOrder(id, seller);
    },
  };
  s.state.failCapture = 'lost';
  const { token } = await showHandoverCode(s.dealId, s.keys.seller, s.hdeps);
  await assert.rejects(releaseHandover(s.dealId, s.keys.buyer, token, { ...s.hdeps, paypal: flaky }), /Couldn't confirm with PayPal/);
  assert.equal((await s.get()).handover?.inFlight?.kind, 'release', 'still checking, not "nothing taken"');
  assert.equal((await s.get()).handover?.failed, undefined);
  // The next fresh read shows the capture: recorded as released, and the capture isn't a mismatch.
  await refreshPayment(s.dealId, { kind: 'page' }, s.hdeps);
  await resolveInFlight(await s.get(), s.hdeps);
  assert.equal((await s.get()).handover?.outcome?.kind, 'released');
  await applyVerifiedEvent(s.captureEvent(), s.hdeps);
  assert.equal(isPaid(await s.get()), true);
});

test('code review: a meet-up deal paid by normal capture before holds existed keeps the normal rules', async () => {
  const s = await meetupSetup();
  // An old order: no intent recorded, captured the usual way, no handover.
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, order: { ...d.order!, intent: undefined, status: 'CAPTURE_REQUESTED' }, handover: undefined }));
  s.state.auth = 'CAPTURED';
  s.state.capture = { id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '350.00' } };
  await applyVerifiedEvent(s.captureEvent('WH-OLD'), s.hdeps);
  const d = await s.get();
  assert.equal(isPaid(d), true, 'no "taken without handover" mismatch');
  assert.ok(dealView(d, 'seller').afterPayment?.gate, 'the ship gate is still there');
  assert.equal(dealView(d, 'seller').afterPayment?.handover, null);
});

test('audit: a hold whose record drifted from the card can still be released to the buyer', async () => {
  const s = await meetupSetup();
  await s.held();
  // Simulate drift after the hold: the fresh read no longer matches the card.
  await updateWithRetry(s.store, s.dealId, (d) => ({ ...d, payment: { ...d.payment!, read: { ...d.payment!.read!, mismatches: ['payee differs'] } as never } }));
  await cancelHandover(s.dealId, s.keys.buyer, s.hdeps);
  assert.equal((await s.get()).handover?.outcome?.kind, 'voided');
});
