import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimited } from '../lib/settle/runtime';

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
