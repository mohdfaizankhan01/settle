import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadChats } from '../lib/eval/chats';
import { parseChat } from '../lib/settle/chat';
import { redactChat } from '../lib/settle/redact';
import { SIGNALS } from '../lib/settle/signals';

// Keeps the eval set usable: every chat parses, labels name real signals, and each signal has at
// least 3 positive and 3 negative chats (PLAN M2 MUST).

const chats = loadChats();

test('every eval chat parses with its seller and has a unique ID', () => {
  assert.equal(new Set(chats.map((c) => c.id)).size, chats.length);
  for (const c of chats) assert.ok(parseChat(c.chat, c.seller).length >= 2, c.id);
});

test('labels name real signals; each signal has at least 3 positives and 3 negatives', () => {
  const ids = new Set(SIGNALS.map((s) => s.id));
  for (const c of chats) for (const p of c.positive) assert.ok(ids.has(p as never), `${c.id}: ${p}`);
  for (const s of SIGNALS) {
    const pos = chats.filter((c) => c.positive.includes(s.id)).length;
    assert.ok(pos >= 3, `${s.id} has ${pos} positives`);
    assert.ok(chats.length - pos >= 3, `${s.id} negatives`);
  }
  assert.ok(chats.length >= 60);
});

test('every expected price is one of the price tokens code finds', () => {
  for (const c of chats.filter((x) => x.price)) {
    const { tokens } = redactChat(parseChat(c.chat, c.seller));
    assert.ok(tokens.some((t) => t.kind === 'PRICE' && t.amount === c.price), `${c.id}: ${c.price}`);
  }
});
