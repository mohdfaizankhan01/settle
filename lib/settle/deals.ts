// The deal service: create a deal from a pasted chat, answer questions, enter missing terms,
// connect the payee and confirm the card. Each side acts through its own secret link key;
// only SHA-256 of each key is stored. Every change writes a receipt (CLAUDE.md), and any
// change to the card bumps its version and clears confirmations.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AskJev } from '../jev/deal-check';
import { engineFor, type CheckEngine } from '../model/engine';
import { applyAnswer, blockers, buildCard, cardHash, formatMoney, isLocked, termWarnings } from './card';
import { sha256Hex } from './canonical';
import { ChatError, parseChat, parseMore, type Role } from './chat';
import { reportOtherSide } from './memory';
import { MAX_CHAT_CHARS } from './policy';
import { redactChat } from './redact';
import { ruleWarnings } from './rules';
import { syncGate } from './ship-gate';
import { StaleWriteError, type DealStore, type Stored } from './store';
import { CURRENCY_OF, type CheckRun, type Country, type Deal, type DealCard, type DeclineReason } from './types';

export type Deps = { store: DealStore; ask?: AskJev; engine?: CheckEngine; now?: () => Date };

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

/** The link key and, after the first open, this device's secret: `<key>\n<device secret>`. */
export const withDevice = (key: string | null | undefined, device: string | null | undefined): string | null => (key && device ? `${key}\n${device}` : (key ?? null));

export const OTHER_DEVICE_LINK =
  "This link was already opened on another device, and it only works there. If that wasn't you, don't confirm or pay: ask the other person for a new deal link.";

const hashEq = (a: string, hexHash: string) => {
  const x = Buffer.from(sha256Hex(a), 'hex');
  const y = Buffer.from(hexHash, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Which side a link key is for. Once a side's link has been claimed (opened on a device), it only
 * counts from that device: any other device gets a 403 that says so (DECISIONS #22).
 */
export function roleFor(deal: Deal, key: string | null | undefined): Role | undefined {
  if (!key) return undefined;
  const [linkKey, device] = key.split('\n');
  for (const role of ['seller', 'buyer'] as const) {
    if (!hashEq(linkKey, deal.keyHashes[role])) continue;
    const claim = deal.claims?.[role];
    if (claim && !deal.demo && !(device && hashEq(device, claim.hash))) throw new DealError(OTHER_DEVICE_LINK, 403);
    return role;
  }
  return undefined;
}

export const UNCLAIMED_LINK = 'Open this link on your own device first, then try again.';

/**
 * The role for a link that is about to act (confirm, answer, pay, ship...). It must have been
 * opened (claimed) on a device first: otherwise whoever made the deal, who holds both links, could
 * act as the other side before that person ever opens their link, and the claim afterwards would
 * hide it. Only GET /api/deals/[id] claims; pages always load before they act. Judge-mode deals are
 * never claimed.
 */
export function actingRole(deal: Deal, key: string | null | undefined): Role | undefined {
  const role = roleFor(deal, key);
  if (role && !deal.demo && !deal.claims?.[role]) throw new DealError(UNCLAIMED_LINK, 409);
  return role;
}

/**
 * First open of a link on a device: the device gets a secret that the link needs from now on.
 * Returns the secret only to the first device; later opens return nothing. Judge-mode deals are
 * never claimed (their sessions are already private, and one judge plays both sides).
 */
export async function claimLink(dealId: string, key: string | null | undefined, deps: Deps): Promise<string | undefined> {
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  const role = roleFor(stored.value, key);
  if (!role || stored.value.demo || stored.value.claims?.[role]) return undefined;
  const secret = randomBytes(24).toString('base64url');
  const at = now(deps);
  try {
    await deps.store.updateDeal(dealId, stored.version, { ...stored.value, claims: { ...stored.value.claims, [role]: { hash: sha256Hex(secret), at } } });
  } catch (error) {
    // Two devices opened it at once: the other one won, and this one gets the 403 next time.
    if (error instanceof StaleWriteError) return undefined;
    throw error;
  }
  await deps.store.addReceipt({ dealId, kind: 'link.claimed', at, data: { role } });
  return secret;
}

/**
 * Opens both links as two devices would (each GET claims its side) and returns the keys bound to
 * those devices. For tests and the attack lab, which play both people.
 */
export async function openLinks(dealId: string, keys: { seller: string; buyer: string }, deps: Deps) {
  const seller = await claimLink(dealId, keys.seller, deps);
  const buyer = await claimLink(dealId, keys.buyer, deps);
  return { seller: withDevice(keys.seller, seller) ?? keys.seller, buyer: withDevice(keys.buyer, buyer) ?? keys.buyer };
}

async function load(deps: Deps, dealId: string, key: string | null | undefined) {
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  const role = actingRole(stored.value, key);
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
  const check = await engineFor(deps)(redacted, deps.now);
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

/** Payment has started once the order left CREATED or the buyer's capture/hold call is at PayPal. */
export const paymentStarted = (deal: Deal) => !!deal.order && (deal.order.status !== 'CREATED' || !!deal.order.paying);

export const PAYEE_LOCKED = 'the payee cannot change after payment started';

const PRICE_RE = /^\d{1,6}(?:\.\d{1,2})?$/;

/** The seller types a term the chat didn't settle (item or price). The buyer still has to confirm. */
export async function enterTerm(dealId: string, key: string | null, term: 'item' | 'price', value: string, deps: Deps) {
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    if (role !== 'seller') throw new DealError('only the seller can enter a missing term', 403);
    if (paymentStarted(deal)) throw new DealError('payment already started; the card can no longer change', 409);
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
    if (paymentStarted(stored.value)) throw new DealError(PAYEE_LOCKED, 409);
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

/**
 * Runs the warning check again after it failed (Jev down, no key). The card is rebuilt from the
 * chat, so terms typed in or answered earlier are cleared; nobody can have confirmed yet, because
 * a failed check blocks confirming.
 */
export async function recheckDeal(dealId: string, key: string | null, deps: Deps) {
  const first = await load(deps, dealId, key);
  if (first.stored.value.check.status === 'ran') throw new DealError('the check already ran for this deal', 409);
  const deal = first.stored.value;
  const redacted = redactChat(deal.messages);
  const check = await engineFor(deps)(redacted, deps.now);
  const { card, questions } = buildCard(deal.messages, redacted.tokens, check.picks, deal.country);
  const { stored, role } = await mutate(deps, dealId, key, (current) => {
    if (current.check.status === 'ran') throw new DealError('the check already ran for this deal', 409);
    return {
      ...current,
      tokens: redacted.tokens,
      check: check.run,
      warnings: [...check.warnings, ...ruleWarnings(redacted.messages), ...termWarnings(card)],
      card,
      questions,
      cardVersion: current.cardVersion + 1,
      confirmations: [],
    };
  });
  await deps.store.addReceipt({
    dealId,
    kind: 'deal.rechecked',
    at: now(deps),
    data: {
      by: role,
      check: stored.value.check.status,
      warnings: stored.value.warnings.map((w) => ({ signal: w.signalId, by: w.by, message: w.messageId ?? null, p: w.probability ?? null })),
      cardHash: cardHash(stored.value),
    },
  });
  return stored;
}

export const DECLINE_REASONS: Record<DeclineReason, string> = {
  wants_ff: 'They want to be paid as Friends and Family instead',
  wants_other_payment: 'They want to pay or be paid outside PayPal',
  terms_wrong: 'The terms on the card are wrong',
  other: 'Another reason',
};

/** One side says no to the deal link. Blocks confirming and paying; the other side sees why. */
export async function declineDeal(dealId: string, key: string | null, reason: string, deps: Deps) {
  if (!Object.hasOwn(DECLINE_REASONS, reason)) throw new DealError('unknown reason');
  const at = now(deps);
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    if (paymentStarted(deal)) throw new DealError('payment already started; use PayPal to sort out problems', 409);
    return {
      ...deal,
      confirmations: [],
      declines: [...(deal.declines ?? []).filter((d) => d.role !== role), { role, at, reason: reason as DeclineReason }],
    };
  });
  await deps.store.addReceipt({ dealId, kind: 'deal.declined', at, data: { by: role, reason, cardHash: cardHash(stored.value) } });
  // Declined because the other side wanted to leave PayPal: scam memory remembers that side.
  const signals = SCAM_DECLINES[reason as DeclineReason];
  if (signals) await reportOtherSide(stored.value, role, 'declined', { store: deps.store, now: deps.now }, signals).catch(() => undefined);
  return stored;
}

/** Decline reasons that report the other side to scam memory, with the warnings they match. */
const SCAM_DECLINES: Partial<Record<DeclineReason, string[]>> = {
  wants_ff: ['ff_payment'],
  wants_other_payment: ['off_paypal', 'move_off_chat', 'code_request', 'fee_to_release', 'overpayment_refund'],
};

/** Takes back your own decline. */
export async function withdrawDecline(dealId: string, key: string | null, deps: Deps) {
  const { stored, role } = await mutate(deps, dealId, key, (deal, role) => {
    if (!(deal.declines ?? []).some((d) => d.role === role)) throw new DealError('you have not declined this deal', 409);
    return { ...deal, declines: (deal.declines ?? []).filter((d) => d.role !== role) };
  });
  await deps.store.addReceipt({ dealId, kind: 'deal.decline_withdrawn', at: now(deps), data: { by: role } });
  return stored;
}

/** At most this much text can be pasted in at once after payment. */
export const MAX_ADDED_CHARS = 4000;

/**
 * Either side pastes messages from the DM that came after payment started (PLAN M3). They are
 * redacted and run through the same warning check; the card can't change. A failed check is
 * recorded and makes the ship gate REVIEW, never pass.
 */
export async function addMessages(dealId: string, key: string | null, raw: string, deps: Deps) {
  const first = await load(deps, dealId, key);
  const deal = first.stored.value;
  if (!deal.order || deal.order.status === 'CREATED') throw new DealError('messages can be added once payment has started', 409);
  const added = parseMore(raw, deal.messages, MAX_ADDED_CHARS);
  const totalChars = [...deal.messages, ...added].reduce((n, m) => n + m.text.length, 0);
  if (totalChars > MAX_CHAT_CHARS) throw new ChatError(`the deal can hold at most ${MAX_CHAT_CHARS} characters of chat`);
  const at = now(deps);
  const messages = [...deal.messages, ...added.map((m) => ({ ...m, added: { at, by: first.role } }))];
  // A failed check stays on the record (fail closed): later pastes don't clear it.
  // Redact the whole chat so token numbers stay the same, then check only the new messages.
  const redacted = redactChat(messages);
  const ids = new Set(added.map((m) => m.id));
  const fresh = { messages: redacted.messages.filter((m) => ids.has(m.id)), tokens: redacted.tokens.filter((t) => ids.has(t.messageId)) };
  let run: CheckRun;
  let found: Deal['warnings'] = [];
  try {
    const check = await engineFor(deps)(fresh, deps.now);
    run = check.run;
    found = check.run.status === 'ran' ? check.warnings : [];
  } catch (error) {
    run = { status: 'failed', at, reason: error instanceof Error ? error.name : 'error' };
  }
  // The check only saw the new messages, so a warning without an evidence message still came from
  // them: pin it to the last one so the ship gate counts it (fail closed).
  const lastId = added.at(-1)!.id;
  found = [...found, ...ruleWarnings(fresh.messages)].map((w) => (w.messageId && ids.has(w.messageId) ? w : { ...w, messageId: lastId }));

  const { role } = await mutate(deps, dealId, key, (current) => {
    if (current.messages.length !== deal.messages.length) throw new DealError('someone else added messages; reload and paste again', 409);
    return { ...current, messages, tokens: redacted.tokens, warnings: [...current.warnings, ...found], addedCheck: current.addedCheck?.status === 'failed' ? current.addedCheck : run };
  });
  await deps.store.addReceipt({
    dealId,
    kind: 'messages.added',
    at,
    data: {
      by: role,
      messages: added.map((m) => m.id),
      check: run.status,
      warnings: found.map((w) => ({ signal: w.signalId, by: w.by, message: w.messageId ?? null, p: w.probability ?? null })),
    },
  });
  await syncGate(deps.store, dealId, at);
  return (await deps.store.getDeal(dealId))!;
}
