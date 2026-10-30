import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { authAssertion, createOrder, getOrder, PayPalApiError, sellerByTrackingId, verifyWebhookSignature } from '../lib/paypal';

// PayPal is mocked by replacing fetch: the token call, then the verify call.

type Call = { url: string; init: RequestInit };
let calls: Call[];
const realFetch = globalThis.fetch;

function mockPayPal(verifyResponse: () => Response) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    return verifyResponse();
  }) as typeof fetch;
}

// Formatting JSON.parse + JSON.stringify would change: 1.0, an escaped é, and spacing.
const event = '{"id": "WH-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {"id": "CAP-1", "amount": 1.0, "note": "caf\\u00e9"}}';

const signedHeaders = () =>
  new Headers({
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig-1',
    'paypal-transmission-time': '2026-10-18T12:00:00Z',
  });

beforeEach(() => {
  calls = [];
  process.env.PAYPAL_CLIENT_ID = 'id';
  process.env.PAYPAL_SECRET = 'secret';
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('sends every transmission header, the webhook ID and the event to verify-webhook-signature', async () => {
  mockPayPal(() => Response.json({ verification_status: 'SUCCESS' }));

  assert.equal(await verifyWebhookSignature(signedHeaders(), event, 'WEBHOOK1'), 'SUCCESS');

  const verify = calls.find((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature'));
  assert.ok(verify, 'verify endpoint was called');
  assert.equal(verify.init.method, 'POST');
  const headers = verify.init.headers as Record<string, string>;
  assert.match(headers['PayPal-Request-Id'], /^[0-9a-f-]{36}$/);
  const sent = verify.init.body as string;
  assert.deepEqual(JSON.parse(sent), {
    auth_algo: 'SHA256withRSA',
    cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    transmission_id: 'tx-1',
    transmission_sig: 'sig-1',
    transmission_time: '2026-10-18T12:00:00Z',
    webhook_id: 'WEBHOOK1',
    webhook_event: JSON.parse(event),
  });
  assert.ok(sent.endsWith(`"webhook_event":${event}}`), 'the event bytes are sent exactly as received');
});

test('a FAILURE from PayPal is FAILURE', async () => {
  mockPayPal(() => Response.json({ verification_status: 'FAILURE' }));
  assert.equal(await verifyWebhookSignature(signedHeaders(), event, 'WEBHOOK1'), 'FAILURE');
});

test('missing signature headers fail without calling PayPal', async () => {
  mockPayPal(() => Response.json({ verification_status: 'SUCCESS' }));
  const headers = signedHeaders();
  headers.delete('paypal-transmission-sig');

  assert.equal(await verifyWebhookSignature(headers, event, 'WEBHOOK1'), 'FAILURE');
  assert.equal(calls.length, 0);
});

test('a PayPal error throws with its debug ID, retrying with the same request ID', async () => {
  mockPayPal(() => new Response('{"name":"INTERNAL_SERVER_ERROR"}', { status: 500, headers: { 'paypal-debug-id': 'dbg-123' } }));

  await assert.rejects(verifyWebhookSignature(signedHeaders(), event, 'WEBHOOK1'), (error: unknown) => {
    assert.ok(error instanceof PayPalApiError);
    assert.equal(error.status, 500);
    assert.equal(error.debugId, 'dbg-123');
    return true;
  });

  const requestIds = calls
    .filter((c) => c.url.endsWith('/verify-webhook-signature'))
    .map((c) => (c.init.headers as Record<string, string>)['PayPal-Request-Id']);
  assert.equal(requestIds.length, 4);
  assert.equal(new Set(requestIds).size, 1);
});

test('a 401 refreshes the token once without using up a 5xx retry', async () => {
  let verifyCalls = 0;
  mockPayPal(() => {
    verifyCalls++;
    if (verifyCalls === 1) return new Response('{}', { status: 401 });
    if (verifyCalls <= 4) return new Response('{}', { status: 503 });
    return Response.json({ verification_status: 'SUCCESS' });
  });

  assert.equal(await verifyWebhookSignature(signedHeaders(), event, 'WEBHOOK1'), 'SUCCESS');
  assert.equal(verifyCalls, 5);
  const firstVerify = calls.findIndex((c) => c.url.endsWith('/verify-webhook-signature'));
  assert.ok(calls[firstVerify + 1].url.endsWith('/v1/oauth2/token'), 'a new token is fetched after the 401');
});

test('the auth assertion is an unsigned JWT naming our client ID and the seller', () => {
  const [header, payload, signature] = authAssertion('SELLER1').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'none' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), { iss: 'id', payer_id: 'SELLER1' });
  assert.equal(signature, '');
});

test('createOrder sends the card fields, our request ID, and returns the debug ID', async () => {
  mockPayPal(() => Response.json({ id: 'O-1', status: 'CREATED' }, { headers: { 'paypal-debug-id': 'dbg-9' } }));
  const result = await createOrder(
    {
      dealId: 'd1',
      customId: 'd1:abc',
      payeeMerchantId: 'SELLER1',
      amount: { currency_code: 'GBP', value: '350.00' },
      items: [{ name: 'PS5', description: 'Settle deal d1', amount: { currency_code: 'GBP', value: '350.00' } }],
      physical: true,
      returnUrl: 'https://settle.test/d/d1',
      cancelUrl: 'https://settle.test/d/d1',
    },
    'req-1',
  );
  assert.deepEqual(result, { data: { id: 'O-1', status: 'CREATED' }, debugId: 'dbg-9' });
  const call = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
  assert.equal((call.init.headers as Record<string, string>)['PayPal-Request-Id'], 'req-1');
  const unit = JSON.parse(call.init.body as string).purchase_units[0];
  assert.equal(unit.custom_id, 'd1:abc');
  assert.deepEqual(unit.payee, { merchant_id: 'SELLER1' });
  assert.deepEqual(unit.items[0].unit_amount, { currency_code: 'GBP', value: '350.00' });
  assert.equal(unit.items[0].category, 'PHYSICAL_GOODS');
});

test('getOrder reads as the seller with PayPal-Auth-Assertion', async () => {
  mockPayPal(() => Response.json({ id: 'O-1', status: 'APPROVED' }));
  await getOrder('O-1', 'SELLER1');
  const call = calls.find((c) => c.url.endsWith('/v2/checkout/orders/O-1'))!;
  assert.equal(call.init.method, 'GET');
  assert.equal((call.init.headers as Record<string, string>)['PayPal-Auth-Assertion'], authAssertion('SELLER1'));
});

test('sellerByTrackingId reads the merchant ID back from PayPal and checks our grant', async () => {
  process.env.PAYPAL_PARTNER_MERCHANT_ID = 'PARTNER1';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('?tracking_id=')) return Response.json({ merchant_id: 'SELLER1', tracking_id: 't1' });
    return Response.json({
      merchant_id: 'SELLER1',
      payments_receivable: true,
      primary_email_confirmed: true,
      oauth_integrations: [{ integration_type: 'OAUTH_THIRD_PARTY', oauth_third_party: [{ partner_client_id: 'id' }] }],
    });
  }) as typeof fetch;
  assert.deepEqual(await sellerByTrackingId('t1'), { merchantId: 'SELLER1', paymentsReceivable: true, primaryEmailConfirmed: true, granted: true });
  assert.ok(calls.some((c) => c.url.includes('/v1/customer/partners/PARTNER1/merchant-integrations?tracking_id=t1')));
});

test('sellerByTrackingId is undefined while PayPal has no seller for the tracking ID', async () => {
  process.env.PAYPAL_PARTNER_MERCHANT_ID = 'PARTNER1';
  mockPayPal(() => new Response('{"name":"RESOURCE_NOT_FOUND"}', { status: 404 }));
  assert.equal(await sellerByTrackingId('t1'), undefined);
});
