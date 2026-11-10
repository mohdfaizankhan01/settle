// The case file for a dispute (PLAN M4 MUST). Pure: it reads the deal and its receipts and lists,
// for the dispute's reason, each proof PayPal asks for as on file, missing or contradicts, with
// the docs/protection-terms.md rows it answers and where the proof came from. Nothing is assumed:
// delivery counts only if PayPal or the seller recorded it. It never says the seller will win.

import { cardHash } from './card';
import { carrierLabel } from './carriers';
import { NOT_AS_DESCRIBED, NOT_RECEIVED } from './disputes';
import type { Receipt } from './receipts';
import { claimText, redactedQuote, said } from './quote';
import { normalPostcode, trackerShown } from './ship-gate';
import type { Deal, DisputeRecord } from './types';

export type ProofStatus = 'on_file' | 'missing' | 'contradicts';
export type ProofSource = 'PayPal API' | 'Settle record' | 'Entered by the seller';

export type Proof = {
  id: string;
  label: string;
  status: ProofStatus;
  detail: string;
  cites: string[];
  source: ProofSource;
  /** How much this proof counts in the advice's score (shown as a sum, never a percentage). */
  weight: number;
  /** Tracking went on the order after the dispute opened (the buyer may not have seen it). */
  late?: boolean;
};

export type CaseFile = {
  disputeId: string;
  reason: string;
  reasonLabel: string;
  stage: string;
  status: string;
  amount?: string;
  dueDate?: string;
  proofs: Proof[];
  /** Plain notes about what Seller Protection covers for this reason. */
  notes: string[];
};

export const REASON_LABELS: Record<string, string> = {
  [NOT_RECEIVED]: 'Item not received',
  [NOT_AS_DESCRIBED]: 'Item not as described',
  UNAUTHORISED: 'Unauthorised payment',
  CREDIT_NOT_PROCESSED: 'Refund not processed',
  DUPLICATE_TRANSACTION: 'Duplicate payment',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  OTHER: 'Other',
};

const day = (iso: string) => iso.slice(0, 10);

export { redactedQuote } from './quote';

/** The ship gate's decision as it stood when tracking was first sent to PayPal. */
export function gateAtShipping(receipts: readonly Receipt[]): { decision: string; at: string } | undefined {
  const sent = receipts.find((r) => r.kind === 'tracking.added' && r.data.state === 'sent');
  if (!sent) return undefined;
  const gate = receipts.filter((r) => r.kind === 'gate.decided' && r.seq < sent.seq).at(-1);
  return gate ? { decision: String(gate.data.decision), at: gate.at } : undefined;
}

function paymentProof(deal: Deal): Proof {
  const base = { id: 'payment', label: 'Paid through PayPal checkout, on the confirmed card', cites: ['SP-FF', 'SP-SINGLE'], weight: 1 };
  const w = deal.payment?.webhook;
  return w
    ? { ...base, status: 'on_file', source: 'PayPal API', detail: `Capture ${w.captureId}, confirmed by a verified PayPal webhook and a fresh read of order ${deal.order?.id} that matched the card.` }
    : { ...base, status: 'missing', source: 'PayPal API', detail: 'Settle has no verified PayPal confirmation of this payment.' };
}

function notReceivedProofs(deal: Deal, dispute: DisputeRecord, receipts: readonly Receipt[]): Proof[] {
  const t = deal.shipping?.tracking;
  const read = deal.payment?.read;
  const shipTo = read?.ok ? read.shipTo : undefined;
  const proofs: Proof[] = [];

  // Proof of shipment: tracking PayPal shows on the order.
  const ship = { id: 'shipment', label: 'Proof of shipment: tracking on the PayPal order', cites: ['SP-PROOF-SHIP'], weight: 2, source: 'PayPal API' as const };
  if (t && trackerShown(deal, t.number)) {
    const late = !!dispute.createdAt && t.at > dispute.createdAt;
    proofs.push({ ...ship, status: 'on_file', ...(late ? { late } : {}), detail: `${carrierLabel(deal, t.carrier, t.carrierName)} tracking ${t.number} is on the PayPal order (added ${day(t.at)}).${late ? ' It was added after the dispute opened.' : ''}` });
  } else {
    proofs.push({ ...ship, status: 'missing', detail: t ? `Tracking ${t.number} was sent, but PayPal doesn't show it on the order yet.` : 'No tracking was added to the PayPal order.' });
  }

  // Proof of delivery: Settle can't see the carrier, so only what the seller recorded counts.
  const deliv = { id: 'delivery', label: 'Proof of delivery: the carrier shows delivered', cites: ['SP-PROOF-DELIV', 'SP-CARRIER'], weight: 2 };
  const d = deal.shipping?.delivered;
  proofs.push(
    d
      ? { ...deliv, status: 'on_file', source: 'Entered by the seller', detail: `The seller recorded that the carrier shows it delivered on ${d.date}.` }
      : { ...deliv, status: 'missing', source: 'Settle record', detail: "No delivery is recorded. Settle can't see the carrier's delivery status; without it the delivery can't be proved." },
  );

  // Shipped to the PayPal address.
  const addr = { id: 'address', label: 'Shipped to the address on the PayPal payment', cites: ['SP-ADDR'], weight: 1 };
  const ids = new Set(deal.messages.filter((m) => m.added).map((m) => m.id));
  const elsewhere = deal.warnings.find((w) => w.signalId === 'ship_elsewhere' && w.messageId && ids.has(w.messageId));
  const label = deal.shipping?.labelPostcode;
  if (!shipTo?.postalCode || !label) {
    proofs.push({ ...addr, status: 'missing', source: 'Settle record', detail: 'No label postcode was compared with PayPal\'s address before shipping.' });
  } else if (normalPostcode(label.value, deal.country) !== normalPostcode(shipTo.postalCode, deal.country)) {
    proofs.push({ ...addr, status: 'contradicts', source: 'Entered by the seller', detail: `The label postcode ${label.value} doesn't match PayPal's address (${shipTo.postalCode}).` });
  } else {
    proofs.push({
      ...addr,
      status: 'on_file',
      source: 'PayPal API',
      detail: `The label postcode matched PayPal's address (${shipTo.postalCode}).${elsewhere ? ` ${said(deal, elsewhere.messageId!)} asked to ship elsewhere; the seller's label shows the parcel went to PayPal's address.` : ''}`,
    });
  }

  // The ship gate when tracking went in.
  const gate = gateAtShipping(receipts);
  const g = { id: 'gate', label: 'Settle\'s ship check at shipping', cites: ['SP-RELEASE'], weight: 1, source: 'Settle record' as const };
  if (!gate) proofs.push({ ...g, status: 'missing', detail: 'No ship check was recorded before tracking was added.' });
  else if (gate.decision === 'SHIP') proofs.push({ ...g, status: 'on_file', detail: `The ship check said ready to ship on ${day(gate.at)}, before tracking was added.` });
  else proofs.push({ ...g, status: 'contradicts', detail: `The ship check said ${gate.decision === 'HOLD' ? 'hold' : 'review'} when tracking was added (${day(gate.at)}).` });

  // Delivery method.
  const how = deal.card.delivery?.value;
  const inPerson = how === 'collect' || how === 'meetup';
  proofs.push({
    id: 'method',
    label: 'Delivery method covered',
    cites: inPerson ? ['SP-INPERSON', 'PP-COLLECT'] : ['SP-PHYSICAL'],
    weight: 1,
    source: 'Settle record',
    status: inPerson ? 'contradicts' : 'on_file',
    detail: inPerson ? 'The card says the item was handed over in person, which Seller Protection excludes.' : `The confirmed card says ${deal.card.delivery?.display ?? 'shipped'}.`,
  });
  return proofs;
}

function notAsDescribedProofs(deal: Deal): Proof[] {
  const proofs: Proof[] = [];
  const both = (['seller', 'buyer'] as const).every((r) => deal.confirmations.some((c) => c.role === r && c.cardHash === cardHash(deal)));
  proofs.push({
    id: 'card',
    label: 'The card both of you confirmed',
    cites: ['PP-SNAD-DEF'],
    weight: 2,
    source: 'Settle record',
    status: both ? 'on_file' : 'missing',
    detail: both ? `Both confirmed "${deal.card.item?.display}" with fingerprint ${cardHash(deal).slice(0, 16)}….` : 'The card was not confirmed by both sides as it is now.',
  });
  const item = deal.card.item;
  const src = item?.source;
  const quote = src?.kind === 'message' ? deal.messages.find((m) => m.id === src.messageId) : undefined;
  proofs.push({
    id: 'quotes',
    label: 'Where the item description came from',
    cites: ['PP-SNAD-DEF'],
    weight: 1,
    source: src?.kind === 'entered' ? 'Entered by the seller' : 'Settle record',
    status: quote || src?.kind === 'entered' ? 'on_file' : 'missing',
    detail: quote ? `The ${quote.role}'s message ${quote.id.slice(1)} (redacted): "${redactedQuote(deal, quote.id)}"` : src?.kind === 'entered' ? 'Typed in by the seller and confirmed by the buyer.' : 'No source for the item description.',
  });
  // What the seller said about the item (PLAN M8): exact quotes both sides confirmed on the card.
  const claims = deal.card.claims ?? [];
  if (claims.length > 0) {
    const who = (['seller', 'buyer'] as const).map((r) => deal.confirmations.find((c) => c.role === r && c.cardHash === cardHash(deal))).filter(Boolean);
    proofs.push({
      id: 'claims',
      label: 'What the seller said about the item, on the confirmed card',
      cites: ['SP-SNAD', 'PP-SNAD-DEF'],
      weight: 1,
      source: 'Settle record',
      status: both ? 'on_file' : 'missing',
      detail: both
        ? `${claims.map((c) => `${c.kind}: ${claimText(deal, c)} (the seller's message ${c.messageId.slice(1)})`).join('; ')}. Confirmed by ${who.map((c) => `the ${c!.role} on ${day(c!.at)}`).join(' and ')}.`
        : 'The seller\'s statements are on the card, but both sides did not confirm the card as it is now.',
    });
  }
  const read = deal.payment?.read;
  const names = read?.ok ? (read.items ?? []) : [];
  const want = item?.value ?? '';
  const match = names.some((n) => n === want || (want.length > 127 && n.startsWith(want.slice(0, 126))));
  proofs.push({
    id: 'order-item',
    label: 'The item on the PayPal order',
    cites: ['PP-SNAD-DEF'],
    weight: 1,
    source: 'PayPal API',
    status: !read?.ok ? 'missing' : match ? 'on_file' : 'contradicts',
    detail: !read?.ok ? 'No read of the PayPal order on file.' : match ? `The PayPal order names the same item: "${want}".` : `The PayPal order's items (${names.join(', ') || 'none'}) don't match the card.`,
  });
  return proofs;
}

export function caseFile(deal: Deal, dispute: DisputeRecord, receipts: readonly Receipt[]): CaseFile {
  const notes: string[] = [];
  let proofs: Proof[];
  if (dispute.reason === NOT_RECEIVED) proofs = notReceivedProofs(deal, dispute, receipts);
  else if (dispute.reason === NOT_AS_DESCRIBED) {
    proofs = notAsDescribedProofs(deal);
    notes.push('Seller Protection does not cover not-as-described claims (SP-SNAD). The record shows what both of you agreed; PayPal decides.');
    if (deal.card.claims?.length) notes.push("PayPal's definition of not as described excludes a defect the seller correctly described (PP-SNAD-DEF). The seller's own words on the confirmed card show what was described; PayPal decides whether the item matches them.");
  } else {
    proofs = [];
    notes.push('Settle has no checklist for this reason. The evidence pack still holds the card, the payment and the receipts.');
  }
  return {
    disputeId: dispute.id,
    reason: dispute.reason,
    reasonLabel: REASON_LABELS[dispute.reason] ?? dispute.reason,
    stage: dispute.stage,
    status: dispute.status,
    ...(dispute.amount ? { amount: `${dispute.amount.value} ${dispute.amount.currency}` } : {}),
    ...(dispute.dueDate ? { dueDate: dispute.dueDate } : {}),
    proofs: [paymentProof(deal), ...proofs],
    notes,
  };
}
