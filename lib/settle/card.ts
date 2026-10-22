// Builds the deal card from dealCheck's picks, and locks it by hash (PLAN M2 MUSTs).
// Every term points at the message it came from, a question both sides answered, or a value
// the seller typed. A term the model wasn't sure of becomes a blocking question. Values always
// come from code (token values, fixed option lists), never from model text.

import type { Pick, TermPicks } from '../jev/deal-check';
import type { ChatMessage } from './chat';
import { hashJson } from './canonical';
import { TERM_MIN_CONFIDENCE } from './policy';
import type { Token } from './redact';
import { TERM_SIGNALS } from './signals';
import { CURRENCY_OF, type Country, type Currency, type Deal, type DealCard, type Delivery, type Question, type Warning } from './types';

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

export function buildCard(messages: ChatMessage[], tokens: Token[], picks: TermPicks, country: Country): Built {
  const currency = CURRENCY_OF[country];
  const card: DealCard = {};
  const questions: Question[] = [];

  // Price: a PRICE token in the deal's currency, or no currency written (the deal's country sets it).
  const priceTokens = tokens.filter((t) => t.kind === 'PRICE' && (!t.currency || t.currency === currency));
  const pricePick = picks.price;
  const priceToken = sure(pricePick) ? priceTokens.find((t) => t.id === pricePick.id) : undefined;
  if (priceToken) {
    card.price = {
      value: { amount: priceToken.amount!, currency },
      display: formatMoney(priceToken.amount!, currency),
      source: { kind: 'message', messageId: priceToken.messageId },
      confidence: pricePick!.confidence,
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
          return { id, label: `${formatMoney(t.amount!, currency)} (message ${t.messageId})` };
        }),
      answers: {},
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
    };
  } else {
    questions.push({
      id: 'q_delivery',
      term: 'delivery',
      prompt: 'How will the item reach the buyer?',
      options: rankedOptions(deliveryPick, Object.keys(DELIVERY_LABELS)).map((id) => ({ id, label: DELIVERY_LABELS[id as Delivery] })),
      answers: {},
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
            return { id, label: `${t.raw} (message ${t.messageId})` };
          }),
        { id: NONE, label: 'No date agreed' },
      ],
      answers: {},
    });
  }

  // Item: the message that names it, quoted.
  const itemPick = picks.itemMessage;
  const itemMessage = sure(itemPick) ? messages.find((m) => m.id === itemPick.id) : undefined;
  if (itemMessage) {
    const text = itemMessage.text.length > ITEM_MAX ? `${itemMessage.text.slice(0, ITEM_MAX - 1)}…` : itemMessage.text;
    card.item = { value: text, display: text, source: { kind: 'message', messageId: itemMessage.id }, confidence: itemPick!.confidence };
  }

  return { card, questions };
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
  for (const q of deal.questions) if (!q.resolved) out.push(`Open question: ${q.prompt}`);
  if (!deal.payeeMerchantId) out.push('The seller has not connected their PayPal account.');
  return out;
}

/** The exact data both sides confirm. Display text and model confidence are left out on purpose. */
export function lockedCard(deal: Deal) {
  const { item, price, delivery, shipBy } = deal.card;
  return {
    v: 1,
    dealId: deal.id,
    country: deal.country,
    payeeMerchantId: deal.payeeMerchantId ?? null,
    item: item ? { value: item.value, source: item.source } : null,
    price: price ? { value: price.value, source: price.source } : null,
    delivery: delivery ? { value: delivery.value, source: delivery.source } : null,
    shipBy: shipBy ? { value: shipBy.value, source: shipBy.source } : null,
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
