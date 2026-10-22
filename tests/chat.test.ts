import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatError, findSpeakers, parseChat } from '../lib/settle/chat';

test('plain "Name: text" lines become numbered messages with roles', () => {
  const chat = 'Sam: is the bike still available?\nAlex: yes, £120\nSam: great';
  assert.deepEqual(parseChat(chat, 'Alex'), [
    { id: 'm1', speaker: 'Sam', role: 'buyer', text: 'is the bike still available?' },
    { id: 'm2', speaker: 'Alex', role: 'seller', text: 'yes, £120' },
    { id: 'm3', speaker: 'Sam', role: 'buyer', text: 'great' },
  ]);
});

test('WhatsApp export prefixes and invisible marks are stripped', () => {
  const chat = [
    '[22/10/2026, 10:15:03] ‎Alex Smith: hi',
    '22/10/2026, 10:16 - Sam: hello',
    '[22/10/2026, 10:17:00] Alex Smith: price is £50',
  ].join('\n');
  const messages = parseChat(chat, 'Alex Smith');
  assert.deepEqual(
    messages.map((m) => [m.speaker, m.role, m.text]),
    [
      ['Alex Smith', 'seller', 'hi'],
      ['Sam', 'buyer', 'hello'],
      ['Alex Smith', 'seller', 'price is £50'],
    ],
  );
});

test('lines without a speaker, or with a third "Name:" prefix, continue the previous message', () => {
  const chat = 'Alex: details below\nPrice: 50\nCondition: used\nSam: ok\nSam: and postage?\nAlex: included';
  const messages = parseChat(chat, 'Alex');
  assert.equal(messages[0].text, 'details below\nPrice: 50\nCondition: used');
  assert.equal(messages.length, 4);
});

test('the two most frequent speakers are found', () => {
  assert.deepEqual(findSpeakers('A: 1\nB: 2\nA: 3\nNote: x'), ['A', 'B']);
});

test('fails clearly on one speaker, an unknown seller or an oversized chat', () => {
  assert.throws(() => parseChat('Alex: hi\nAlex: hello', 'Alex'), ChatError);
  assert.throws(() => parseChat('Alex: hi\nSam: hello', 'Jo'), ChatError);
  assert.throws(() => parseChat(`Alex: ${'x'.repeat(20_001)}\nSam: hi`, 'Alex'), ChatError);
});

test('IDs stay contiguous when an empty message is dropped', () => {
  const messages = parseChat('Alex: \nSam: hi\nAlex: hello', 'Alex');
  assert.deepEqual(messages.map((m) => m.id), ['m1', 'm2']);
});
