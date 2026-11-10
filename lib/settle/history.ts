// The deal's history (PLAN M5 SHOULD, moved from M3): each receipt as one plain sentence, with
// the PayPal debug ID where there is one, and whether the receipt chain verifies. Receipts hold
// decisions and IDs, never chat text. The buyer sees an allowlist of steps, without the seller's
// ship-check decisions, merchant ID or seller-only warning counts.

import { verifyChain, type Receipt } from './receipts';
import type { Role } from './chat';

export type HistoryItem = { seq: number; at: string; text: string; debugId: string | null; replayed: boolean };

/** What the buyer may see. An allowlist, so a new kind of receipt stays hidden from the buyer by default. */
const BUYER_SEES = new Set([
  'deal.checked',
  'deal.rechecked',
  // The AI reader (PLAN M8): both sides see how the card was read.
  'reader.ran',
  'reader.skipped',
  'reader.failed',
  'reader.read_again',
  'claim.removed',
  'question.answered',
  'term.entered',
  'payee.connected',
  'card.confirmed',
  'deal.declined',
  'deal.decline_withdrawn',
  'order.created',
  'capture.blocked',
  'capture.failed',
  'order.capture_requested',
  'payment.checked',
  'messages.added',
  'tracking.added',
  'shipping.delivered',
  'dispute.read',
  // Meet-up mode: both sides see every step of the hold and the handover.
  'link.claimed',
  'payer.claimed',
  'order.hold_requested',
  'handover.code_shown',
  'handover.blocked',
  'handover.release_requested',
  'handover.released',
  'handover.release_failed',
  'handover.voided',
  'handover.void_failed',
  'handover.unknown',
]);

const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export function describe(r: Receipt, role: Role = 'seller'): string {
  const seller = role === 'seller';
  const d = r.data as Record<string, unknown>;
  switch (r.kind) {
    case 'deal.checked':
      // Some warnings are for the seller only, so the buyer isn't told how many there were.
      return d.check === 'ran'
        ? `Warning check ran${d.model ? ` (${s(d.model)})` : ''}${seller ? `: ${(d.warnings as unknown[]).length} warning${(d.warnings as unknown[]).length === 1 ? '' : 's'}` : ''}.`
        : 'Warning check did not run; the card cannot be confirmed until it does.';
    case 'deal.rechecked':
      return `Warning check run again: ${s(d.check)}.`;
    case 'reader.ran': {
      const cases = Object.values((d.cases ?? {}) as Record<string, string>);
      const agree = cases.filter((c) => c === 'agree').length;
      const asked = cases.filter((c) => c === 'disagree' || c === 'both_unsure').length;
      const how = d.source === 'recorded' ? 'Recorded reading' : d.source === 'cache' ? 'Earlier reading' : 'AI reader';
      return `${how} (${s(d.model)}) read the card: code and the AI agreed on ${agree} term${agree === 1 ? '' : 's'}, ${asked} became ${asked === 1 ? 'a question' : 'questions'}, ${s(d.claims)} line${d.claims === 1 ? '' : 's'} from the seller about the item.`;
    }
    case 'reader.skipped':
    case 'reader.failed':
      return `The AI reader didn't run (${s(d.reason)}); the card was read by code only.`;
    case 'reader.read_again':
      return `The ${s(d.by)} asked the AI reader to read the card again.`;
    case 'claim.removed':
      return `The ${s(d.by)} marked one thing the seller said as not part of the deal.`;
    case 'question.answered':
      return `The ${s(d.by)} answered a question about the terms.`;
    case 'term.entered':
      return `The ${s(d.by)} typed in the ${s(d.term)}.`;
    case 'payee.connect_started':
      return 'The seller started connecting their PayPal account.';
    case 'payee.connected':
      return `The seller's PayPal account was connected${seller ? ` (${s(d.merchantId)})` : ''}; confirmations were cleared.`;
    case 'card.confirmed':
      return `The ${s(d.by)} confirmed the card${d.locked ? '; both have now confirmed, so it is locked' : ''}.`;
    case 'deal.declined':
      return `The ${s(d.by)} declined the deal.`;
    case 'deal.decline_withdrawn':
      return `The ${s(d.by)} withdrew their decline.`;
    case 'order.created':
      return `PayPal order ${s(d.orderId)} created from the locked card.`;
    case 'capture.blocked':
      return `Capture refused before calling PayPal: ${s(d.reason) || ((d.reasons as string[] | undefined) ?? []).join('; ')}.`;
    case 'capture.failed':
      return 'The capture request to PayPal failed; PayPal was read again to settle it.';
    case 'memory.reported':
      return `The ${s(d.by)} reported the ${s(d.about)} to scam memory (${d.reason === 'declined' ? 'declined the deal' : 'marked a warning as a scam'}): ${(d.kinds as string[]).length ? (d.kinds as string[]).join(', ') : 'nothing to remember yet'}, kept as one-way hashes.`;
    case 'memory.matched':
      return (d.hits as unknown[]).length
        ? `Scam memory: ${(d.hits as { kind: string; about: string; count: number }[]).map((h) => `the ${h.about}'s ${h.kind} was reported by ${h.count} other deals`).join('; ')}.`
        : 'Scam memory: no reports match this deal now.';
    case 'warning.answered':
      return `The ${s(d.by)} answered "was this a scam?" for ${s(d.signal)}: ${s(d.verdict).replace('_', ' ')}.`;
    case 'payer.claimed':
      return "The buyer's device started the PayPal hold; only that device can place and release it.";
    case 'link.claimed':
      return `The ${s(d.role)}'s link was opened, and now works only on that device.`;
    case 'order.hold_requested':
      return `Hold requested; PayPal said ${s(d.authorizationStatus) || s(d.orderStatus)}. Nothing is taken until the handover.`;
    case 'handover.code_shown':
      return 'The seller showed a handover code (valid 10 minutes).';
    case 'handover.blocked':
      return `Handover refused: ${s(d.reason)}`;
    case 'handover.release_requested':
      return 'The buyer scanned the code and confirmed the handover; Settle asked PayPal to take the held money.';
    case 'handover.released':
      return `PayPal took the held money (capture ${s(d.captureId)}, ${s(d.captureStatus) || 'status unknown'}). Payment counts once PayPal's verified notification arrives.`;
    case 'handover.release_failed':
      return `PayPal did not take the money (${s(d.reason)}); it stays held.`;
    case 'handover.voided':
      return d.by === 'meet_by_passed'
        ? "No handover within PayPal's 3-day hold, so Settle released it. The buyer was not charged."
        : `The ${s(d.by)} called it off and PayPal released the hold. The buyer was not charged.`;
    case 'handover.unknown':
      return `No answer from PayPal for the ${d.kind === 'release' ? 'capture' : 'release of the hold'}; Settle checks PayPal again before deciding.`;
    case 'handover.void_failed':
      return `Releasing the hold failed (${s(d.reason)}); the money is still held.`;
    case 'order.capture_requested':
      return `Capture requested; PayPal said ${s(d.captureStatus) || s(d.orderStatus)}. This is not yet confirmation.`;
    case 'payment.checked':
      return d.paid
        ? `Payment confirmed: ${d.trigger === 'webhook' ? 'verified PayPal webhook' : 'PayPal'} plus a fresh read of the order that matches the card.`
        : d.held
          ? 'Hold confirmed: a verified PayPal notification plus a fresh read of the order that matches the card. Nothing taken yet.'
        : !d.readOk
          ? "Couldn't read the order from PayPal; payment not confirmed."
          : `Order read from PayPal: ${s(d.captureStatus) || s(d.orderStatus)}${(d.mismatches as string[]).length ? `, but ${(d.mismatches as string[]).join('; ')}` : ''}${d.ignored ? ` (event ignored: ${s(d.ignored)})` : ''}.`;
    case 'gate.decided':
      return `Ship check: ${d.decision === 'SHIP' ? 'ready to ship' : d.decision === 'HOLD' ? 'hold' : 'review'}.`;
    case 'messages.added':
      return `The ${s(d.by)} added ${(d.messages as unknown[]).length} message${(d.messages as unknown[]).length === 1 ? '' : 's'} from after payment${
        d.check !== 'ran' ? '; the warning check did not run on them' : seller ? `; ${(d.warnings as unknown[]).length} warning${(d.warnings as unknown[]).length === 1 ? '' : 's'} found` : ''
      }.`;
    case 'shipping.label_postcode':
      return `The seller typed the label postcode; it ${d.matchesPayPal ? 'matches' : d.matchesPayPal === false ? 'does not match' : 'was compared with'} PayPal's address.`;
    case 'tracking.added':
      return d.state === 'sent' ? `Tracking ${s(d.number)} added to the PayPal order${d.seenOnOrder ? ' and seen on it' : ''}.` : `Tracking ${s(d.number)} sent; PayPal didn't answer, so it was checked again.`;
    case 'tracking.failed':
      return `PayPal didn't add the tracking${d.reason ? `: ${s(d.reason)}` : ''}.`;
    case 'shipping.delivered':
      return `The seller recorded delivery on ${s(d.date)}.`;
    case 'paid.checked':
      return `"Is this paid?" answered from PayPal: ${s(d.verdict).replace('_', ' ')}.`;
    case 'dispute.read':
      return `PayPal dispute ${s(d.disputeId)}: ${s(d.stage).toLowerCase()}, ${s(d.status).toLowerCase().replaceAll('_', ' ')}.`;
    case 'dispute.ignored':
      return `A dispute was ignored: ${s(d.reason)}.`;
    case 'dispute.submitted':
      return `Response sent to PayPal with the seller's approval (${s(d.rel).replaceAll('_', ' ')}): ${s(d.state)}.`;
    case 'dispute.submit_refused':
      return `A response was not sent: ${s(d.reason)}.`;
    default:
      return r.kind;
  }
}

export function history(receipts: readonly Receipt[], role: Role) {
  // Verified on every read on purpose: a cache keyed on the last hash would hide a changed middle
  // receipt. A deal has tens of receipts, so this is a few dozen SHA-256 hashes.
  const chain = verifyChain(receipts);
  const items: HistoryItem[] = receipts
    .filter((r) => role === 'seller' || BUYER_SEES.has(r.kind))
    .map((r) => {
      const debugId = typeof r.data.debugId === 'string' ? r.data.debugId : null;
      return { seq: r.seq, at: r.at, text: describe(r, role), debugId, replayed: !!debugId?.startsWith('rec-') || r.data.replayed === true };
    });
  // The buyer sees whether the record verifies, not counts or positions from the seller's full list.
  if (role !== 'seller') return { items, chain: chain.ok ? { ok: true as const, count: null } : { ok: false as const, brokenAt: null, reason: chain.reason } };
  return { items, chain: chain.ok ? { ok: true as const, count: chain.count } : { ok: false as const, brokenAt: chain.brokenAt, reason: chain.reason } };
}
