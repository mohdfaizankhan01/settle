// The deal service: create a deal from a pasted chat, answer questions, enter missing terms,
// connect the payee and confirm the card. Each side acts through its own secret link key;
// only SHA-256 of each key is stored. Every change writes a receipt (CLAUDE.md), and any
// change to the card bumps its version and clears confirmations.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dealCheck, defaultAskJev, type AskJev } from '../jev/deal-check';
import { applyAnswer, blockers, buildCard, cardHash, formatMoney, isLocked, termWarnings } from './card';
import { sha256Hex } from './canonical';
import { parseChat, type Role } from './chat';
import { redactChat } from './redact';
import { ruleWarnings } from './rules';
import { StaleWriteError, type DealStore, type Stored } from './store';
import { CURRENCY_OF, type Country, type Deal, type DealCard } from './types';

export type Deps = { store: DealStore; ask?: AskJev; now?: () => Date };

export class DealError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const now = (deps: Deps) => (deps.now ?? (() => new Date()))().toISOString();
const newKey = () => randomBytes(32).toString('base64url');

export function roleFor(deal: Deal, key: string | null | undefined): Role | undefined {
  if (!key) return undefined;
  const hash = Buffer.from(sha256Hex(key), 'hex');
  for (const role of ['seller', 'buyer'] as const) {
    if (timingSafeEqual(hash, Buffer.from(deal.keyHashes[role], 'hex'))) return role;
  }
  return undefined;
}

async function load(deps: Deps, dealId: string, key: string | null | undefined) {
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  const role = roleFor(stored.value, key);
  if (!role) throw new DealError('this link is not valid for the deal', 403);
  return { stored, role };
}

/** Read-modify-write with a retry when another write got there first. */
async function mutate(deps: Deps, dealId: string, key: string | null | undefined, change: (deal: Deal, role: Role) => Deal) {
  for (let attempt = 0; ; attempt++) {
    const { stored, role } = await load(deps, dealId, key);
    const next = change(structuredClone(stored.value), role);
    try {
      return { stored: await deps.store.updateDeal(dealId, stored.version, next), role };
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
    }
  }
}

function changeCard(deal: Deal, card: DealCard): Deal {
  return { ...deal, card, cardVersion: deal.cardVersion + 1, confirmations: [], warnings: [...deal.warnings.filter((w) => !w.by.startsWith('term:')), ...termWarnings(card)] };
}

export type NewDeal = { chat: string; sellerName: string; country: Country };

export async function createDeal(input: NewDeal, deps: Deps) {
  const messages = parseChat(input.chat, input.sellerName);
  const redacted = redactChat(messages);
  const check = await dealCheck(redacted, deps.ask ?? defaultAskJev(), deps.now);
  const { card, questions } = buildCard(messages, redacted.tokens, check.picks, input.country);
  const keys = { seller: newKey(), buyer: newKey() };
  const deal: Deal = {
    id: randomUUID(),
    createdAt: now(deps),
    country: input.country,
    messages,
    tokens: redacted.tokens,
    check: check.run,
    warnings: [...check.warnings, ...ruleWarnings(redacted.messages), ...termWarnings(card)],
    card,
    questions,
    cardVersion: 1,
    confirmations: [],
    keyHashes: { seller: sha256Hex(keys.seller), buyer: sha256Hex(keys.buyer) },
  };
  await deps.store.createDeal(deal);
  await deps.store.addReceipt({
    dealId: deal.id,
    kind: 'deal.checked',
    at: deal.createdAt,
    data: {
      check: deal.check.status,
      model: deal.check.status === 'ran' ? (deal.check.model ?? null) : null,
      warnings: deal.warnings.map((w) => ({ signal: w.signalId, by: w.by, message: w.messageId ?? null, p: w.probability ?? null })),
      questions: questions.map((q) => q.id),
      cardHash: cardHash(deal),
    },
  });
  return { deal, keys };
}

export async function answerQuestion(dealId: string, key: string | null, questionId: string, optionId: string, deps: Deps) {
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    const question = deal.questions.find((q) => q.id === questionId);
    if (!question || question.resolved) throw new DealError('no open question with that ID', 409);
    if (!question.options.some((o) => o.id === optionId)) throw new DealError('not an option for this question');
    question.answers[role] = optionId;
    if (question.answers.seller && question.answers.seller === question.answers.buyer) {
      question.resolved = optionId;
      return changeCard(deal, applyAnswer(deal.card, question, optionId, deal.tokens, deal.country));
    }
    return deal;
  });
  await deps.store.addReceipt({
    dealId,
    kind: 'question.answered',
    at: now(deps),
    data: { question: questionId, by: role, option: optionId, cardHash: cardHash(stored.value) },
  });
  return stored;
}

const PRICE_RE = /^\d{1,6}(?:\.\d{1,2})?$/;

/** The seller types a term the chat didn't settle (item or price). The buyer still has to confirm. */
export async function enterTerm(dealId: string, key: string | null, term: 'item' | 'price', value: string, deps: Deps) {
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    if (role !== 'seller') throw new DealError('only the seller can enter a missing term', 403);
    if (deal.card[term]?.source.kind === 'message' || deal.card[term]?.source.kind === 'answer') {
      throw new DealError('this term came from the chat; answer a question instead', 409);
    }
    const source = { kind: 'entered' as const, by: role };
    const v = value.trim();
    if (term === 'item') {
      if (v.length < 2 || v.length > 160) throw new DealError('item must be 2 to 160 characters');
      return changeCard(deal, { ...deal.card, item: { value: v, display: v, source } });
    }
    if (!PRICE_RE.test(v) || Number(v) <= 0) throw new DealError('price must be a number like 120 or 120.50');
    const currency = CURRENCY_OF[deal.country];
    const amount = Number(v).toFixed(2);
    return changeCard(deal, { ...deal.card, price: { value: { amount, currency }, display: formatMoney(amount, currency), source } });
  });
  await deps.store.addReceipt({ dealId, kind: 'term.entered', at: now(deps), data: { term, by: role, cardHash: cardHash(stored.value) } });
  return stored;
}

/** Sets the payee once the seller's PayPal onboarding is verified (step 7). */
export async function setPayee(dealId: string, merchantId: string, deps: Deps): Promise<Stored<Deal>> {
  for (let attempt = 0; ; attempt++) {
    const stored = await deps.store.getDeal(dealId);
    if (!stored) throw new DealError('no such deal', 404);
    if (stored.value.payeeMerchantId === merchantId) return stored;
    // Once a payment is under way the payee is fixed.
    if (stored.value.order && stored.value.order.status !== 'CREATED') throw new DealError('the payee cannot change after payment started', 409);
    const next = { ...stored.value, payeeMerchantId: merchantId, cardVersion: stored.value.cardVersion + 1, confirmations: [] };
    try {
      const saved = await deps.store.updateDeal(dealId, stored.version, next);
      await deps.store.addReceipt({ dealId, kind: 'payee.connected', at: now(deps), data: { merchantId, cardHash: cardHash(saved.value) } });
      return saved;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
    }
  }
}

/** Confirms the card. `seenHash` is the hash of the card the person was shown: if it changed, refuse. */
export async function confirmCard(dealId: string, key: string | null, seenHash: string, deps: Deps) {
  const at = now(deps);
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    const missing = blockers(deal);
    if (missing.length > 0) throw new DealError(`can't confirm yet: ${missing.join(' ')}`, 409);
    const hash = cardHash(deal);
    if (seenHash !== hash) throw new DealError('the card changed since you saw it; review it again', 409);
    return { ...deal, confirmations: [...deal.confirmations.filter((c) => c.role !== role), { role, at, cardHash: hash }] };
  });
  await deps.store.addReceipt({
    dealId,
    kind: 'card.confirmed',
    at,
    data: { by: role, cardHash: cardHash(stored.value), locked: isLocked(stored.value) },
  });
  return stored;
}
