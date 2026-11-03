import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PayPalApiError } from '../lib/paypal';
import { handleWebhook, readBodyLimited } from '../lib/settle/webhook';

// verify-webhook-signature is mocked; only SUCCESS may count as verified.

const body = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-1' } });
const headers = new Headers();
const deps = (verify: () => Promise<'SUCCESS' | 'FAILURE'>, webhookId: string | undefined = 'WEBHOOK1') => ({
  verify,
  webhookId,
});

test('a SUCCESS verification is verified, with 200', async () => {
  const result = await handleWebhook(body, headers, deps(async () => 'SUCCESS'));
  assert.deepEqual(result, { status: 200, outcome: 'verified', eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', event: JSON.parse(body) });
});

test('a forged or bad signature is rejected, with 400', async () => {
  const result = await handleWebhook(body, headers, deps(async () => 'FAILURE'));
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.status, 400);
});

test('a body that is not a PayPal event is rejected without calling PayPal', async () => {
  let called = false;
  const verify = async () => {
    called = true;
    return 'SUCCESS' as const;
  };
  for (const bad of ['not json', 'null', '{}', '{"id":"WH-1"}', '[]']) {
    const result = await handleWebhook(bad, headers, deps(verify));
    assert.equal(result.outcome, 'rejected', bad);
    assert.equal(result.status, 400, bad);
  }
  assert.equal(called, false);
});

test('no webhook ID configured is unverifiable, with 503 so PayPal retries', async () => {
  const result = await handleWebhook(body, headers, { verify: async () => 'SUCCESS', webhookId: undefined });
  assert.equal(result.outcome, 'unverifiable');
  assert.equal(result.status, 503);
});

test('a PayPal error during verification is unverifiable, never verified, and keeps the debug ID', async () => {
  const result = await handleWebhook(
    body,
    headers,
    deps(async () => {
      throw new PayPalApiError(500, '/v1/notifications/verify-webhook-signature', 'boom', 'dbg-9');
    }),
  );
  assert.equal(result.outcome, 'unverifiable');
  assert.equal(result.status, 503);
  assert.equal(result.debugId, 'dbg-9');
});

test('a body over the cap is refused, whether or not it declares its length', async () => {
  const big = 'x'.repeat(2000);
  assert.equal(await readBodyLimited(new Request('http://x', { method: 'POST', body: big }), 1000), undefined);

  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(400)));
      controller.close();
    },
  });
  const chunked = new Request('http://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(await readBodyLimited(chunked, 1000), undefined);
});

test('a body under the cap is read exactly', async () => {
  assert.equal(await readBodyLimited(new Request('http://x', { method: 'POST', body })), body);
});
