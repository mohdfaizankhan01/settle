// Approved dispute submissions (PLAN M4 MUST, D2). The seller sees the exact request (endpoint,
// JSON, and each file's name, size and SHA-256) and approves its hash. On approval the server
// re-reads the dispute, checks the action is still in its links, rebuilds the request from the
// record and sends it only if the hash is the one approved. Text is templated from the record;
// no model writes it. Each send is claimed first so a double click can't send twice.

import { createHash } from 'node:crypto';
import * as paypal from '../paypal';
import { canonicalJson, sha256Hex } from './canonical';
import { formatMoney } from './card';
import { caseFile, redactedQuote } from './case-file';
import { carrierLabel } from './carriers';
import { DealError } from './deals';
import { disputePlan, ACTION_FOR, type Advice } from './dispute-plan';
import { NOT_AS_DESCRIBED, refreshDispute, type DisputeDeps } from './disputes';
import { paypalFor } from './demo-paypal';
import { evidencePdf } from './evidence-pdf';
import { sellerDeal } from './shipping';
import { trackerShown } from './ship-gate';
import { updateWithRetry } from './store';
import type { Deal, DisputeRecord } from './types';

export type SubmitPayPal = Pick<typeof paypal, 'getDispute' | 'sendDisputeAction'>;
export type SubmitDeps = { store: DisputeDeps['store']; paypal?: SubmitPayPal; now?: () => Date };

export type Choice = {
  advice: Advice;
  /** make_offer only: the refund offered, in the deal's currency. */
  offerAmount?: string;
  /** false: send notes only, without the PDF (the fallback when an upload is refused). */
  withFiles?: boolean;
};

export type BuiltRequest = {
  advice: Advice;
  rel: string;
  method: 'POST';
  url: string;
  json: Record<string, unknown>;
  files: { name: string; contentType: string; size: number; sha256: string }[];
  hash: string;
};

/** A submission older than this still marked 'sending' belongs to a call that died. */
export const SENDING_STALE_MS = 2 * 60_000;
const MAX_NOTE = 2000;
const clip = (s: string) => (s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE - 1)}…` : s);

/** The note for each action, filled from the record. Fixed templates only. */
export function noteFor(deal: Deal, dispute: DisputeRecord, choice: Choice): string {
  const t = deal.shipping?.tracking;
  const carrier = t ? carrierLabel(deal, t.carrier, t.carrierName) : '';
  const ref = `The buyer and seller confirmed these terms on Settle Link before paying (deal ${deal.id}).`;
  const read = deal.payment?.read?.ok ? deal.payment.read : undefined;
  if (choice.advice === 'refund') return 'The seller accepts the claim and refunds the buyer in full.';
  if (choice.advice === 'offer') {
    return `The seller offers a partial refund of ${formatMoney(choice.offerAmount ?? '0.00', deal.card.price!.value.currency)} to settle this dispute.`;
  }
  const parts: string[] = [];
  if (dispute.reason === NOT_AS_DESCRIBED) {
    const item = deal.card.item;
    const src = item?.source.kind === 'message' ? deal.messages.find((m) => m.id === (item.source as { messageId: string }).messageId) : undefined;
    parts.push(`Before paying, the buyer confirmed the item as "${item?.value}".`);
    if (src) parts.push(`That description comes from the ${src.role}'s message: "${redactedQuote(deal, src.id)}".`);
    if (read?.items?.includes(item?.value ?? '')) parts.push('The PayPal order names the same item.');
  }
  if (t && trackerShown(deal, t.number)) parts.push(`Shipped by ${carrier}, tracking ${t.number}, added to the PayPal order on ${t.at.slice(0, 10)}.`);
  if (deal.shipping?.delivered) parts.push(`The carrier shows it delivered on ${deal.shipping.delivered.date}.`);
  if (read?.shipTo?.postalCode && deal.shipping?.labelPostcode) parts.push(`Shipped to the address on this PayPal transaction (postcode ${read.shipTo.postalCode}).`);
  if (choice.advice === 'fight') parts.push(ref, choice.withFiles === false ? '' : 'The attached evidence pack has the full record.');
  return clip(parts.filter(Boolean).join(' '));
}

async function build(deal: Deal, dispute: DisputeRecord, choice: Choice, receipts: Awaited<ReturnType<SubmitDeps['store']['listReceipts']>>) {
  const rel = ACTION_FOR[choice.advice].map((r) => dispute.actions.find((a) => a.rel === r)).find(Boolean);
  if (!rel) throw new DealError('PayPal does not offer that action on this dispute right now', 409);
  if (choice.advice === 'send_tracking' && dispute.stage !== 'INQUIRY') throw new DealError('sending tracking is only offered while the dispute is an inquiry', 409);
  const offerAmount = choice.advice === 'offer' && /^\d{1,6}(?:\.\d{1,2})?$/.test(choice.offerAmount ?? '') ? Number(choice.offerAmount).toFixed(2) : undefined;
  const note = noteFor(deal, dispute, { ...choice, ...(offerAmount ? { offerAmount } : {}) });
  const t = deal.shipping?.tracking;
  const currency = deal.card.price!.value.currency;
  let json: Record<string, unknown>;
  let pdf: Uint8Array | undefined;
  if (rel.rel === 'provide_evidence') {
    const tracked = t && trackerShown(deal, t.number);
    json = {
      evidences: [
        tracked
          ? {
              evidence_type: 'PROOF_OF_FULFILLMENT',
              evidence_info: { tracking_info: [{ carrier_name: t.carrier, ...(t.carrier === 'OTHER' && t.carrierName ? { carrier_name_other: t.carrierName } : {}), tracking_number: t.number }] },
              notes: note,
            }
          : { evidence_type: 'OTHER', notes: note },
      ],
    };
    if (choice.withFiles !== false && choice.advice === 'fight') pdf = await evidencePdf(deal, dispute, receipts);
  } else if (rel.rel === 'provide_supporting_info') {
    json = { notes: note };
    if (choice.withFiles !== false) pdf = await evidencePdf(deal, dispute, receipts);
  } else if (rel.rel === 'accept_claim') {
    json = { note };
  } else if (rel.rel === 'make_offer') {
    if (!offerAmount || Number(offerAmount) <= 0) throw new DealError('enter the refund to offer, like 40 or 40.50');
    const max = Number(dispute.amount?.value ?? deal.card.price!.value.amount);
    if (Number(offerAmount) >= max) throw new DealError('a partial refund must be less than the disputed amount; refund in full instead', 400);
    json = { note, offer_amount: { currency_code: currency, value: offerAmount }, offer_type: 'REFUND' };
  } else {
    throw new DealError('Settle Link does not send that action', 409);
  }
  const files = pdf ? [{ name: `settle-evidence-${dispute.id}.pdf`, contentType: 'application/pdf', bytes: pdf }] : [];
  const listed = files.map((f) => ({ name: f.name, contentType: f.contentType, size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }));
  const hash = sha256Hex(canonicalJson({ disputeId: dispute.id, path: rel.path, json: json as never, files: listed }));
  const request: BuiltRequest = { advice: choice.advice, rel: rel.rel, method: 'POST', url: `${paypal.BASE_URL}${rel.path}`, json, files: listed, hash };
  return { request, path: rel.path, files };
}

async function freshDispute(dealId: string, key: string | null, disputeId: string, deps: SubmitDeps) {
  await sellerDeal(deps.store, dealId, key);
  // Re-read before offering or sending anything: stages move within minutes in the sandbox.
  const deal = await refreshDispute(dealId, disputeId, 'submit', deps).catch(() => {
    throw new DealError("couldn't read the dispute from PayPal; nothing was sent", 409);
  });
  const dispute = deal.disputes?.find((d) => d.id === disputeId);
  if (!dispute) throw new DealError('no such dispute on this deal', 404);
  if (dispute.status === 'RESOLVED') throw new DealError('this dispute is resolved', 409);
  return { deal, dispute };
}

/** What the seller is asked to approve: the exact request, plus the advice it follows. */
export async function previewSubmission(dealId: string, key: string | null, disputeId: string, choice: Choice, deps: SubmitDeps) {
  const { deal, dispute } = await freshDispute(dealId, key, disputeId, deps);
  const receipts = await deps.store.listReceipts(dealId);
  const { request } = await build(deal, dispute, choice, receipts);
  const plan = disputePlan(caseFile(deal, dispute, receipts), dispute);
  return { request, recommended: plan.advice === choice.advice };
}

/** The evidence pack for download (the Resolution Center fallback). */
export async function evidencePack(dealId: string, key: string | null, disputeId: string, deps: SubmitDeps) {
  const deal = (await sellerDeal(deps.store, dealId, key)).value;
  const dispute = deal.disputes?.find((d) => d.id === disputeId);
  if (!dispute) throw new DealError('no such dispute on this deal', 404);
  return evidencePdf(deal, dispute, await deps.store.listReceipts(dealId));
}

/** Sends the request the seller approved, if it is still exactly that request. */
export async function submitApproved(dealId: string, key: string | null, disputeId: string, choice: Choice, approvedHash: string, deps: SubmitDeps) {
  const { deal, dispute } = await freshDispute(dealId, key, disputeId, deps);
  // Demo deals never reach PayPal: they get the recorded replay (judge mode, M5).
  const pp = paypalFor(deps.store, deal, deps.paypal, paypal as SubmitPayPal);
  const receipts = await deps.store.listReceipts(dealId);
  const { request, path, files } = await build(deal, dispute, choice, receipts);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const at = new Date(nowMs).toISOString();
  if (request.hash !== approvedHash) {
    await deps.store.addReceipt({ dealId, kind: 'dispute.submit_refused', at, data: { disputeId, rel: request.rel, reason: 'the request changed since it was approved' } });
    throw new DealError('the dispute or the record changed since you reviewed the request; review it again', 409);
  }

  // The claim: one live submission per dispute at a time, and never the same request twice.
  await updateWithRetry(deps.store, dealId, (d) => {
    const subs = d.submissions ?? [];
    if (subs.some((s) => s.disputeId === disputeId && s.state === 'sending' && nowMs - Date.parse(s.at) < SENDING_STALE_MS)) {
      throw new DealError('a response to this dispute is being sent; reload in a moment', 409);
    }
    if (subs.some((s) => s.hash === request.hash && s.state === 'sent')) throw new DealError('this exact request was already sent', 409);
    // A 5xx or lost answer may have been recorded by PayPal: never send that exact request again.
    if (subs.some((s) => s.hash === request.hash && s.state === 'unknown')) {
      throw new DealError("PayPal didn't confirm this request last time and it may have gone through. Check the case in PayPal; Settle Link won't send it twice.", 409);
    }
    return { ...d, submissions: [...subs.filter((s) => s.hash !== request.hash), { disputeId, rel: request.rel, hash: request.hash, state: 'sending', at }] };
  });

  let state: 'sent' | 'failed' | 'unknown';
  let debugId: string | undefined;
  let status: number | undefined;
  let reason: string | undefined;
  try {
    const out = await pp.sendDisputeAction(path, request.json, files, deal.payeeMerchantId!);
    state = 'sent';
    debugId = out.debugId;
  } catch (error) {
    if (error instanceof paypal.PayPalApiError) {
      status = error.status;
      debugId = error.debugId;
      // A 4xx was refused; a 5xx may or may not have been recorded (dispute actions aren't retried).
      state = error.status >= 500 ? 'unknown' : 'failed';
      reason = error.message.replace(/^PayPal \d+ on \S+( \(debug id [^)]+\))?: /, '').slice(0, 300);
    } else {
      state = 'unknown';
      reason = error instanceof Error ? error.name : 'error';
    }
  }
  await updateWithRetry(deps.store, dealId, (d) => ({
    ...d,
    submissions: (d.submissions ?? []).map((s) => (s.hash === request.hash ? { ...s, state, ...(debugId ? { debugId } : {}), ...(status ? { status } : {}) } : s)),
  }));
  await deps.store.addReceipt({
    dealId,
    kind: 'dispute.submitted',
    at,
    data: { disputeId, rel: request.rel, advice: choice.advice, requestHash: request.hash, files: request.files.map((f) => f.sha256), state, status: status ?? null, debugId: debugId ?? null, reason: reason ?? null },
  });
  const after = await refreshDispute(dealId, disputeId, 'after-submit', deps).catch(() => undefined);
  if (state === 'failed') throw new DealError(`PayPal refused it${reason ? `: ${reason}` : ''}${debugId ? ` (debug ID ${debugId})` : ''}`, 409);
  if (state === 'unknown') throw new DealError("PayPal didn't confirm it. Check the dispute in PayPal before sending again.", 409);
  return { state, debugId, request, dispute: after?.disputes?.find((d) => d.id === disputeId) };
}
