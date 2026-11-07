import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactChat } from '../lib/settle/redact';
import { ruleWarnings } from '../lib/settle/rules';

const seller = (text: string) => ruleWarnings(redactChat([{ id: 'm1', speaker: 'Alex', role: 'seller', text }]).messages);
const signals = (text: string) => seller(text).map((w) => w.signalId);
const buyer = (text: string) => ruleWarnings(redactChat([{ id: 'm1', speaker: 'Sam', role: 'buyer', text }]).messages).map((w) => w.signalId);

test('honest refusals of Friends and Family or off-PayPal methods raise no keyword warning', () => {
  for (const text of [
    "PayPal goods and services please, not friends and family, so we're both covered",
    'no friends and family, sorry',
    "I won't do F&F, goods and services only",
    'please do not send it as a gift',
    'goods and services instead of friends & family',
    "I don't take Zelle or Venmo, PayPal checkout only",
    'never pay by bank transfer for stuff like this',
    "can't accept crypto",
  ]) assert.deepEqual(signals(text), [], text);
});

test('the same words without a refusal still warn', () => {
  assert.deepEqual(signals('send it friends and family please'), ['ff_payment']);
  assert.deepEqual(signals('not goods and services, friends and family'), ['ff_payment']);
  assert.deepEqual(signals('not G&S just F&F'), ['ff_payment']);
  assert.deepEqual(signals('no fees if you send it as a gift'), ['ff_payment']);
  assert.deepEqual(signals("don't worry send as a gift"), ['ff_payment']);
  assert.deepEqual(signals('no need for goods and services, friends and family is fine'), ['ff_payment']);
  assert.deepEqual(signals("don't use paypal, zelle me"), ['off_paypal']);
  assert.deepEqual(signals("I don't take Zelle, Venmo is fine"), ['off_paypal']);
  // A comma list reads the same as the line above, so unsure means warn.
  assert.deepEqual(signals("I don't take Zelle, Cash App or Venmo"), ['off_paypal']);
});

test('a refused method and an asked-for one in the same message: the asked-for one warns', () => {
  const w = seller("I don't take Zelle, send bitcoin");
  assert.deepEqual(w.map((x) => [x.signalId, x.matched]), [['off_paypal', 'bitcoin']]);
});

test('refusal words never switch off the code, injection or bank-detail rules', () => {
  assert.deepEqual(buyer("don't share the code with anyone, just send code to me"), ['code_request']);
  assert.deepEqual(buyer('never mind, send me the code'), ['code_request']);
  assert.deepEqual(signals('not IBAN GB29NWBK60161331926819'), ['off_paypal']);
});

test('onlyRefused: the model score is ignored only when every method named is refused', async () => {
  const { onlyRefused } = await import('../lib/settle/rules');
  assert.equal(onlyRefused('ff_payment', 'not friends and family, goods and services'), true);
  assert.equal(onlyRefused('off_paypal', "I don't take Zelle or Venmo"), true);
  // No method named: the model decides ("pay me as a present").
  assert.equal(onlyRefused('ff_payment', 'pay me as a present so no fees'), false);
  // One refused, one asked for.
  assert.equal(onlyRefused('off_paypal', "I don't take Zelle, send bitcoin"), false);
  // Bank details always count.
  assert.equal(onlyRefused('off_paypal', "I don't take Zelle, IBAN [IBAN]"), false);
  // Signals without refusable rules never skip the model.
  assert.equal(onlyRefused('ship_elsewhere', 'not to my cousin'), false);
  assert.equal(onlyRefused('code_request', "don't send me the code"), false);
});
