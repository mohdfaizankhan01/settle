import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET } from '../app/api/health/route';
import { warmLocalModel } from '../lib/model/local-check';

test('health answers ok without caching', async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true });
});

test('model warm-up never throws (model A has no download)', async () => {
  const before = process.env.SETTLE_MODEL;
  process.env.SETTLE_MODEL = 'a';
  try {
    assert.equal(await warmLocalModel(), true);
  } finally {
    if (before === undefined) delete process.env.SETTLE_MODEL;
    else process.env.SETTLE_MODEL = before;
  }
});
