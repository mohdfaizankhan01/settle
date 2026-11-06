// What one side sees on the deal page. Warnings are filtered to the side they're for, each
// with its advice template, citations and the message it was found in. Wording rules
// (DECISIONS #7): "No warning signs found" only when the check ran; never "safe".

import { blockers, cardHash, formatMoney, isHandoverDeal, isLocked, moneyOf, paysByHold } from './card';
import { CARRIERS } from './carriers';
import { HOLD_REPLAY_NOTE, REPLAY_NOTE } from './demo-paypal';
import { caseFile, REASON_LABELS } from './case-file';
import { ADVICE_LABEL, disputePlan } from './dispute-plan';
import { history } from './history';
import type { Receipt } from './receipts';
import type { Role } from './chat';
import { payBlocker } from './checkout';
import { DECLINE_REASONS } from './deals';
import { FEE_RATES } from './fees';
import { CODE_TTL_MS, holdDeadline, HOLD_DAYS, isHeld } from './handover';
import { isPaid, readFailedLast, shipGate } from './ship-gate';
import { shownTo, signalById, TERM_SIGNALS } from './signals';
import { CURRENCY_OF, type Currency, type Deal, type TermKey, type TermSource } from './types';

export const SIMULATED_NOTE =
  "PayPal sandbox: no real money moves. The warning check is Settle Link's own small model, running on our server over a redacted copy of the chat.";

/** Warnings explain; they never decide (problem statement, build change 3). */
export const EXPLAIN_NOTE =
  "Settle's AI explains these warnings from the chat. It never approves a payment or a shipment: that comes from PayPal's own records and from both of you.";

const TERM_LABELS: Record<TermKey, string> = { item: 'Item', price: 'Price', delivery: 'Delivery', shipBy: 'Ship by', feePayer: "PayPal's fee paid by" };

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

const MEMORY_TITLES: Record<NonNullable<Deal['memory']>['hits'][number]['kind'], string> = {
  payee: "This seller's PayPal account was reported before",
  payer: "This buyer's PayPal account was reported before",
  postcode: 'This delivery postcode was reported before',
  message: 'This message was reported before',
};

export function dealView(deal: Deal, role: Role, receipts: readonly Receipt[] = []) {
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
  // A decline by the other side is the clearest warning Settle can show, so it goes first.
  const otherRole: Role = role === 'seller' ? 'buyer' : 'seller';
  const declinedByOther = (deal.declines ?? []).find((d) => d.role === otherRole);
  const declineWarning = declinedByOther
    ? [{
        signalId: 'declined',
        title: `The ${otherRole} declined this deal link`,
        means: `Reason they gave: ${DECLINE_REASONS[declinedByOther.reason]}.`,
        todo:
          declinedByOther.reason === 'wants_ff' || declinedByOther.reason === 'wants_other_payment'
            ? "Paying outside PayPal checkout loses PayPal's protections for both of you. The fee is shown on the card, and either side can cover it."
            : 'Agree the terms in the chat; they can withdraw their decline from their own link.',
        cites: declinedByOther.reason === 'wants_ff' ? ['PP-FF', 'SP-FF'] : declinedByOther.reason === 'wants_other_payment' ? ['PP-OFF-PAYPAL'] : [],
        found: [{ by: 'decline', probability: null, matched: null }],
        quote: null,
      }]
    : [];
  // Scam memory (DECISIONS #20): identifiers of the other side that other deals reported. A report
  // from other people, never proof; shown only to the side that could be hurt.
  const memoryWarnings = (deal.memory?.hits ?? [])
    .filter((h) => h.about !== role)
    .map((h) => {
      const m = h.messageId ? deal.messages.find((x) => x.id === h.messageId) : undefined;
      return {
        signalId: `memory-${h.kind}${h.messageId ? `-${h.messageId}` : ''}`,
        title: MEMORY_TITLES[h.kind],
        means: `${h.count} other deals in the last 90 days reported ${h.kind === 'message' ? 'this exact message' : 'it'}: declined for wanting to leave PayPal, or marked as a scam. That's a report from other people, not proof.${deal.demo ? ' Judge mode: the earlier reports are seeded demo data.' : ''}`,
        todo:
          role === 'buyer'
            ? 'Pay only through the PayPal checkout on this page, and stop if they push you to pay any other way.'
            : "Don't ship or hand anything over until this page says PayPal confirmed the payment, and only to PayPal's address.",
        cites: [] as string[],
        found: [{ by: 'memory', probability: null as number | null, matched: null as string | null }],
        quote: m ? { messageId: m.id, from: m.role, text: m.text } : null,
        canAnswer: false,
      };
    });
  const warnings = [...declineWarning.map((w) => ({ ...w, canAnswer: false })), ...memoryWarnings, ...[...bySignal.values()].map((w) => ({ ...w, canAnswer: true }))];

  const handover = isHandoverDeal(deal);
  const terms = (['item', 'price', 'delivery', 'shipBy', 'feePayer'] as const).map((key) => {
    const t = deal.card[key];
    // In-person deals: the agreed date is when they meet, not when something ships.
    const label = key === 'shipBy' && handover ? 'Meet by' : TERM_LABELS[key];
    return { key, label, display: t?.display ?? null, source: t ? sourceView(deal, t.source) : null };
  });

  const other: Role = role === 'seller' ? 'buyer' : 'seller';
  const confirmedNow = (r: Role) => deal.confirmations.find((c) => c.role === r && c.cardHash === hash)?.at ?? null;

  return {
    id: deal.id,
    role,
    country: deal.country,
    currency: CURRENCY_OF[deal.country],
    simulated: SIMULATED_NOTE,
    // What's real on this screen (PLAN M5 MUST): PayPal live sandbox or replayed, and whether the
    // warning check ran and which model ran it.
    realness: {
      mode: deal.demo ? ('judge' as const) : ('live' as const),
      paypal: deal.demo ? (paysByHold(deal) ? HOLD_REPLAY_NOTE : REPLAY_NOTE) : 'PayPal: live calls to the PayPal sandbox. No real money moves.',
      check:
        deal.check.status === 'ran'
          ? `Warning check: ran on ${deal.check.at.slice(0, 10)} with ${deal.check.model?.startsWith('jev') ? 'Jev (TypeSafe)' : `Settle Link's own model (${deal.check.model ?? 'local'})`} plus keyword rules, over a redacted copy of the chat.`
          : 'Warning check: did not run, so nothing on this card can be confirmed yet.',
    },
    check:
      deal.check.status === 'ran'
        ? { status: 'ran' as const, label: warnings.length === 0 ? 'No warning signs found' : `${warnings.length} warning${warnings.length > 1 ? 's' : ''} for you` }
        : {
            status: 'failed' as const,
            label: deal.check.reason?.startsWith('ChatTooLongError')
              ? 'This chat is too long for the warning check. Make a new link from just the part where you agreed the deal.'
              : 'The warning check did not run, so this card cannot be confirmed yet.',
          },
    warnings,
    messages: deal.messages.map((m) => ({ id: m.id, from: m.role, text: m.text, added: m.added ? { by: m.added.by, at: m.added.at } : null })),
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
    explainNote: EXPLAIN_NOTE,
    money: (() => {
      const m = moneyOf(deal);
      const c = CURRENCY_OF[deal.country];
      return m
        ? { total: formatMoney(m.total, c), fee: formatMoney(m.fee, c), sellerGets: formatMoney(m.sellerGets, c), feePayer: deal.card.feePayer!.value, rate: FEE_RATES[deal.country] }
        : null;
    })(),
    myDecline: (deal.declines ?? []).find((d) => d.role === role)?.reason ?? null,
    declineReasons: DECLINE_REASONS,
    blockers: blockers(deal),
    cardHash: hash,
    confirmed: { seller: confirmedNow('seller'), buyer: confirmedNow('buyer') },
    locked: isLocked(deal),
    payee: { connected: !!deal.payeeMerchantId, merchantId: role === 'seller' ? (deal.payeeMerchantId ?? null) : null },
    order: deal.order ? { id: deal.order.id, status: deal.order.status } : null,
    payBlocker: payBlocker(deal) ?? null,
    // What the buyer's browser needs to show PayPal's buttons: the JS SDK needs the seller's merchant
    // ID (PayPal shows the payee at checkout anyway) and the total for its eligibility check. The
    // browser never sends an amount or payee back; the server builds the order from the card.
    checkout:
      role === 'buyer' && !deal.demo && isLocked(deal) && deal.payeeMerchantId && moneyOf(deal)
        ? { clientId: process.env.PAYPAL_CLIENT_ID ?? '', merchantId: deal.payeeMerchantId, amount: moneyOf(deal)!.total, currency: deal.card.price!.value.currency, hold: handover }
        : null,
    // After payment (PLAN M3): what PayPal confirmed, and for the seller, the ship gate.
    afterPayment: deal.order && deal.order.status !== 'CREATED' ? afterPaymentView(deal, role, receipts) : null,
    // The deal's history from its receipts, and whether the chain verifies (M5).
    history: history(receipts, role),
    canEnter: role === 'seller' ? (['item', 'price'] as const).filter((k) => !deal.card[k] || deal.card[k]!.source.kind === 'entered') : [],
  };
}

/** Meet-up deals (DECISIONS #20): where the hold and the handover stand, for both sides. */
function handoverView(deal: Deal) {
  const h = deal.handover;
  const total = moneyOf(deal) ? formatMoney(moneyOf(deal)!.total, CURRENCY_OF[deal.country]) : null;
  const deadline = holdDeadline(deal);
  // Released but not COMPLETED (e.g. PENDING): the money hasn't moved, so it isn't "handed over".
  // Released, but not yet confirmed the way every payment is (verified webhook plus a fresh read):
  // nobody is told to hand over until it is (code review: a capture answer alone isn't enough).
  const pending = h?.outcome?.kind === 'released' && !(isPaid(deal) && !readFailedLast(deal));
  const state = pending ? 'pending' : (h?.outcome?.kind ?? (h?.inFlight ? (h.inFlight.kind === 'release' ? 'releasing' : 'releasing_hold') : isHeld(deal) ? 'held' : 'waiting'));
  return {
    state,
    total,
    holdDays: HOLD_DAYS,
    deadline: deadline?.toISOString() ?? null,
    by: h?.outcome?.by ?? null,
    captureStatus: h?.outcome?.captureStatus ?? null,
    at: h?.outcome?.at ?? null,
    debugId: h?.outcome?.debugId ?? null,
    failed: h?.failed ? { kind: h.failed.kind, reason: h.failed.reason, at: h.failed.at, debugId: h.failed.debugId ?? null } : null,
    // A code shown in the last few minutes, so the seller's screen can say one is live.
    codeMinutes: CODE_TTL_MS / 60_000,
    canCancel: isHeld(deal),
  };
}

function afterPaymentView(deal: Deal, role: Role, receipts: readonly Receipt[]) {
  const read = deal.payment?.read;
  const paid = isPaid(deal) && !readFailedLast(deal);
  const c = CURRENCY_OF[deal.country];
  const estimate = moneyOf(deal)?.fee;
  const handover = paysByHold(deal) ? handoverView(deal) : null;
  const total = moneyOf(deal) ? formatMoney(moneyOf(deal)!.total, c) : '';
  const holdPayment =
    !handover || paid || readFailedLast(deal)
      ? null
      : handover.state === 'voided'
        ? { state: 'voided' as const, text: 'PayPal released the hold. The buyer was not charged.' }
        : handover.state === 'pending'
          ? handover.captureStatus && handover.captureStatus !== 'COMPLETED'
            ? { state: 'problem' as const, text: `PayPal shows the payment as ${handover.captureStatus}, not completed. Don't hand the item over until it is.` }
            : { state: 'waiting' as const, text: "The buyer confirmed and PayPal took the money. Waiting for PayPal's verified payment notification: don't hand the item over until this page says Handed over." }
        : handover.state === 'released'
          ? { state: 'waiting' as const, text: "The money was taken at the handover. Waiting for PayPal's verified payment notification before it counts." }
          : handover.state === 'held' || handover.state === 'releasing' || handover.state === 'releasing_hold'
            ? { state: 'held' as const, text: `PayPal holds ${total} on the buyer's account: confirmed by a verified PayPal notification and a fresh read of the order. Nothing is taken until the buyer scans the seller's code at the handover.` }
            : read?.ok && read.mismatches.length > 0
              ? { state: 'problem' as const, text: `The PayPal order doesn't match the card: ${read.mismatches.join('; ')}.` }
              : { state: 'waiting' as const, text: "Waiting for PayPal to confirm the hold. Don't meet to hand over until it does." };
  const payment = holdPayment ?? (readFailedLast(deal)
    ? { state: 'cant_check' as const, text: "Couldn't reach PayPal on the last check. That isn't the same as unpaid; Settle tries again when the page reloads." }
    : paid
    ? { state: 'paid' as const, text: 'PayPal confirmed the payment: a verified PayPal notification and a fresh read of the order both match the card.' }
    : read && !read.ok
      ? { state: 'cant_check' as const, text: "Couldn't reach PayPal to check the payment. That isn't the same as unpaid; Settle tries again when the page reloads." }
      : read?.ok && (read.mismatches.length > 0 || (read.captureStatus && read.captureStatus !== 'COMPLETED'))
        ? { state: 'problem' as const, text: read.mismatches.length > 0 ? `The PayPal order doesn't match the card: ${read.mismatches.join('; ')}.` : `PayPal shows the payment as ${read.captureStatus}.` }
        : read?.ok && read.captureStatus === 'COMPLETED'
          ? { state: 'waiting' as const, text: "PayPal's order shows the payment completed. Waiting for PayPal's verified payment notification before it counts; the seller shouldn't ship until then." }
          : { state: 'waiting' as const, text: "Waiting for PayPal's payment notification. The seller shouldn't ship until PayPal confirms it." });
  const seller = role === 'seller';
  return {
    payment,
    checkedAt: read?.at ?? null,
    // PayPal's actual fee from the capture, next to Settle's estimate (docs/fees.md).
    fee: seller && read?.ok && read.fee ? { actual: formatMoney(read.fee, c), estimate: estimate ? formatMoney(estimate, c) : null, net: read.net ? formatMoney(read.net, c) : null } : null,
    // Meet-up deals have no ship gate; the handover panel takes its place.
    gate: seller && !handover ? shipGate(deal) : null,
    handover,
    shipTo: seller && !handover && read?.ok ? (read.shipTo ?? null) : null,
    labelPostcode: seller ? (deal.shipping?.labelPostcode?.value ?? null) : null,
    tracking: deal.shipping?.tracking ? { carrier: CARRIERS[deal.country].find((x) => x.id === deal.shipping!.tracking!.carrier)?.label ?? deal.shipping.tracking.carrier, number: deal.shipping.tracking.number, state: deal.shipping.tracking.state } : null,
    carriers: seller ? CARRIERS[deal.country].map((x) => ({ id: x.id as string, label: x.label })) : [],
    postcodeLabel: deal.country === 'US' ? 'ZIP code' : 'Postcode',
    delivered: deal.shipping?.delivered?.date ?? null,
    // Disputes (M4): the seller gets the case file and advice; the buyer only sees that one is open.
    disputes: (deal.disputes ?? []).map((d) => {
      const base = { id: d.id, reason: REASON_LABELS[d.reason] ?? d.reason, stage: d.stage, status: d.status, amount: d.amount ? formatMoney(d.amount.value, d.amount.currency as Currency) : null, dueDate: d.dueDate ?? null, outcome: d.outcome ?? null, readAt: d.readAt, failedAt: d.failed?.at ?? null };
      if (!seller) return { ...base, caseFile: null, plan: null, adviceLabels: null, submissions: [] };
      const cf = caseFile(deal, d, receipts);
      return {
        ...base,
        caseFile: cf,
        plan: disputePlan(cf, d),
        adviceLabels: ADVICE_LABEL,
        submissions: (deal.submissions ?? []).filter((x) => x.disputeId === d.id).map((x) => ({ rel: x.rel, state: x.state, at: x.at, debugId: x.debugId ?? null })),
      };
    }),
  };
}

export type DealView = ReturnType<typeof dealView>;
