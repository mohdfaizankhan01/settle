import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { PayPalApiError, verifyWebhookSignature, type WebhookEvent } from '../lib/paypal';

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

const event: WebhookEvent = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } };

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
  assert.deepEqual(JSON.parse(verify.init.body as string), {
    auth_algo: 'SHA256withRSA',
    cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    transmission_id: 'tx-1',
    transmission_sig: 'sig-1',
    transmission_time: '2026-10-18T12:00:00Z',
    webhook_id: 'WEBHOOK1',
    webhook_event: event,
  });
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
