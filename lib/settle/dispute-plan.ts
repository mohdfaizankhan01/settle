// Honest advice for a dispute (PLAN M4 MUST). Rules in code, no model: fight, refund, offer, or
// send tracking (only while still an inquiry), with the reasons and a score shown as a sum of the
// proofs on file, never a win percentage. If the seller can't prove delivery on a not-received
// claim, it says refund. Only actions in the dispute's own links are offered; anything else
// points to the Resolution Center with the evidence pack. PayPal decides.

import type { CaseFile, Proof } from './case-file';
import { NOT_AS_DESCRIBED, NOT_RECEIVED } from './disputes';
import type { DisputeRecord } from './types';

export type Advice = 'fight' | 'refund' | 'offer' | 'send_tracking';

/** The dispute action each piece of advice uses, in order of preference. */
export const ACTION_FOR: Record<Advice, string[]> = {
  fight: ['provide_evidence', 'provide_supporting_info'],
  send_tracking: ['provide_evidence'],
  refund: ['accept_claim'],
  offer: ['make_offer'],
};

export const ADVICE_LABEL: Record<Advice, string> = {
  fight: 'Answer with your evidence',
  send_tracking: 'Send PayPal the tracking',
  refund: 'Refund the buyer',
  offer: 'Offer a partial refund',
};

export type ScoreLine = { label: string; points: number; of: number };

export type Plan = {
  advice: Advice;
  reasons: string[];
  /** The dispute action to use, if PayPal offers one right now. */
  action?: { rel: string; path: string };
  /** When PayPal offers no matching action: what to do instead. */
  fallback?: string;
  score: { lines: ScoreLine[]; total: number; of: number };
  /** Other actions PayPal offers now, for the seller to choose instead. */
  alternatives: { advice: Advice; rel: string }[];
  note: string;
};

export const PLAN_NOTE = 'This is a summary of what the record shows, not a prediction. PayPal decides the dispute.';

const status = (cf: CaseFile, id: string) => cf.proofs.find((p) => p.id === id)?.status;

function score(proofs: Proof[]) {
  const lines = proofs.map((p) => ({ label: p.label, points: p.status === 'on_file' ? p.weight : p.status === 'contradicts' ? -p.weight : 0, of: p.weight }));
  return { lines, total: lines.reduce((n, l) => n + l.points, 0), of: lines.reduce((n, l) => n + l.of, 0) };
}

function decide(cf: CaseFile, dispute: DisputeRecord): { advice: Advice; reasons: string[] } {
  const contradicts = cf.proofs.filter((p) => p.status === 'contradicts');
  if (cf.reason === NOT_RECEIVED) {
    if (contradicts.length > 0) {
      return { advice: 'refund', reasons: contradicts.map((p) => `${p.label}: ${p.detail}`).concat('With a record that contradicts the claim\'s requirements, a refund is the honest answer.') };
    }
    if (status(cf, 'shipment') !== 'on_file') {
      return { advice: 'refund', reasons: ['There is no tracking on the PayPal order, so shipment can\'t be proved (SP-PROOF-SHIP).'] };
    }
    if (status(cf, 'delivery') !== 'on_file') {
      const reasons = ['Delivery can\'t be proved: Seller Protection needs proof of delivery for an item-not-received claim (SP-PROOF-DELIV).'];
      if (dispute.stage === 'INQUIRY') reasons.push('While this is still an inquiry you can also send the tracking first; if the carrier never shows delivered, refund.');
      return { advice: 'refund', reasons };
    }
    if (dispute.stage === 'INQUIRY' && cf.proofs.find((p) => p.id === 'shipment')?.late) {
      return { advice: 'send_tracking', reasons: ['The buyer may not have seen the tracking: it went on the order after they opened the inquiry.'] };
    }
    return { advice: 'fight', reasons: ['Shipment, delivery and the PayPal address are all on file, and nothing in the record contradicts them.'] };
  }
  if (cf.reason === NOT_AS_DESCRIBED) {
    if (contradicts.length > 0 || status(cf, 'card') !== 'on_file') {
      return { advice: 'offer', reasons: ['The record doesn\'t clearly show the item matched what was agreed.', 'Not-as-described claims are outside Seller Protection (SP-SNAD), so a partial refund may cost less than losing the claim.'] };
    }
    return { advice: 'fight', reasons: ['Both of you confirmed the item description, its source message is on file, and the PayPal order names the same item.', 'Not-as-described claims are outside Seller Protection (SP-SNAD); the record is your evidence of what was agreed.'] };
  }
  return { advice: 'refund', reasons: ['Settle has no checklist for this reason. Read the claim in PayPal, and refund unless you can show it is wrong.'] };
}

export function disputePlan(cf: CaseFile, dispute: DisputeRecord): Plan {
  const { advice, reasons } = decide(cf, dispute);
  const pick = (a: Advice) => ACTION_FOR[a].map((rel) => dispute.actions.find((x) => x.rel === rel)).find(Boolean);
  const action = dispute.status === 'RESOLVED' ? undefined : pick(advice);
  const alternatives = (['fight', 'refund', 'offer', 'send_tracking'] as const)
    .filter((a) => a !== advice && !(a === 'send_tracking' && dispute.stage !== 'INQUIRY'))
    .flatMap((a) => {
      const x = pick(a);
      return x && dispute.status !== 'RESOLVED' ? [{ advice: a, rel: x.rel }] : [];
    });
  return {
    advice,
    reasons,
    ...(action ? { action } : {}),
    ...(!action && dispute.status !== 'RESOLVED'
      ? { fallback: `PayPal doesn't offer "${ADVICE_LABEL[advice].toLowerCase()}" on this dispute right now. Download the evidence pack and respond in PayPal's Resolution Center.` }
      : {}),
    score: score(cf.proofs),
    alternatives,
    note: PLAN_NOTE,
  };
}
