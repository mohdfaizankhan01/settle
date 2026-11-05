// The link preview a chat app shows (PLAN M6) holds only item, price, delivery and status, and the
// share-sheet entry can't put script into the page. PayPal and the model are mocked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardHash } from '../lib/settle/card';
import { answerQuestion, confirmCard, createDeal, setPayee, type Deps } from '../lib/settle/deals';
import { previewFor, previewStatus, PREVIEW_NUDGE } from '../lib/settle/preview';
import { scriptJson, sharedChat, sharePage, SHARED_CHAT_SLOT } from '../lib/settle/share';
import { MemoryDealStore, updateWithRetry } from '../lib/settle/store';
import { askWith, paidSetup } from './helpers/paid-deal';

// A chat full of personal details, every one of which must stay out of the preview.
const CHAT = [
  'Samantha Reyes: hi, is the PS5 still for sale?',
  'Alexander Brooks: yes, £350, I post it tracked. Call me on 07700 900123 or alex.brooks@example.com',
  'Samantha Reyes: deal, send it to 14 Elm Road, Leeds LS1 1AA',
].join('\n');
const PRIVATE = ['Samantha', 'Reyes', 'Alexander', 'Brooks', '07700', 'example.com', 'Elm Road', 'LS1', 'Leeds', 'send it to'];

async function deal(chat = CHAT, seller = 'Alexander Brooks') {
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask: askWith() };
  const { deal: d, keys } = await createDeal({ chat, sellerName: seller, country: 'UK' }, deps);
  return { store, deps, keys, id: d.id, get: async () => (await store.getDeal(d.id))!.value };
}

test('the preview shows item, price, delivery and status, and nothing personal from the chat', async () => {
  const s = await deal();
  const p = previewFor(await s.get());
  const all = JSON.stringify(p);
  for (const word of PRIVATE) assert.ok(!all.includes(word), `preview leaks "${word}": ${all}`);
  assert.equal(p.nudge, PREVIEW_NUDGE);
  assert.match(p.realness, /sandbox/);
  assert.equal(p.status, 'Waiting for both to confirm');
});

test('an item that would carry a name or contact detail is left out of the preview', async () => {
  const s = await deal('Sam: hi\nAlex: selling my PS5, text Alex on 07700 900123, £350 posted\nSam: deal', 'Alex');
  await updateWithRetry(s.store, s.id, (d) => ({ ...d, card: { ...d.card, item: { value: 'PS5, text Alex on 07700 900123', display: 'x', source: { kind: 'message', messageId: 'm2' } } } }));
  const p = previewFor(await s.get());
  assert.equal(p.item, null);
  assert.ok(!JSON.stringify(p).includes('07700'));
  assert.ok(!JSON.stringify(p).includes('Alex'));
});

test('the status follows the deal: confirmations, locked, paid; an unknown deal gets the plain card', async () => {
  const s = await deal('Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', 'Alex');
  await answerQuestion(s.id, s.keys.seller, 'q_fee', 'seller', s.deps);
  await answerQuestion(s.id, s.keys.buyer, 'q_fee', 'seller', s.deps);
  const c = await setPayee(s.id, 'SELLER1', s.deps);
  await confirmCard(s.id, s.keys.seller, cardHash(c.value), s.deps);
  assert.equal(previewStatus(await s.get()), 'Waiting for the other side to confirm');
  await confirmCard(s.id, s.keys.buyer, cardHash(c.value), s.deps);
  assert.equal(previewStatus(await s.get()), 'Terms locked by both');
  assert.equal(previewFor(await s.get()).terms, '£350.00 · Post');

  const paid = await paidSetup();
  await (await import('../lib/settle/payment')).applyVerifiedEvent(paid.event('WH-1'), paid.pdeps);
  assert.equal(previewStatus(await paid.get()), 'Paid through PayPal');

  const none = previewFor(undefined);
  assert.equal(none.item, null);
  assert.equal(none.terms, null);
});

test('a shared chat is capped, keeps a separately shared URL, and cannot close the script tag', () => {
  const form = new FormData();
  form.set('text', 'Sam: hi </script><script>alert(1)</script> x');
  form.set('url', 'https://example.com/item');
  const chat = sharedChat(form);
  assert.ok(chat.endsWith('https://example.com/item'));
  const page = sharePage(chat);
  assert.equal((page.match(/<\/script>/g) ?? []).length, 1, 'only the page\'s own closing tag');
  assert.ok(!page.includes('<script>alert'));
  assert.ok(page.includes(scriptJson(SHARED_CHAT_SLOT)));
  // The JSON still decodes to exactly what was shared.
  assert.equal(JSON.parse(scriptJson(chat)), chat);

  const big = new FormData();
  big.set('text', 'x'.repeat(50_000));
  assert.equal(sharedChat(big).length, 20_000);
  assert.equal(sharedChat(new FormData()), '');
});
