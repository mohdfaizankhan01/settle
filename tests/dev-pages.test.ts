import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devPagesEnabled } from '../lib/settle/dev-pages';

test('dev pages are on outside production', () => {
  assert.equal(devPagesEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(devPagesEnabled({}), true);
});

test('dev pages are off in production by default', () => {
  assert.equal(devPagesEnabled({ NODE_ENV: 'production' }), false);
});

test('only SETTLE_DEV_PAGES=1 turns them on in production', () => {
  assert.equal(devPagesEnabled({ NODE_ENV: 'production', SETTLE_DEV_PAGES: '1' }), true);
  for (const value of ['', '0', 'true', 'yes', ' 1']) {
    assert.equal(devPagesEnabled({ NODE_ENV: 'production', SETTLE_DEV_PAGES: value }), false, value);
  }
});
