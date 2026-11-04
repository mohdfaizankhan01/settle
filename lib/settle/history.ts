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
    case 'order.capture_requested':
      return `Capture requested; PayPal said ${s(d.captureStatus) || s(d.orderStatus)}. This is not yet confirmation.`;
    case 'payment.checked':
      return d.paid
        ? `Payment confirmed: ${d.trigger === 'webhook' ? 'verified PayPal webhook' : 'PayPal'} plus a fresh read of the order that matches the card.`
        : !d.readOk
          ? "Couldn't read the order from PayPal; payment not confirmed."
          : `Order read from PayPal: ${s(d.captureStatus) || s(d.orderStatus)}${(d.mismatches as string[]).length ? `, but ${(d.mismatches as string[]).join('; ')}` : ''}${d.ignored ? ` (event ignored: ${s(d.ignored)})` : ''}.`;
    case 'gate.decided':
      return `Ship check: ${d.decision === 'SHIP' ? 'ready to ship' : d.decision === 'HOLD' ? 'hold' : 'review'}.`;
    case 'messages.added':
      return `The ${s(d.by)} added ${(d.messages as unknown[]).length} message${(d.messages as unknown[]).length === 1 ? '' : 's'} from after payment${seller ? `; ${(d.warnings as unknown[]).length} warning${(d.warnings as unknown[]).length === 1 ? '' : 's'} found` : ''}.`;
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
  const chain = verifyChain(receipts);
  const items: HistoryItem[] = receipts
    .filter((r) => role === 'seller' || BUYER_SEES.has(r.kind))
    .map((r) => {
      const debugId = typeof r.data.debugId === 'string' ? r.data.debugId : null;
      return { seq: r.seq, at: r.at, text: describe(r, role), debugId, replayed: !!debugId?.startsWith('rec-') || r.data.replayed === true };
    });
  return { items, chain: chain.ok ? { ok: true as const, count: chain.count } : { ok: false as const, brokenAt: chain.brokenAt, reason: chain.reason } };
}
