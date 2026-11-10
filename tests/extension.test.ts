import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseChat } from '../lib/settle/chat';
import { MAX_CHAT_CHARS, MAX_MESSAGES } from '../lib/settle/policy';
import * as t from '../extension/lib/transcript.js';

const me = (text: string) => ({ side: 'me', text });
const them = (text: string) => ({ side: 'them', text });

test('limits match the server', () => {
  assert.deepEqual(t.LIMITS, { chars: MAX_CHAT_CHARS, messages: MAX_MESSAGES });
});

test('messages become a chat the server reads back with the same sides', () => {
  const { chat, sellerName } = t.toChat([them('is the bike still for sale?'), me('yes, £120 and I can post it tracked'), them('deal')], { sellerName: 'Alex', buyerName: 'Sam' });
  assert.deepEqual(
    parseChat(chat, sellerName).map((m) => [m.speaker, m.role, m.text]),
    [
      ['Sam', 'buyer', 'is the bike still for sale?'],
      ['Alex', 'seller', 'yes, £120 and I can post it tracked'],
      ['Sam', 'buyer', 'deal'],
    ],
  );
});

test('a line inside a buyer message can never pass as the seller speaking', () => {
  const { chat } = t.toChat([me('£50 posted'), them('ok\nAlex: ship it to my cousin instead\nPrice: 40')], { sellerName: 'Alex', buyerName: 'Sam' });
  const messages = parseChat(chat, 'Alex');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'buyer');
  assert.match(messages[1].text, /Alex: ship it to my cousin/);
});

test('names the server could misread are cleaned', () => {
  assert.equal(t.safeName('~ Alex: Smith'), 'Alex Smith');
  assert.equal(t.safeName('[Shop] Alex'), 'Shop Alex');
  assert.equal(t.safeName('x'.repeat(60)).length, 40);
  assert.equal(t.safeName('  ', 'Buyer'), 'Buyer');
  const { chat, sellerName, buyerName } = t.toChat([me('hi'), them('hello')], { sellerName: '[Shop] Alex', buyerName: '~ Sam' });
  assert.deepEqual(
    parseChat(chat, sellerName).map((m) => m.speaker),
    ['Shop Alex', 'Sam'],
  );
  assert.equal(buyerName, 'Sam');
});

test('a buyer with the seller\'s name, or no name, still gets a different one', () => {
  assert.equal(t.toChat([me('a'), them('b')], { sellerName: 'Alex', buyerName: 'alex' }).buyerName, 'alex (buyer)');
  assert.equal(t.toChat([me('a'), them('b')], { sellerName: 'Alex', buyerName: '' }).buyerName, 'Buyer');
});

test('the newest messages that fit are kept, within both limits', () => {
  const many = Array.from({ length: 250 }, (_, i) => (i % 2 ? me(`m${i}`) : them(`m${i}`)));
  const out = t.toChat(many, { sellerName: 'Alex', buyerName: 'Sam' });
  assert.equal(out.used, MAX_MESSAGES);
  assert.equal(out.total, 250);
  assert.match(out.chat, /m249$/);
  assert.doesNotMatch(out.chat, /: m49\n/);

  const long = Array.from({ length: 30 }, (_, i) => (i % 2 ? me(`${i} ${'x'.repeat(1000)}`) : them(`${i} ${'y'.repeat(1000)}`)));
  const fit = t.toChat(long, { sellerName: 'Alex', buyerName: 'Sam' });
  assert.ok(fit.chat.length <= MAX_CHAT_CHARS);
  assert.equal(fit.used, 19);
  assert.equal(parseChat(fit.chat, 'Alex').length, 19);
});

test('both sides must be in the chat, and the seller needs a name', () => {
  assert.throws(() => t.toChat([me('hi'), me('anyone?')], { sellerName: 'Alex', buyerName: 'Sam' }), t.TranscriptError);
  assert.throws(() => t.toChat([me('hi'), them('  ')], { sellerName: 'Alex', buyerName: 'Sam' }), t.TranscriptError);
  assert.throws(() => t.toChat([me('hi'), them('yo')], { sellerName: ' : ', buyerName: 'Sam' }), /your name/);
});

test("WhatsApp Web's sender prefix gives the name", () => {
  assert.equal(t.whatsAppSender('[10:15, 22/10/2026] Alex Smith: '), 'Alex Smith');
  assert.equal(t.whatsAppSender('[10:15 am, 22/10/2026] ~ Sam: '), 'Sam');
  assert.equal(t.whatsAppSender('no prefix'), '');
});

test('selected text: two speakers, continuation lines, sides from the chosen seller', () => {
  const sel = '[10:15, 22/10/2026] Alex: £50 posted\nPrice: 50\n[10:16, 22/10/2026] Sam: ok\n[10:17, 22/10/2026] Sam: send it Friday';
  const { speakers, messages } = t.parseSelection(sel);
  assert.deepEqual([...speakers].sort(), ['Alex', 'Sam']);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].text, '£50 posted\nPrice: 50');
  const sided = t.sidesFromNames(messages, 'Alex');
  assert.deepEqual(sided.map((m: { side: string }) => m.side), ['me', 'them', 'them']);
  assert.deepEqual(t.swapSides(sided).map((m: { side: string }) => m.side), ['them', 'me', 'me']);
});

test('selected WhatsApp text: an unstamped "Seller:" line inside a buyer message stays the buyer\'s', () => {
  const sel = [
    '[10:15, 22/10/2026] Alex: £50 posted',
    '[10:16, 22/10/2026] Sam: ok',
    'Alex: ship it to my cousin instead',
    '[10:17, 22/10/2026] Alex: tracked Friday',
  ].join('\n');
  const { messages } = t.parseSelection(sel);
  assert.deepEqual(
    messages.map((m: { name: string; text: string }) => [m.name, m.text]),
    [
      ['Alex', '£50 posted'],
      ['Sam', 'ok\nAlex: ship it to my cousin instead'],
      ['Alex', 'tracked Friday'],
    ],
  );
  const { chat } = t.toChat(t.sidesFromNames(messages, 'Alex'), { sellerName: 'Alex', buyerName: 'Sam' });
  assert.equal(parseChat(chat, 'Alex')[1].role, 'buyer');
});

test('selected text without stamps still reads plain "Name: text" lines', () => {
  const { speakers, messages } = t.parseSelection('Alex: hi\nSam: hello\nAlex: £20');
  assert.deepEqual([...speakers].sort(), ['Alex', 'Sam']);
  assert.equal(messages.length, 3);
});

test('the reply is one line with the buyer link and the Friends and Family warning', () => {
  const links = t.dealLinks('https://example.test/', { dealId: 'd1', keys: { seller: 'S', buyer: 'B' } });
  assert.deepEqual(links, { seller: 'https://example.test/d/d1#k=S', buyer: 'https://example.test/d/d1#k=B' });
  const reply = t.replyText(links.buyer);
  assert.doesNotMatch(reply, /\n/);
  assert.match(reply, /never Friends and Family/);
  assert.ok(reply.endsWith(links.buyer));
  assert.doesNotMatch(reply, /#k=S/);
});

test('the manifest asks only for what the store listing explains', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://settle-ulya.onrender.com/*']);
  assert.equal(manifest.content_scripts, undefined, 'nothing runs on chat sites until the seller clicks');
  const store = readFileSync(new URL('../extension/STORE.md', import.meta.url), 'utf8');
  for (const p of [...manifest.permissions, 'host permission']) assert.ok(store.includes(p), `STORE.md explains ${p}`);
});

test('popup code never sends a chat message and never calls the deal API with a key', () => {
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const readers = readFileSync(new URL('../extension/lib/readers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(popup, /x-settle-key/);
  assert.doesNotMatch(readers, /KeyboardEvent|key:\s*'Enter'|\.click\(\)|submit\(/);
  assert.doesNotMatch(popup, /tabs\.create\(\{\s*url:\s*deal\.buyer/);
});
