// "Is this paid?" (PLAN M3 MUST, PaidCheck). The seller pastes the text of a "payment received"
// email or screenshot. The answer comes only from this deal's PayPal order, read fresh: paid, not
// paid, or couldn't reach PayPal, which stays separate from "not paid". The pasted text is never
// trusted: code pulls out any amounts, transaction IDs and links only to point out where they
// differ from PayPal's record. The text itself is not stored or sent to any model.

import { formatMoney, moneyOf } from './card';
import { DealError, actingRole } from './deals';
import { refreshPayment, type PaymentDeps } from './payment';
import { redactChat } from './redact';
import { isPaid, readFailedLast } from './ship-gate';
import type { Deal } from './types';

export const MAX_PASTE_CHARS = 4000;

export type PaidVerdict = 'paid' | 'not_paid' | 'cant_check';

export type PaidCheck = {
  verdict: PaidVerdict;
  /** What PayPal's record says, in one sentence. */
  answer: string;
  /** Where the pasted text disagrees with PayPal, or looks wrong. Never a reason to ship. */
  notes: string[];
  checkedAt: string;
};

// PayPal transaction (capture) IDs are 17 upper-case letters and digits.
const TXN_ID = /\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{17}\b/g;

function notesFor(deal: Deal, text: string, captureId: string | undefined): string[] {
  const notes: string[] = [];
  // Reuse the chat redactor to find prices and links the same way the card does.
  const { tokens } = redactChat([{ id: 'p1', speaker: 'paste', role: 'buyer', text }]);
  const total = moneyOf(deal)?.total;
  const currency = deal.card.price?.value.currency;
  for (const t of tokens.filter((x) => x.kind === 'PRICE' && x.amount)) {
    if (total && Number(t.amount) !== Number(total)) notes.push(`It mentions ${t.raw}, but this deal's payment is ${formatMoney(total, currency!)}.`);
    if (t.currency && currency && t.currency !== currency) notes.push(`It mentions ${t.currency}, but this deal is in ${currency}.`);
  }
  for (const t of tokens.filter((x) => x.kind === 'LINK' && !x.isPayPal)) notes.push(`It has a link to ${t.host ?? t.raw}, which is not PayPal's.`);
  for (const id of new Set(text.toUpperCase().match(TXN_ID) ?? [])) {
    if (captureId && id !== captureId) notes.push(`It names transaction ${id}, which is not this deal's payment.`);
    if (!captureId) notes.push(`It names transaction ${id}, but PayPal has no completed payment for this deal.`);
  }
  if (/\b(?:pending|on hold|held|release|shipping (?:number|confirmation)|upgrade|tracking (?:number )?(?:to|first)|business account)\b/i.test(text)) {
    notes.push('It says the money is held until you ship or send a tracking number. PayPal does not work that way: a completed payment shows in your own PayPal account.');
  }
  return notes;
}

/** Seller-only. Reads PayPal fresh (the same rules as the ship gate) and answers from that. */
export async function paidCheck(dealId: string, key: string | null, text: string, deps: PaymentDeps): Promise<PaidCheck> {
  if (text.length > MAX_PASTE_CHARS) throw new DealError(`paste at most ${MAX_PASTE_CHARS} characters`);
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (actingRole(stored.value, key) !== 'seller') throw new DealError('only the seller can check a payment', 403);
  const at = (deps.now ?? (() => new Date()))().toISOString();

  let deal = stored.value;
  let reached = true;
  // Always a fresh read, paid or not: a refund may have come after the last one.
  if (deal.order && deal.payeeMerchantId) {
    try {
      deal = await refreshPayment(dealId, { kind: 'page' }, deps);
    } catch {
      reached = false;
    }
  }

  const read = deal.payment?.read;
  const total = moneyOf(deal)?.total;
  const money = total ? formatMoney(total, deal.card.price!.value.currency) : 'the agreed amount';
  let verdict: PaidVerdict;
  let answer: string;
  if (!reached || readFailedLast(deal) || (read && !read.ok)) {
    verdict = 'cant_check';
    answer = "Couldn't reach PayPal just now, so Settle Link can't say either way. Don't ship until it can.";
  } else if (isPaid(deal)) {
    verdict = 'paid';
    answer = `PayPal confirms this deal's payment of ${money} completed (capture ${deal.payment!.webhook!.captureId}).`;
  } else if (!deal.order || deal.order.status === 'CREATED') {
    verdict = 'not_paid';
    answer = "PayPal has no payment for this deal: the buyer hasn't paid through this deal's checkout.";
  } else if (read?.ok && read.mismatches.length > 0) {
    verdict = 'not_paid';
    answer = `PayPal's order doesn't match the card you both confirmed (${read.mismatches.join('; ')}), so it doesn't count as this deal's payment.`;
  } else if (read?.ok && read.captureStatus === 'COMPLETED') {
    verdict = 'not_paid';
    answer = "PayPal's order shows the capture completed, but PayPal's verified payment notification hasn't arrived yet. Wait for it before shipping.";
  } else {
    verdict = 'not_paid';
    answer = `PayPal doesn't show this deal's payment as completed${read?.ok ? ` (status ${read.captureStatus ?? read.orderStatus})` : ''}.`;
  }

  const captureId = isPaid(deal) ? deal.payment!.webhook!.captureId : undefined;
  const notes = text.trim() ? notesFor(deal, text, captureId) : [];
  if (verdict !== 'paid' && text.trim()) notes.unshift('Whatever this message says, it is not PayPal\'s record. Settle Link only trusts PayPal\'s own answer.');

  await deps.store.addReceipt({
    dealId,
    kind: 'paid.checked',
    at,
    // The pasted text is not kept: only the verdict and how many disagreements were found.
    data: { verdict, notes: notes.length, orderId: deal.order?.id ?? null, debugId: read?.debugId ?? null },
  });
  return { verdict, answer, notes, checkedAt: at };
}
