// The ship gate (PLAN M3): "Ship / Hold / Review" with a protection checklist built from
// docs/protection-terms.md. Pure: it reads the deal and decides, so it is easy to test and the
// same rules run everywhere. Fail closed: anything Settle can't check is never a pass, an unpaid
// or unconfirmed payment always holds, and the AI's warnings can only add HOLD or REVIEW.
// Wording (DECISIONS #7): never "protected" or "safe"; PayPal decides eligibility.

import { StaleWriteError, type DealStore } from './store';
import type { Deal } from './types';

export type CheckStatus = 'pass' | 'fail' | 'not_yet' | 'cant_check';
export type Decision = 'SHIP' | 'HOLD' | 'REVIEW';
export type CheckId = 'payment' | 'address' | 'tracking' | 'delivery' | 'warnings';

export type GateCheck = {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** One plain sentence: what Settle saw. */
  detail: string;
  /** Row IDs in docs/protection-terms.md. */
  cites: string[];
  /** What this check does to the decision when it isn't a pass. */
  blocks?: Exclude<Decision, 'SHIP'>;
  /** Where the evidence is: a PayPal request, a message, or something the seller typed. */
  proof?: string;
};

export type Gate = { decision: Decision; headline: string; reasons: string[]; checks: GateCheck[]; note: string };

export const GATE_NOTE = 'Meets the checks we can verify. PayPal decides eligibility.';

/** True only when a verified event and the latest fresh GET agree the capture completed. */
export function isPaid(deal: Deal): boolean {
  const { webhook, read } = deal.payment ?? {};
  return (
    !!webhook &&
    !!read?.ok &&
    read.orderStatus === 'COMPLETED' &&
    read.captureStatus === 'COMPLETED' &&
    read.captureId === webhook.captureId &&
    read.mismatches.length === 0
  );
}

/** Signals after payment that mean "don't ship yet"; any other warning means "look first". */
const HOLD_SIGNALS = new Set(['ship_elsewhere', 'fake_payment_proof', 'overpayment_refund', 'code_request']);

/** UK postcodes compare without spaces or case; US ZIPs compare on the first five digits. */
export function normalPostcode(raw: string, country: Deal['country']): string {
  const s = raw.toUpperCase().replace(/\s+/g, '');
  return country === 'US' ? s.replace(/[^0-9]/g, '').slice(0, 5) : s;
}

const addedIds = (deal: Deal) => new Set(deal.messages.filter((m) => m.added).map((m) => m.id));

function paymentCheck(deal: Deal): GateCheck {
  const base = { id: 'payment' as const, label: 'Payment confirmed by PayPal', cites: ['SP-RELEASE', ...(deal.country === 'UK' ? ['SP-SINGLE'] : [])], blocks: 'HOLD' as const };
  const read = deal.payment?.read;
  const proof = read?.debugId ? `Fresh GET of order ${deal.order?.id} (PayPal debug ID ${read.debugId})` : undefined;
  if (isPaid(deal)) {
    const via = deal.payment!.webhook!.via === 'webhook' ? 'a verified webhook' : "PayPal's webhook event log";
    return { ...base, status: 'pass', detail: `Capture ${deal.payment!.webhook!.captureId} completed, confirmed by ${via} and a fresh read of the order, which matches the card.`, proof };
  }
  if (!deal.order || deal.order.status === 'CREATED') return { ...base, status: 'not_yet', detail: 'The buyer has not paid yet.' };
  if (!read) return { ...base, status: 'not_yet', detail: 'Waiting for PayPal to confirm the payment.' };
  if (!read.ok) return { ...base, status: 'cant_check', detail: "Couldn't reach PayPal to check the payment. This is not the same as unpaid; try again shortly.", proof };
  if (read.mismatches.length > 0) return { ...base, status: 'fail', detail: `The PayPal order doesn't match the confirmed card: ${read.mismatches.join('; ')}.`, proof };
  if (read.captureStatus !== 'COMPLETED') {
    return { ...base, status: 'fail', detail: `PayPal shows the payment as ${read.captureStatus ?? read.orderStatus}, not completed. Don't ship until it is.`, proof };
  }
  return { ...base, status: 'not_yet', detail: "PayPal's order shows the capture completed; waiting for PayPal's payment notification to confirm it.", proof };
}

function deliveryCheck(deal: Deal): GateCheck {
  const d = deal.card.delivery?.value;
  const base = { id: 'delivery' as const, label: 'Delivery method covered' };
  if (d === 'post' || d === 'courier') return { ...base, status: 'pass', detail: `${deal.card.delivery!.display}: a shipped, physical item.`, cites: ['SP-PHYSICAL'] };
  if (d === 'collect' || d === 'meetup') {
    return { ...base, status: 'fail', blocks: 'REVIEW', detail: 'An in-person handover is not eligible for Seller Protection.', cites: ['SP-INPERSON', 'PP-COLLECT'] };
  }
  return { ...base, status: 'cant_check', blocks: 'REVIEW', detail: 'Digital or other deliveries have their own requirements that Settle does not check.', cites: ['SP-PHYSICAL'] };
}

function addressCheck(deal: Deal): GateCheck {
  const base = { id: 'address' as const, label: 'Ship to the address on the PayPal payment', cites: ['SP-ADDR', 'SP-BUYER-SHIP'], blocks: 'HOLD' as const };
  const ids = addedIds(deal);
  const elsewhere = deal.warnings.find((w) => w.signalId === 'ship_elsewhere' && w.messageId && ids.has(w.messageId));
  if (elsewhere) {
    return { ...base, status: 'fail', detail: `Message ${elsewhere.messageId} after payment asks to ship somewhere else. Seller Protection needs the address on the PayPal payment.`, proof: `Message ${elsewhere.messageId}` };
  }
  const read = deal.payment?.read;
  const shipTo = read?.ok ? read.shipTo : undefined;
  if (!shipTo?.postalCode) {
    return { ...base, status: read && !read.ok ? 'cant_check' : 'not_yet', detail: 'No PayPal shipping address yet; it comes with the confirmed payment.' };
  }
  const paypalCode = normalPostcode(shipTo.postalCode, deal.country);
  const later = deal.tokens.filter((t) => ids.has(t.messageId) && (t.kind === 'POSTCODE' || t.kind === 'ZIP'));
  const other = later.find((t) => normalPostcode(t.raw, deal.country) !== paypalCode);
  if (other) {
    return { ...base, status: 'fail', detail: `Message ${other.messageId} after payment gives postcode ${other.raw}, but PayPal's address is ${shipTo.postalCode}.`, proof: `Message ${other.messageId}` };
  }
  const label = deal.shipping?.labelPostcode;
  if (!label) return { ...base, status: 'not_yet', blocks: 'REVIEW', detail: `PayPal's address is shown below (postcode ${shipTo.postalCode}). Type the postcode from your label to compare.` };
  if (normalPostcode(label.value, deal.country) !== paypalCode) {
    return { ...base, status: 'fail', detail: `Your label says ${label.value}, but PayPal's address is ${shipTo.postalCode}.`, proof: 'Postcode typed by the seller' };
  }
  return { ...base, status: 'pass', detail: `Your label's postcode matches PayPal's address (${shipTo.postalCode}).`, proof: 'PayPal order shipping address; postcode typed by the seller' };
}

function trackingCheck(deal: Deal): GateCheck {
  // Tracking comes after handing the parcel over, so "not yet" never blocks shipping.
  const base = { id: 'tracking' as const, label: 'Tracking added to PayPal', cites: ['SP-PROOF-SHIP', 'SP-PROOF-DELIV'] };
  const t = deal.shipping?.tracking;
  if (!t) return { ...base, status: 'not_yet', detail: 'Add the tracking number after you post it. PayPal needs proof of shipment and delivery.' };
  const read = deal.payment?.read;
  const captureId = read?.ok ? read.captureId : undefined;
  const shown = read?.ok && (read.trackers ?? []).some((id) => id === `${captureId}-${t.number}` || id.endsWith(`-${t.number}`));
  if (shown) return { ...base, status: 'pass', detail: `PayPal shows tracking ${t.number} (${t.carrier}) on the order.`, proof: `Fresh GET of order ${deal.order?.id}` };
  if (read && !read.ok) return { ...base, status: 'cant_check', detail: `Couldn't reach PayPal to see tracking ${t.number} on the order.` };
  if (t.state === 'unknown') return { ...base, status: 'cant_check', detail: `PayPal didn't answer when tracking ${t.number} was sent, and it isn't on the order yet. Try adding it again.` };
  return { ...base, status: 'not_yet', detail: `Tracking ${t.number} was sent to PayPal; waiting to see it on the order.`, proof: t.debugId ? `PayPal debug ID ${t.debugId}` : undefined };
}

function warningsCheck(deal: Deal): GateCheck {
  const base = { id: 'warnings' as const, label: 'No warnings since payment' };
  const ids = addedIds(deal);
  const later = deal.warnings.filter((w) => w.messageId && ids.has(w.messageId));
  if (deal.addedCheck?.status === 'failed') {
    return { ...base, status: 'cant_check', blocks: 'REVIEW', cites: [], detail: 'The warning check did not run on messages added after payment. Read them yourself before shipping.' };
  }
  if (later.length > 0) {
    const hold = later.some((w) => HOLD_SIGNALS.has(w.signalId));
    const signals = [...new Set(later.map((w) => w.signalId))];
    return {
      ...base,
      status: 'fail',
      blocks: hold ? 'HOLD' : 'REVIEW',
      cites: [...new Set(later.flatMap((w) => w.cites))],
      detail: `Warning${signals.length > 1 ? 's' : ''} in messages after payment: ${signals.join(', ')}.`,
      proof: [...new Set(later.map((w) => `Message ${w.messageId}`))].join(', '),
    };
  }
  return { ...base, status: 'pass', cites: [], detail: ids.size > 0 ? `No warning signs found in ${ids.size} message${ids.size > 1 ? 's' : ''} added after payment.` : 'No messages added after payment.' };
}

export function shipGate(deal: Deal): Gate {
  const checks = [paymentCheck(deal), addressCheck(deal), deliveryCheck(deal), trackingCheck(deal), warningsCheck(deal)];
  const open = checks.filter((c) => c.status !== 'pass' && c.blocks);
  const decision: Decision = open.some((c) => c.blocks === 'HOLD') ? 'HOLD' : open.length > 0 ? 'REVIEW' : 'SHIP';
  const reasons = open.filter((c) => c.blocks === decision).map((c) => `${c.detail} (${c.cites.join(', ') || 'Settle check'})`);
  const headline =
    decision === 'SHIP' ? 'Ready to ship to the PayPal address' : decision === 'HOLD' ? "Hold: don't ship yet" : 'Review before shipping';
  return { decision, headline, reasons, checks, note: GATE_NOTE };
}

/** A short key for the gate's state, so a receipt is written only when something changed. */
export const gateKey = (g: Gate) => `${g.decision}|${g.checks.map((c) => `${c.id}:${c.status}`).join(',')}`;

/**
 * Every gate decision writes a receipt (CLAUDE.md). Called after anything that can change the
 * gate; writes only when the decision or a check's status changed since the last receipt.
 */
export async function syncGate(store: DealStore, dealId: string, at: string): Promise<Gate | undefined> {
  for (let attempt = 0; ; attempt++) {
    const stored = await store.getDeal(dealId);
    if (!stored?.value.order) return undefined;
    const gate = shipGate(stored.value);
    const key = gateKey(gate);
    if (stored.value.gate?.key === key) return gate;
    try {
      await store.updateDeal(dealId, stored.version, { ...stored.value, gate: { decision: gate.decision, key, at } });
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
      continue;
    }
    await store.addReceipt({
      dealId,
      kind: 'gate.decided',
      at,
      data: { decision: gate.decision, checks: gate.checks.map((c) => ({ id: c.id, status: c.status, cites: c.cites })), reasons: gate.reasons },
    });
    return gate;
  }
}
