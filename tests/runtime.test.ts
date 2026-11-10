import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonBody, limitedKey, rateLimited } from '../lib/settle/runtime';

const req = (xff: string) => new Request('http://x/', { headers: { 'x-forwarded-for': xff } });

test('the limit keys on the proxy-added address, so a forged leftmost entry does not reset it', () => {
  for (let i = 0; i < 3; i++) assert.equal(rateLimited(req(`10.0.0.${i}, 203.0.113.9`), 'b1', 3), false);
  assert.equal(rateLimited(req('1.2.3.4, 203.0.113.9'), 'b1', 3), true);
  assert.equal(rateLimited(req('203.0.113.10'), 'b1', 3), false);
});

test('a global cap applies across addresses only when asked for', () => {
  for (let i = 0; i < 20; i++) rateLimited(req(`198.51.100.${i}`), 'b2', 2, 20);
  assert.equal(rateLimited(req('198.51.100.200'), 'b2', 2, 20), true);
  for (let i = 0; i < 20; i++) rateLimited(req(`198.51.100.${i}`), 'b3', 2);
  assert.equal(rateLimited(req('198.51.100.200'), 'b3', 2), false);
});

test('audit: a JSON body over the cap is refused without reading it all', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += chunk.byteLength;
      if (pulled > 8 * 1024 * 1024) c.close();
      else c.enqueue(chunk);
    },
  });
  const request = new Request('http://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(jsonBody(request), /request too large/);
  assert.ok(pulled < 256 * 1024, `stopped after ${pulled} bytes, not 8 MiB`);
  assert.deepEqual(await jsonBody(new Request('http://x', { method: 'POST', body: '{"a":1}' })), { a: 1 });
});

test('audit: per-key limits count across addresses; per-address limits have no shared cap', () => {
  const key = `test-deal-${Date.now()}`;
  for (let i = 0; i < 6; i++) assert.equal(limitedKey(key, 6), false);
  assert.equal(limitedKey(key, 6), true);
  const req = (ip: string) => new Request('http://x', { headers: { 'x-forwarded-for': ip } });
  const bucket = `audit-${Date.now()}`;
  for (let i = 0; i < 40; i++) assert.equal(rateLimited(req(`10.9.${i}.1`), bucket, 5), false, 'no global cap blocks a new address');
});
