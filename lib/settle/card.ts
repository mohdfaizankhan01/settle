// Builds the deal card from dealCheck's picks, and locks it by hash (PLAN M2 MUSTs).
// Every term points at the message it came from, a question both sides answered, or a value
// the seller typed. A term the model wasn't sure of becomes a blocking question. Values always
// come from code (token values, fixed option lists), never from model text.

import type { Pick, TermPicks } from '../jev/deal-check';
import type { ChatMessage } from './chat';
import { hashJson } from './canonical';
import { TERM_MIN_CONFIDENCE } from './policy';
import type { Token } from './redact';
import { moneyFor, type Money } from './fees';
import { TERM_SIGNALS } from './signals';
import { CURRENCY_OF, type CardClaim, type Country, type Currency, type Deal, type DealCard, type Delivery, type Question, type ReaderRecord, type Warning } from './types';

const NONE = 'none';
const SYMBOL: Record<Currency, string> = { USD: '$', GBP: '£' };
export const DELIVERY_LABELS: Record<Delivery, string> = {
  post: 'Post',
  courier: 'Courier',
  collect: 'Buyer collects in person',
  meetup: 'Meet up in person',
  digital: 'Digital, nothing shipped',
};
const ITEM_MAX = 160;

export const formatMoney = (amount: string, currency: Currency) => `${SYMBOL[currency]}${amount}`;

const sure = (p: Pick | undefined): p is Pick => !!p && p.id !== NONE && p.confidence >= TERM_MIN_CONFIDENCE;

/** Options for a question, most likely first, with "none" last if offered. */
function rankedOptions(pick: Pick | undefined, ids: string[]) {
  const p = pick?.probabilities ?? {};
  return [...ids].sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0));
}

type Built = { card: DealCard; questions: Question[] };

/**
 * What the AI reader adds (PLAN M8), after mergePicks: the case per term, the item's exact words
 * and the seller's claims, all already checked against the chat. Missing: the card is code's alone.
 */
export type CardReading = { cases: NonNullable<ReaderRecord['cases']>; itemWords?: { messageId: string; quote: string }; claims?: CardClaim[] };

export function buildCard(messages: ChatMessage[], tokens: Token[], picks: TermPicks, country: Country, read?: CardReading): Built {
  const currency = CURRENCY_OF[country];
  const card: DealCard = {};
  const questions: Question[] = [];
  const readBy = (term: 'price' | 'shipBy' | 'delivery') => (read ? { readBy: read.cases[term] === 'agree' ? ('both' as const) : ('code' as const) } : {});
  const why = (term: 'price' | 'shipBy' | 'delivery') => {
    const c = read?.cases[term];
    return c === 'disagree' || c === 'both_unsure' ? { why: c } : {};
  };

  // Price: a PRICE token in the deal's currency, or no currency written (the deal's country sets it).
  // Same bounds as a price the seller types: above zero, at most six digits (fees.ts limits).
  const priceTokens = tokens.filter(
    (t) => t.kind === 'PRICE' && (!t.currency || t.currency === currency) && /^\d{1,6}(?:\.\d{1,2})?$/.test(t.amount ?? '') && Number(t.amount) > 0,
  );
  const pricePick = picks.price;
  const priceToken = sure(pricePick) ? priceTokens.find((t) => t.id === pricePick.id) : undefined;
  if (priceToken) {
    card.price = {
      value: { amount: priceToken.amount!, currency },
      display: formatMoney(priceToken.amount!, currency),
      source: { kind: 'message', messageId: priceToken.messageId },
      confidence: pricePick!.confidence,
      ...readBy('price'),
    };
  } else if (priceTokens.length > 0) {
    questions.push({
      id: 'q_price',
      term: 'price',
      prompt: 'What is the final price for this deal?',
      options: rankedOptions(pricePick, priceTokens.map((t) => t.id))
        .slice(0, 4)
        .map((id) => {
          const t = priceTokens.find((x) => x.id === id)!;
          return { id, label: `${formatMoney(t.amount!, currency)} (message ${t.messageId.slice(1)})` };
        }),
      answers: {},
      ...why('price'),
    });
  }

  // Delivery: needs both the method and the message it came from.
  const deliveryPick = picks.delivery;
  const deliveryMessage = picks.deliveryMessage;
  if (
    sure(deliveryPick) &&
    Object.hasOwn(DELIVERY_LABELS, deliveryPick.id) &&
    sure(deliveryMessage) &&
    messages.some((m) => m.id === deliveryMessage.id)
  ) {
    const value = deliveryPick.id as Delivery;
    card.delivery = {
      value,
      display: DELIVERY_LABELS[value],
      source: { kind: 'message', messageId: deliveryMessage.id },
      confidence: deliveryPick.confidence,
      ...readBy('delivery'),
    };
  } else {
    questions.push({
      id: 'q_delivery',
      term: 'delivery',
      prompt: 'How will the item reach the buyer?',
      options: rankedOptions(deliveryPick, Object.keys(DELIVERY_LABELS)).map((id) => ({ id, label: DELIVERY_LABELS[id as Delivery] })),
      answers: {},
      ...why('delivery'),
    });
  }

  // Ship-by date: optional. A confident "none" means no date.
  const dateTokens = tokens.filter((t) => t.kind === 'DATE');
  const datePick = picks.shipBy;
  const dateToken = sure(datePick) ? dateTokens.find((t) => t.id === datePick.id) : undefined;
  if (dateToken) {
    card.shipBy = {
      value: dateToken.raw,
      display: dateToken.raw,
      source: { kind: 'message', messageId: dateToken.messageId },
      confidence: datePick!.confidence,
      ...readBy('shipBy'),
    };
  } else if (dateTokens.length > 0 && !(datePick?.id === NONE && datePick.confidence >= TERM_MIN_CONFIDENCE)) {
    questions.push({
      id: 'q_shipBy',
      term: 'shipBy',
      prompt: 'Did you agree a date to ship by?',
      options: [
        ...rankedOptions(datePick, dateTokens.map((t) => t.id))
          .slice(0, 3)
          .map((id) => {
            const t = dateTokens.find((x) => x.id === id)!;
            return { id, label: `${t.raw} (message ${t.messageId.slice(1)})` };
          }),
        { id: NONE, label: 'No date agreed' },
      ],
      answers: {},
      ...why('shipBy'),
    });
  }

  // Who pays PayPal's fee: never read from the chat, always both sides' answer (docs/fees.md).
  questions.push({
    id: 'q_fee',
    term: 'feePayer',
    prompt: "Who pays PayPal's fee?",
    options: [
      { id: 'seller', label: 'The seller (taken from what they receive)' },
      { id: 'buyer', label: 'The buyer (added to the total)' },
    ],
    answers: {},
  });

  // Item: the words that name it, quoted from their message.
  const itemPick = picks.itemMessage;
  const itemMessage = sure(itemPick) ? messages.find((m) => m.id === itemPick.id) : undefined;
  if (itemMessage) {
    // The AI reader's exact words for the item, when code also found an item and the words are
    // really in that message as written (they were checked against the redacted text already).
    // The AI reader's words replace code's name only when they come from the very message code took
    // the item from: then both point at the same message, and the reader adds the exact words. Words
    // from any other message never change the term (code review, Nov 11).
    const fromCode = itemText(messages, itemMessage);
    const words = read?.itemWords;
    const wordsMessage = words && words.messageId === fromCode.messageId ? messages.find((m) => m.id === words.messageId) : undefined;
    const fromReader = words && wordsMessage?.text.includes(words.quote) ? { text: words.quote, messageId: wordsMessage.id } : undefined;
    const { text: raw, messageId } = fromReader ?? fromCode;
    const text = raw.length > ITEM_MAX ? `${raw.slice(0, ITEM_MAX - 1)}…` : raw;
    card.item = { value: text, display: text, source: { kind: 'message', messageId }, confidence: itemPick!.confidence, ...(read ? { readBy: fromReader ? ('both' as const) : ('code' as const) } : {}) };
  }

  if (read?.claims?.length) card.claims = read.claims.map((c) => ({ ...c }));

  return { card, questions };
}

// "yes, Trek Domane AL 2, 54cm, good condition": the seller describing the item in reply.
const DESCRIBES = /^(?:yes|yeah|yep|yup)\b[\s,.!:;–-]+(.{3,})$/i;
// "is the road bike still for sale?": the item named in the buyer's question.
const ASKS_FOR = /\b(?:is|are) (?:the|your|this|that|these|those) (.{2,60}?) (?:still )?(?:for sale|available|there)\b/i;
// A reply about money, delivery or the seller, not the item ("yes, $300 is fine", "yes, I post it").
const NOT_ITEM =
  /[$£€]\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|gbp|eur|dollars?|pounds?|quid|bucks)\b|^(?:i|i'?ll|i'?m|we|it|it'?s|that|sure|ok|okay|can|will|still|no)\b|\b(?:post|ship|send|deliver|collect|pick ?up|meet)\w*\b/i;

/**
 * The item's name, in code: the seller's describing reply right after the item message, or the
 * phrase the question asks about, or (as before) the whole message. Always cites its message.
 */
export function itemText(messages: ChatMessage[], itemMessage: ChatMessage): { text: string; messageId: string } {
  const at = messages.findIndex((m) => m.id === itemMessage.id);
  const reply = messages.slice(at + 1, at + 3).find((m) => m.role === 'seller');
  const described = reply && itemMessage.role === 'buyer' ? DESCRIBES.exec(reply.text.trim())?.[1] : undefined;
  if (described && !NOT_ITEM.test(described)) return { text: described.replace(/[.!\s]+$/, ''), messageId: reply!.id };
  const asked = ASKS_FOR.exec(itemMessage.text)?.[1];
  if (asked) return { text: asked.trim(), messageId: itemMessage.id };
  return { text: itemMessage.text, messageId: itemMessage.id };
}

/** Applies a question both sides answered the same way. */
export function applyAnswer(card: DealCard, question: Question, optionId: string, tokens: Token[], country: Country): DealCard {
  const source = { kind: 'answer' as const, questionId: question.id };
  const currency = CURRENCY_OF[country];
  const next = { ...card };
  if (question.term === 'price') {
    const t = tokens.find((x) => x.id === optionId && x.kind === 'PRICE');
    if (!t) throw new Error('unknown price option');
    next.price = { value: { amount: t.amount!, currency }, display: formatMoney(t.amount!, currency), source };
  } else if (question.term === 'delivery') {
    if (!Object.hasOwn(DELIVERY_LABELS, optionId)) throw new Error('unknown delivery option');
    next.delivery = { value: optionId as Delivery, display: DELIVERY_LABELS[optionId as Delivery], source };
  } else if (question.term === 'feePayer') {
    if (optionId !== 'seller' && optionId !== 'buyer') throw new Error('unknown fee option');
    next.feePayer = { value: optionId, display: optionId === 'seller' ? 'The seller' : 'The buyer', source };
  } else if (question.term === 'shipBy') {
    if (optionId === NONE) delete next.shipBy;
    else {
      const t = tokens.find((x) => x.id === optionId && x.kind === 'DATE');
      if (!t) throw new Error('unknown date option');
      next.shipBy = { value: t.raw, display: t.raw, source };
    }
  }
  return next;
}

/** Deals handed over in person: paid as a PayPal hold, taken at the handover (DECISIONS #20). */
export const isHandoverDeal = (deal: { card: DealCard }) => deal.card.delivery?.value === 'meetup' || deal.card.delivery?.value === 'collect';

/**
 * The deal pays as a PayPal hold: a meet-up deal whose order (if any) was created as a hold. A
 * meet-up deal paid by normal capture before holds existed keeps the normal rules (code review).
 */
export const paysByHold = (deal: { card: DealCard; order?: Deal['order'] }) => isHandoverDeal(deal) && (!deal.order || deal.order.intent === 'AUTHORIZE');

/** Warnings that follow from the card itself: collect and meet-up (SP-INPERSON, PP-COLLECT). */
export function termWarnings(card: DealCard): Warning[] {
  const d = card.delivery?.value;
  if (d !== 'collect' && d !== 'meetup') return [];
  const s = TERM_SIGNALS.in_person;
  return [{ signalId: s.id, audience: s.audience, by: 'term:delivery', cites: s.cites }];
}

// ---- Locking --------------------------------------------------------------------------------

/** What's missing before both sides can confirm. Empty means ready. */
export function blockers(deal: Deal): string[] {
  const out: string[] = [];
  if (deal.check.status !== 'ran') out.push('The warning check did not run. Run it again before confirming.');
  if (!deal.card.item) out.push('The item is not set.');
  if (!deal.card.price) out.push('The price is not set.');
  if (!deal.card.delivery) out.push('The delivery method is not set.');
  if (!deal.card.feePayer) out.push("Who pays PayPal's fee is not settled.");
  for (const d of deal.declines ?? []) out.push(`The ${d.role} declined this deal.`);
  for (const q of deal.questions) if (!q.resolved) out.push(`Open question: ${q.prompt}`);
  if (!deal.payeeMerchantId) out.push('The seller has not connected their PayPal account.');
  return out;
}

/** Total the buyer pays, estimated fee and what the seller gets, once price and fee payer are set. */
export function moneyOf(deal: Deal): Money | undefined {
  const { price, feePayer } = deal.card;
  return price && feePayer ? moneyFor(price.value.amount, feePayer.value, deal.country) : undefined;
}

/** The exact data both sides confirm. Display text and model confidence are left out on purpose. */
export function lockedCard(deal: Deal) {
  const { item, price, delivery, shipBy, feePayer } = deal.card;
  return {
    v: 2,
    dealId: deal.id,
    country: deal.country,
    payeeMerchantId: deal.payeeMerchantId ?? null,
    item: item ? { value: item.value, source: item.source } : null,
    price: price ? { value: price.value, source: price.source } : null,
    delivery: delivery ? { value: delivery.value, source: delivery.source } : null,
    shipBy: shipBy ? { value: shipBy.value, source: shipBy.source } : null,
    feePayer: feePayer ? { value: feePayer.value, source: feePayer.source } : null,
    // The total the buyer will pay is part of what both confirm.
    total: moneyOf(deal)?.total ?? null,
    // What the seller said about the item (PLAN M8). Left out entirely when there are none, so a
    // card without claims hashes exactly as cards did before.
    ...(deal.card.claims?.length
      ? { claims: deal.card.claims.map((c) => ({ messageId: c.messageId, quote: c.quote, kind: c.kind, context: c.context ? { messageId: c.context.messageId, quote: c.context.quote } : null })) }
      : {}),
  };
}

export const cardHash = (deal: Deal) => hashJson(lockedCard(deal));

/** Locked: both sides confirmed the card exactly as it is now. */
export function isLocked(deal: Deal): boolean {
  const hash = cardHash(deal);
  return (
    blockers(deal).length === 0 &&
    (['seller', 'buyer'] as const).every((role) => deal.confirmations.some((c) => c.role === role && c.cardHash === hash))
  );
}
