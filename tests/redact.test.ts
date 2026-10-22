import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../lib/settle/chat';
import { parsePrice, redactChat } from '../lib/settle/redact';

const msg = (text: string, role: ChatMessage['role'] = 'buyer', speaker = role === 'seller' ? 'Alex Smith' : 'Sam Jones'): ChatMessage => ({
  id: 'm1',
  speaker,
  role,
  text,
});
const one = (text: string, role?: ChatMessage['role']) => redactChat([msg(text, role)]);

test('personal details are removed', () => {
  const { messages, tokens } = one(
    'email me at sam.j@gmail.com or call +44 7700 900123. Card 4111 1111 1111 1111, IBAN GB29NWBK60161331926819, sort code 60-16-13, btc bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  );
  assert.equal(
    messages[0].text,
    'email me at [EMAIL] or call [PHONE]. Card [CARD], IBAN [IBAN], sort code [SORTCODE], btc [WALLET]',
  );
  assert.equal(tokens.length, 0);
});

test('speaker names become their role; ordinary words are kept', () => {
  const { messages } = redactChat([msg('hi Sam, Alex here. Tell me, what about you?', 'seller')].concat(msg('ok')));
  assert.equal(messages[0].text, 'hi [BUYER], [SELLER] here. Tell me, what about you?');
});

test('extra names are replaced with [NAME]', () => {
  assert.equal(redactChat([msg('send it to Priya please')], ['Priya']).messages[0].text, 'send it to [NAME] please');
});

test('prices become tokens with amount and currency kept in code', () => {
  const { messages, tokens } = one('I can do £1,200.50, or 300 quid, or $95, or 80 EUR. Final offer 250?');
  assert.equal(messages[0].text, 'I can do [PRICE_1], or [PRICE_2], or [PRICE_3], or [PRICE_4]. Final offer [PRICE_5]?');
  assert.deepEqual(
    tokens.map((t) => [t.raw, t.amount, t.currency]),
    [
      ['£1,200.50', '1200.50', 'GBP'],
      ['300 quid', '300.00', 'GBP'],
      ['$95', '95.00', 'USD'],
      ['80 EUR', '80.00', 'EUR'],
      ['250', '250.00', undefined],
    ],
  );
});

test('product numbers and units are not prices', () => {
  const { messages, tokens } = one('iPhone 13 with 128 GB, 2 years old, for 400');
  assert.equal(messages[0].text, 'iPhone 13 with 128 GB, 2 years old, for [PRICE_1]');
  assert.equal(tokens[0].amount, '400.00');
});

test('a decimal price is not mistaken for a date', () => {
  const { tokens } = one('£12.50 posted');
  assert.deepEqual(tokens.map((t) => [t.kind, t.raw]), [['PRICE', '£12.50']]);
});

test('dates become tokens', () => {
  const { messages } = one('ship by 12/11, or 3rd November 2026, or Nov 5, or tomorrow, or 2026-11-20');
  assert.equal(messages[0].text, 'ship by [DATE_1], or [DATE_2], or [DATE_3], or [DATE_4], or [DATE_5]');
});

test('links become tokens labelled PayPal or not by exact host', () => {
  const { messages, tokens } = one('pay here https://paypal.me/alex or www.paypal-secure-pay.com/x or cash.app/$alex');
  assert.equal(
    messages[0].text,
    'pay here [LINK_1 (PayPal)] or [LINK_2 (not PayPal)] or [LINK_3 (not PayPal)]',
  );
  assert.deepEqual(tokens.map((t) => [t.host, t.isPayPal]), [
    ['paypal.me', true],
    ['www.paypal-secure-pay.com', false],
    ['cash.app', false],
  ]);
});

test('postcodes, ZIPs and street addresses', () => {
  const { messages, tokens } = one('send to 12 Baker Street, London NW1 6XE. Or 1 Main St, Austin TX 78701. PS5 2TB edition');
  assert.equal(messages[0].text, 'send to [ADDRESS], London [POSTCODE_1]. Or [ADDRESS], Austin TX [ZIP_1]. PS5 2TB edition');
  assert.deepEqual(tokens.map((t) => t.raw), ['NW1 6XE', '78701']);
});

test('one-time codes and long numbers are removed', () => {
  assert.equal(one('the code is 482913').messages[0].text, 'the code is [NUMBER]');
});

test('tokens are numbered across messages in chat order', () => {
  const { tokens } = redactChat([
    { ...msg('£100?'), id: 'm1' },
    { ...msg('£90', 'seller'), id: 'm2' },
  ]);
  assert.deepEqual(tokens.map((t) => [t.id, t.messageId]), [
    ['PRICE_1', 'm1'],
    ['PRICE_2', 'm2'],
  ]);
});

test('parsePrice', () => {
  assert.deepEqual(parsePrice('C$ 40'), { amount: '40.00', currency: 'CAD' });
  assert.deepEqual(parsePrice('75 bucks'), { amount: '75.00', currency: 'USD' });
});
