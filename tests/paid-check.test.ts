import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paidCheck } from '../lib/settle/paid-check';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { paidSetup } from './helpers/paid-deal';

// PayPal mocked. The answer comes only from PayPal's order; the pasted text never decides it.

const FAKE_EMAIL = `PayPal: You've received £350.00 from Sam.
Transaction ID: 9XK12345AB678901C
The funds are on hold until you send the tracking number. Log in: paypa1-secure.com/release`;

test('a fake "payment received" email on an unpaid deal is not paid, with the mismatches named', async () => {
  const t = await paidSetup();
  const r = await paidCheck(t.dealId, t.keys.seller, FAKE_EMAIL, t.pdeps);
  assert.equal(r.verdict, 'not_paid');
  const notes = r.notes.join(' ');
  assert.match(notes, /not PayPal's record/);
  assert.match(notes, /9XK12345AB678901C/);
  assert.match(notes, /paypa1-secure\.com/);
  assert.match(notes, /held until you ship/);
  // The pasted text is never stored.
  const receipts = JSON.stringify(await t.store.listReceipts(t.dealId));
  assert.doesNotMatch(receipts, /9XK12345AB678901C|paypa1/);
  assert.match(receipts, /"verdict":"not_paid"/);
});

test('a paid deal is paid, even if the pasted text is wrong, and the differences are still shown', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  const r = await paidCheck(t.dealId, t.keys.seller, 'You received £35.00, transaction 9XK12345AB678901C', t.pdeps);
  assert.equal(r.verdict, 'paid');
  assert.match(r.answer, /CAP-1/);
  assert.match(r.notes.join(' '), /£35\.00/);
});

test('PayPal unreachable is "can\'t check", never "not paid" or "paid"', async () => {
  const t = await paidSetup();
  t.failGet(true);
  const r = await paidCheck(t.dealId, t.keys.seller, FAKE_EMAIL, t.pdeps);
  assert.equal(r.verdict, 'cant_check');
});

test('a capture PayPal shows completed but with no verified event yet is not paid', async () => {
  const t = await paidSetup();
  const r = await paidCheck(t.dealId, t.keys.seller, '', t.pdeps);
  assert.equal(r.verdict, 'not_paid');
  assert.deepEqual(r.notes, []);
});

test('only the seller can run it, and the paste is bounded', async () => {
  const t = await paidSetup();
  await assert.rejects(paidCheck(t.dealId, t.keys.buyer, 'x', t.pdeps), /only the seller/);
  await assert.rejects(paidCheck(t.dealId, t.keys.seller, 'x'.repeat(5000), t.pdeps), /at most/);
});

test('a paid deal is re-read every time: a refund since then answers not paid', async () => {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  t.order.purchase_units![0].payments!.captures![0].status = 'REFUNDED';
  const r = await paidCheck(t.dealId, t.keys.seller, '', t.pdeps);
  assert.equal(r.verdict, 'not_paid');
});
