import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskJev } from '../lib/jev/deal-check';
import { buildCard, cardHash, isLocked } from '../lib/settle/card';
import { verifyChain } from '../lib/settle/receipts';
import { answerQuestion, confirmCard, createDeal, DealError, enterTerm, roleFor, setPayee, type Deps } from '../lib/settle/deals';
import { SIGNALS } from '../lib/settle/signals';
import { MemoryDealStore } from '../lib/settle/store';

// Jev is mocked: these tests cover the card, questions, confirmations and the hash lock.

const CHAT = `Sam: hi, is the PS5 still for sale? would you take £300?
Alex: I can do £350 posted, I'll ship by 12/11
Sam: ok deal`;

const pick = (choice: string, confidence = 0.95) => ({ choice, confidence, probabilities: { [choice]: confidence } });

function jev(overrides: Record<string, unknown> = {}): AskJev {
  const answers: Record<string, unknown> = {
    price: pick('PRICE_2'),
    shipBy: pick('DATE_1'),
    delivery: pick('post'),
    itemMessage: pick('m1'),
    deliveryMessage: pick('m2'),
  };
  for (const s of SIGNALS) {
    answers[`sig_${s.id}`] = { noul: 0.01 };
    answers[`ev_${s.id}`] = pick('none');
  }
  return async () => ({ model: 'jev-test', answers: { ...answers, ...overrides } });
}

const deps = (ask = jev()): Deps => ({ store: new MemoryDealStore(), ask, now: () => new Date('2026-10-22T12:00:00Z') });

async function setup(ask?: AskJev) {
  const d = deps(ask);
  const { deal, keys } = await createDeal({ chat: CHAT, sellerName: 'Alex', country: 'UK' }, d);
  return { d, deal, keys };
}

test('a pasted chat gives a card whose terms point at their source messages', async () => {
  const { deal } = await setup();
  assert.deepEqual(deal.card.price, {
    value: { amount: '350.00', currency: 'GBP' },
    display: '£350.00',
    source: { kind: 'message', messageId: 'm2' },
    confidence: 0.95,
  });
  assert.equal(deal.card.delivery?.value, 'post');
  assert.deepEqual(deal.card.delivery?.source, { kind: 'message', messageId: 'm2' });
  assert.equal(deal.card.shipBy?.value, '12/11');
  assert.equal(deal.card.item?.source.kind, 'message');
  assert.deepEqual(deal.questions, []);
});

test('each link key maps to its side; only key hashes are stored', async () => {
  const { deal, keys } = await setup();
  assert.equal(roleFor(deal, keys.seller), 'seller');
  assert.equal(roleFor(deal, keys.buyer), 'buyer');
  assert.equal(roleFor(deal, 'guess'), undefined);
  assert.ok(!JSON.stringify(deal).includes(keys.seller));
});

test('an unsure price becomes a question; matching answers set it, differing ones do not', async () => {
  const { d, deal, keys } = await setup(jev({ price: { choice: 'PRICE_2', confidence: 0.4, probabilities: { PRICE_1: 0.35, PRICE_2: 0.4 } } }));
  assert.equal(deal.card.price, undefined);
  const q = deal.questions[0];
  assert.deepEqual(q.options.map((o) => o.label), ['£350.00 (message m2)', '£300.00 (message m1)']);

  await answerQuestion(deal.id, keys.buyer, 'q_price', 'PRICE_1', d);
  let stored = await answerQuestion(deal.id, keys.seller, 'q_price', 'PRICE_2', d);
  assert.equal(stored.value.card.price, undefined);

  stored = await answerQuestion(deal.id, keys.buyer, 'q_price', 'PRICE_2', d);
  assert.equal(stored.value.card.price?.display, '£350.00');
  assert.deepEqual(stored.value.card.price?.source, { kind: 'answer', questionId: 'q_price' });
  await assert.rejects(answerQuestion(deal.id, keys.buyer, 'q_price', 'PRICE_1', d), DealError);
});

test('collect or meet-up delivery warns both sides citing SP-INPERSON and PP-COLLECT', async () => {
  const { deal } = await setup(jev({ delivery: pick('collect') }));
  const w = deal.warnings.find((x) => x.signalId === 'in_person');
  assert.deepEqual(w, { signalId: 'in_person', audience: 'both', by: 'term:delivery', cites: ['SP-INPERSON', 'PP-COLLECT'] });
});

test('a failed check blocks confirmation (fail closed)', async () => {
  const { d, deal, keys } = await setup(async () => {
    throw new Error('down');
  });
  await setPayee(deal.id, 'MERCHANT1', d);
  const stored = (await d.store.getDeal(deal.id))!;
  await assert.rejects(confirmCard(deal.id, keys.seller, cardHash(stored.value), d), /warning check did not run/);
});

test('both confirmations lock the card; any later change unlocks it and old confirmations stop counting', async () => {
  const { d, deal, keys } = await setup();
  await assert.rejects(confirmCard(deal.id, keys.buyer, cardHash(deal), d), /not connected their PayPal/);

  let stored = await setPayee(deal.id, 'MERCHANT1', d);
  const hash = cardHash(stored.value);
  await confirmCard(deal.id, keys.seller, hash, d);
  stored = await confirmCard(deal.id, keys.buyer, hash, d);
  assert.equal(isLocked(stored.value), true);

  // The payee changes after both confirmed: the card is no longer locked.
  stored = await setPayee(deal.id, 'MERCHANT2', d);
  assert.equal(isLocked(stored.value), false);
  assert.deepEqual(stored.value.confirmations, []);
  // A confirmation for the card as it was is refused.
  await assert.rejects(confirmCard(deal.id, keys.buyer, hash, d), /card changed/);

  const receipts = await d.store.listReceipts(deal.id);
  assert.deepEqual(
    receipts.map((r) => r.kind),
    ['deal.checked', 'payee.connected', 'card.confirmed', 'card.confirmed', 'payee.connected'],
  );
  assert.equal(verifyChain(receipts).ok, true);
});

test('the seller can enter a missing price; the buyer cannot, and chat-sourced terms cannot be overwritten', async () => {
  const { d, deal, keys } = await setup(jev({ price: pick('none') }));
  assert.equal(deal.card.price, undefined);
  await assert.rejects(enterTerm(deal.id, keys.buyer, 'price', '1', d), /only the seller/);
  await assert.rejects(enterTerm(deal.id, keys.seller, 'price', '-5', d), DealError);
  const stored = await enterTerm(deal.id, keys.seller, 'price', '340', d);
  assert.deepEqual(stored.value.card.price?.source, { kind: 'entered', by: 'seller' });
  await assert.rejects(enterTerm(deal.id, keys.seller, 'item', 'something else', d), /came from the chat/);
});

test('a wrong link key is refused', async () => {
  const { d, deal } = await setup();
  await assert.rejects(confirmCard(deal.id, 'nope', 'x', d), (e: DealError) => e.status === 403);
});

test('buildCard: a delivery pick citing a message that does not exist becomes a question', () => {
  const messages = [{ id: 'm1', speaker: 'A', role: 'seller' as const, text: 'posting it' }];
  const p = (id: string) => ({ id, confidence: 0.9, probabilities: {} });
  const { card, questions } = buildCard(messages, [], { delivery: p('post'), deliveryMessage: p('m42') }, 'UK');
  assert.equal(card.delivery, undefined);
  assert.equal(questions[0].id, 'q_delivery');
});
