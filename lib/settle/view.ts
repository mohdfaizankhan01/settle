// What one side sees on the deal page. Warnings are filtered to the side they're for, each
// with its advice template, citations and the message it was found in. Wording rules
// (DECISIONS #7): "No warning signs found" only when the check ran; never "safe".

import { blockers, cardHash, isLocked } from './card';
import type { Role } from './chat';
import { payBlocker } from './checkout';
import { shownTo, signalById, TERM_SIGNALS } from './signals';
import { CURRENCY_OF, type Deal, type TermKey, type TermSource } from './types';

export const SIMULATED_NOTE =
  'PayPal sandbox: no real money moves. The warning check is Jev (TypeSafe) reading a redacted copy of the chat.';

const TERM_LABELS: Record<TermKey, string> = { item: 'Item', price: 'Price', delivery: 'Delivery', shipBy: 'Ship by' };

export type SourceView =
  | { kind: 'message'; messageId: string; from: Role; quote: string }
  | { kind: 'answer'; prompt: string }
  | { kind: 'entered'; by: Role };

function sourceView(deal: Deal, source: TermSource): SourceView {
  if (source.kind === 'message') {
    const m = deal.messages.find((x) => x.id === source.messageId);
    return { kind: 'message', messageId: source.messageId, from: m?.role ?? 'buyer', quote: m?.text ?? '' };
  }
  if (source.kind === 'answer') {
    return { kind: 'answer', prompt: deal.questions.find((q) => q.id === source.questionId)?.prompt ?? 'Answered by both sides' };
  }
  return { kind: 'entered', by: source.by };
}

export function dealView(deal: Deal, role: Role) {
  const hash = cardHash(deal);

  const bySignal = new Map<string, ReturnType<typeof warningView>>();
  function warningView(w: Deal['warnings'][number]) {
    const s = signalById(w.signalId) ?? (w.signalId === 'in_person' ? TERM_SIGNALS.in_person : undefined);
    const m = w.messageId ? deal.messages.find((x) => x.id === w.messageId) : undefined;
    return {
      signalId: w.signalId,
      title: s?.title ?? w.signalId,
      means: s?.advice.means ?? '',
      todo: s?.advice.todo ?? '',
      cites: w.cites,
      found: [{ by: w.by, probability: w.probability ?? null, matched: w.matched ?? null }],
      quote: m ? { messageId: m.id, from: m.role, text: m.text } : null,
    };
  }
  for (const w of deal.warnings) {
    if (!shownTo(w.audience, role)) continue;
    const v = warningView(w);
    const prev = bySignal.get(w.signalId);
    if (prev) {
      prev.found.push(...v.found);
      prev.quote ??= v.quote;
    } else bySignal.set(w.signalId, v);
  }
  const warnings = [...bySignal.values()];

  const terms = (['item', 'price', 'delivery', 'shipBy'] as const).map((key) => {
    const t = deal.card[key];
    return { key, label: TERM_LABELS[key], display: t?.display ?? null, source: t ? sourceView(deal, t.source) : null };
  });

  const other: Role = role === 'seller' ? 'buyer' : 'seller';
  const confirmedNow = (r: Role) => deal.confirmations.find((c) => c.role === r && c.cardHash === hash)?.at ?? null;

  return {
    id: deal.id,
    role,
    country: deal.country,
    currency: CURRENCY_OF[deal.country],
    simulated: SIMULATED_NOTE,
    check:
      deal.check.status === 'ran'
        ? { status: 'ran' as const, label: warnings.length === 0 ? 'No warning signs found' : `${warnings.length} warning${warnings.length > 1 ? 's' : ''} for you` }
        : { status: 'failed' as const, label: 'The warning check did not run, so this card cannot be confirmed yet.' },
    warnings,
    messages: deal.messages.map((m) => ({ id: m.id, from: m.role, text: m.text })),
    terms,
    questions: deal.questions
      .filter((q) => !q.resolved)
      .map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options,
        mine: q.answers[role] ?? null,
        otherAnswered: !!q.answers[other],
        disagree: !!q.answers[role] && !!q.answers[other] && q.answers[role] !== q.answers[other],
      })),
    blockers: blockers(deal),
    cardHash: hash,
    confirmed: { seller: confirmedNow('seller'), buyer: confirmedNow('buyer') },
    locked: isLocked(deal),
    payee: { connected: !!deal.payeeMerchantId, merchantId: role === 'seller' ? (deal.payeeMerchantId ?? null) : null },
    order: deal.order ? { id: deal.order.id, status: deal.order.status } : null,
    payBlocker: payBlocker(deal) ?? null,
    // What the buyer's browser needs to show PayPal's buttons. Amount and payee are never sent back.
    checkout:
      role === 'buyer' && isLocked(deal) && deal.payeeMerchantId
        ? { clientId: process.env.PAYPAL_CLIENT_ID ?? '', merchantId: deal.payeeMerchantId, amount: deal.card.price!.value.amount, currency: deal.card.price!.value.currency }
        : null,
    canEnter: role === 'seller' ? (['item', 'price'] as const).filter((k) => !deal.card[k] || deal.card[k]!.source.kind === 'entered') : [],
  };
}

export type DealView = ReturnType<typeof dealView>;
