import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaypalClient } from 'paypal';
import { PayPalApiError } from '../lib/paypal';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { shipGate } from '../lib/settle/ship-gate';
import { addTracking } from '../lib/settle/shipping';
import { paidSetup } from './helpers/paid-deal';

// The SDK client is real; its fetch is fake (the SDK's own test seam). The first request a fresh
// client makes is the OAuth token POST. The fresh GET afterwards is the mocked plain-fetch getOrder.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

type Call = { url: URL; request: Request; body?: string };
function sdkOver(answer: (url: URL, request: Request, body?: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : await request.clone().text();
    const url = new URL(request.url);
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 });
    calls.push({ url, request, body });
    return answer(url, request, body);
  };
  const sdk = new PaypalClient({ oauth2: { clientId: 'id', clientSecret: 'secret' }, fetch, retry: { maxRetries: 0 }, logging: { level: 'off' } });
  return { sdk, calls };
}

const orderJson = { id: 'ORDER-1', status: 'COMPLETED' };

async function paid() {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  return t;
}
const showTracker = (t: Awaited<ReturnType<typeof paid>>, number: string) =>
  void (t.order.purchase_units![0].shipping!.trackers = [{ id: `CAP-1-${number}`, status: 'SHIPPED' }]);

test('adding tracking sends exactly the fields the sheet requires, as the seller, then the check passes once PayPal shows it', async () => {
  const t = await paid();
  const { sdk, calls } = sdkOver(() => {
    showTracker(t, 'AB123456789GB');
    return Response.json(orderJson, { headers: { 'paypal-debug-id': 'dbg-track' } });
  });
  const deal = (await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'ab 123456789 gb' }, { ...t.pdeps, sdk })).value;

  assert.equal(calls.length, 1);
  const { url, request, body } = calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
  assert.equal(url.pathname, '/v2/checkout/orders/ORDER-1/track');
  assert.equal(request.headers.get('authorization'), 'Bearer T');
  const assertion = request.headers.get('paypal-auth-assertion')!;
  assert.equal(JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()).payer_id, 'SELLER1');
  // No field of ours without a sheet row (items stays out). notify_payer: false is the SDK's own
  // schema default for an omitted field, matching PayPal's documented default.
  assert.deepEqual(JSON.parse(body!), { capture_id: 'CAP-1', tracking_number: 'AB123456789GB', carrier: 'ROYAL_MAIL', notify_payer: false });

  assert.equal(deal.shipping!.tracking!.state, 'sent');
  assert.equal(deal.shipping!.tracking!.debugId, 'dbg-track');
  assert.equal(shipGate(deal).checks.find((c) => c.id === 'tracking')!.status, 'pass');
  const r = (await t.store.listReceipts(t.dealId)).findLast((x) => x.kind === 'tracking.added')!;
  assert.equal(r.data.via, 'paypal-server-sdk');
  assert.equal(r.data.seenOnOrder, true);
});

test('accepted but not yet on the order: sent, and the check waits', async () => {
  const t = await paid();
  const { sdk } = sdkOver(() => Response.json(orderJson));
  const deal = (await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk })).value;
  assert.equal(deal.shipping!.tracking!.state, 'sent');
  assert.equal(shipGate(deal).checks.find((c) => c.id === 'tracking')!.status, 'not_yet');
});

test('invariants are checked before any call: paid, seller, a listed carrier, a sane number', async () => {
  const t0 = await paidSetup();
  const { sdk, calls } = sdkOver(() => Response.json(orderJson));
  await assert.rejects(addTracking(t0.dealId, t0.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t0.pdeps, sdk }), /confirmed the payment/);
  const t = await paid();
  await assert.rejects(addTracking(t.dealId, t.keys.buyer, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), /only the seller/);
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'USPS', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), /pick a carrier/);
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: '<script>' }, { ...t.pdeps, sdk }), /tracking number/);
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'OTHER', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), /name the carrier/);
  assert.equal(calls.length, 0);
  assert.equal((await t.get()).shipping?.tracking, undefined);
});

test('a 422 from PayPal is refused with its reason, and the claim is released', async () => {
  const t = await paid();
  const { sdk } = sdkOver(() =>
    Response.json({ name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: 'dbg-422', details: [{ issue: 'INVALID_TRACKING', description: 'Tracking number is invalid.' }] }, { status: 422 }),
  );
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), /Tracking number is invalid/);
  assert.equal((await t.get()).shipping?.tracking, undefined);
  const r = (await t.store.listReceipts(t.dealId)).findLast((x) => x.kind === 'tracking.failed')!;
  assert.equal(r.data.status, 422);
  assert.equal(r.data.debugId, 'dbg-422');
});

test('a 403 (our access for this seller) becomes a PayPal error, not the caller\'s fault', async () => {
  const t = await paid();
  const { sdk } = sdkOver(() => Response.json({ name: 'PERMISSION_DENIED', message: 'No permission', debug_id: 'dbg-403' }, { status: 403 }));
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), PayPalApiError);
});

test('a dropped connection re-reads the order: found means sent, not found means unknown and a retry checks first', async () => {
  const t = await paid();
  const { sdk, calls } = sdkOver(() => {
    showTracker(t, 'AB123456789GB');
    throw new Error('ECONNRESET');
  });
  const getsBefore = t.calls.length;
  const deal = (await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk })).value;
  assert.equal(t.calls.length, getsBefore + 1, 'the order was re-read');
  assert.equal(deal.shipping!.tracking!.state, 'sent');
  assert.equal(calls.length, 1);

  const t2 = await paid();
  const lost = sdkOver(() => { throw new Error('ECONNRESET'); });
  await assert.rejects(addTracking(t2.dealId, t2.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t2.pdeps, sdk: lost.sdk }), /didn't answer/);
  let d2 = await t2.get();
  assert.equal(d2.shipping!.tracking!.state, 'unknown');
  assert.equal(shipGate(d2).checks.find((c) => c.id === 'tracking')!.status, 'cant_check');
  // It had gone through after all: the retry sees it on the order and sends nothing.
  showTracker(t2, 'AB123456789GB');
  d2 = (await addTracking(t2.dealId, t2.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t2.pdeps, sdk: lost.sdk })).value;
  assert.equal(d2.shipping!.tracking!.state, 'sent');
  assert.equal(lost.calls.length, 1);
});

test('credentials that cannot be obtained: never sent, no re-read, claim released', async () => {
  const t = await paid();
  const fetch: typeof globalThis.fetch = async () => Response.json({ error: 'invalid_client' }, { status: 401 });
  const sdk = new PaypalClient({ oauth2: { clientId: 'id', clientSecret: 'bad' }, fetch, retry: { maxRetries: 0 }, logging: { level: 'off' } });
  const getsBefore = t.calls.length;
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk }), /not sent: auth/);
  assert.equal(t.calls.length, getsBefore, 'no re-read for a request that never left');
  assert.equal((await t.get()).shipping?.tracking, undefined);
});

test('a second number after tracking was sent is refused without calling PayPal', async () => {
  const t = await paid();
  const { sdk, calls } = sdkOver(() => Response.json(orderJson));
  await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk });
  await assert.rejects(addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'ZZ999999999GB' }, { ...t.pdeps, sdk }), /already added/);
  assert.equal(calls.length, 1);
});
