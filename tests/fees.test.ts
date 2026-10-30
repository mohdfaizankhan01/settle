import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feeOf, fromMinor, moneyFor, toMinor } from '../lib/settle/fees';

// Rates from docs/fees.md: US 3.49% + 0.49 USD, UK 2.9% + 0.30 GBP.

test('seller pays: the buyer pays the price and the seller gets price minus fee', () => {
  assert.deepEqual(moneyFor('100.00', 'seller', 'US'), { total: '100.00', fee: '3.98', sellerGets: '96.02' });
  assert.deepEqual(moneyFor('350.00', 'seller', 'UK'), { total: '350.00', fee: '10.45', sellerGets: '339.55' });
});

test('buyer pays: the smallest total that leaves the seller at least the price', () => {
  for (const country of ['US', 'UK'] as const) {
    for (const price of ['1.00', '9.99', '100.00', '350.00', '1234.56']) {
      const m = moneyFor(price, 'buyer', country);
      const total = toMinor(m.total);
      assert.ok(total - feeOf(total, country) >= toMinor(price), `${country} ${price}`);
      assert.ok(total - 1 - feeOf(total - 1, country) < toMinor(price), `${country} ${price} is minimal`);
      assert.equal(toMinor(m.total) - toMinor(m.fee), toMinor(price));
    }
  }
});

test('amounts are strict two-decimal strings', () => {
  assert.equal(fromMinor(5), '0.05');
  assert.throws(() => toMinor('1.5'));
});
