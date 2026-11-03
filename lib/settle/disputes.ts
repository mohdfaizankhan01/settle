// Disputes on the record (PLAN M4, D2). A verified CUSTOMER.DISPUTE.* webhook only triggers a
// fresh GET of the dispute as the seller; the dispute counts as this deal's only when that read
// names this deal's capture and its dealId:hash custom value. Only the actions in the dispute's
// own links are kept. Each change writes a receipt and re-runs the ship gate, which holds while
// a dispute is open (SP-RELEASE).

import * as paypal from '../paypal';
import { customIdFor } from './checkout';
import { replayPayPal } from './demo-paypal';
import { syncGate } from './ship-gate';
import { updateWithRetry, type DealStore } from './store';
import type { Deal, DisputeRecord } from './types';

export type DisputePayPal = Pick<typeof paypal, 'getDispute'>;
export type DisputeDeps = { store: DealStore; paypal?: DisputePayPal; now?: () => Date };

const nowOf = (deps: DisputeDeps) => (deps.now ?? (() => new Date()))();
const debugIdOf = (error: unknown) => (error instanceof paypal.PayPalApiError ? error.debugId : undefined);

/** Re-read open disputes on a page load at most this often. */
export const DISPUTE_INTERVAL_MS = 60_000;

export const NOT_RECEIVED = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
export const NOT_AS_DESCRIBED = 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';

export const isOpen = (d: DisputeRecord) => d.status !== 'RESOLVED';
export const openDisputes = (deal: Deal) => (deal.disputes ?? []).filter(isOpen);

/** The capture Settle recorded for this deal, if any. */
const captureOf = (deal: Deal) => deal.payment?.webhook?.captureId ?? (deal.payment?.read?.ok ? deal.payment.read.captureId : undefined);

/** Why this dispute is not about this deal's payment, or undefined if it is. */
export function linkProblem(deal: Deal, dispute: paypal.Dispute): string | undefined {
  const capture = captureOf(deal);
  const tx = (dispute.disputed_transactions ?? []).find((t) => t.seller_transaction_id && t.seller_transaction_id === capture);
  if (!capture) return 'the deal has no capture';
  if (!tx) return "the dispute is not about this deal's payment";
  if (tx.custom !== undefined && tx.custom !== customIdFor(deal)) return 'the dispute names a different card';
  return undefined;
}

export function recordOf(dispute: paypal.Dispute, at: string, debugId?: string): DisputeRecord {
  const actions = (dispute.links ?? [])
    .filter((l) => l.rel !== 'self')
    .map((l) => ({ rel: l.rel, path: paypal.actionPath(dispute.dispute_id, l) }))
    .filter((a): a is { rel: string; path: string } => !!a.path);
  return {
    id: dispute.dispute_id,
    reason: dispute.reason ?? 'OTHER',
    status: dispute.status ?? 'OTHER',
    stage: dispute.dispute_life_cycle_stage ?? 'UNKNOWN',
    ...(dispute.dispute_amount?.value ? { amount: { value: dispute.dispute_amount.value, currency: dispute.dispute_amount.currency_code } } : {}),
    ...(dispute.create_time ? { createdAt: dispute.create_time } : {}),
    ...(dispute.seller_response_due_date ? { dueDate: dispute.seller_response_due_date } : {}),
    ...(dispute.dispute_outcome?.outcome_code ? { outcome: dispute.dispute_outcome.outcome_code } : {}),
    actions,
    readAt: at,
    ...(debugId ? { debugId } : {}),
  };
}

const summary = (d: DisputeRecord | undefined) => JSON.stringify(d && [d.status, d.stage, d.outcome, d.actions.map((a) => a.rel), !!d.failed]);

/**
 * Re-reads one dispute from PayPal as the seller and records it on the deal. A dispute that
 * doesn't name this deal's capture is ignored. Throws if PayPal can't be read (after recording
 * the failure beside the last good read).
 */
export async function refreshDispute(dealId: string, disputeId: string, trigger: string, deps: DisputeDeps): Promise<Deal> {
  const stored = await deps.store.getDeal(dealId);
  if (!stored?.value.payeeMerchantId) throw new Error('deal has no connected seller');
  // Demo deals never reach PayPal: they get the recorded replay (judge mode, M5).
  const pp = deps.paypal ?? (stored.value.demo ? replayPayPal(deps.store, dealId) : paypal);
  const at = nowOf(deps).toISOString();

  let fresh: paypal.WithDebugId<paypal.Dispute> | undefined;
  let failure: unknown;
  try {
    fresh = await pp.getDispute(disputeId, stored.value.payeeMerchantId);
  } catch (error) {
    failure = error;
  }
  // No capture on record yet: a temporary state, not "not this deal". Throw so the event isn't
  // marked processed and PayPal sends it again (fail closed).
  if (fresh && !captureOf(stored.value)) throw new Error('the capture is not recorded yet; the dispute will be read again');
  if (fresh) {
    const problem = linkProblem(stored.value, fresh.data);
    if (problem) {
      await deps.store.addReceipt({ dealId, kind: 'dispute.ignored', at, data: { disputeId, reason: problem, debugId: fresh.debugId ?? null } });
      return stored.value;
    }
  }

  const { before, after } = await updateWithRetry(deps.store, dealId, (deal) => {
    const list = deal.disputes ?? [];
    const old = list.find((d) => d.id === disputeId);
    const next: DisputeRecord | undefined = fresh
      ? recordOf(fresh.data, at, fresh.debugId)
      : old && { ...old, failed: { at, ...(debugIdOf(failure) ? { debugId: debugIdOf(failure) } : {}) } };
    if (!next) return deal;
    return { ...deal, disputes: [...list.filter((d) => d.id !== disputeId), next] };
  });
  const was = before.disputes?.find((d) => d.id === disputeId);
  const now = after.disputes?.find((d) => d.id === disputeId);
  if (now && summary(was) !== summary(now)) {
    await deps.store.addReceipt({
      dealId,
      kind: 'dispute.read',
      at,
      data: {
        trigger,
        disputeId,
        readOk: !!fresh,
        reason: now.reason,
        status: now.status,
        stage: now.stage,
        outcome: now.outcome ?? null,
        actions: now.actions.map((a) => a.rel),
        dueDate: now.dueDate ?? null,
        debugId: fresh?.debugId ?? debugIdOf(failure) ?? null,
      },
    });
  }
  await syncGate(deps.store, dealId, at);
  if (failure) throw failure;
  return after;
}

type DisputeResource = { dispute_id?: string; disputed_transactions?: { custom?: string }[] };

/** The deal and dispute a CUSTOMER.DISPUTE.* event names, from the custom value Settle set. */
export function dealOfDisputeEvent(event: paypal.WebhookEvent): { dealId: string; disputeId: string } | undefined {
  const r = event.resource as DisputeResource | undefined;
  if (typeof r?.dispute_id !== 'string') return undefined;
  for (const t of r.disputed_transactions ?? []) {
    const m = typeof t.custom === 'string' ? /^([0-9a-f-]{36}):[0-9a-f]{64}$/.exec(t.custom) : null;
    if (m) return { dealId: m[1], disputeId: r.dispute_id };
  }
  return undefined;
}

/** Page-load fallback: re-read open disputes at most once a minute each. */
export async function maybeRefreshDisputes(deal: Deal, deps: DisputeDeps): Promise<Deal> {
  let current = deal;
  for (const d of openDisputes(deal)) {
    const last = Math.max(Date.parse(d.readAt), d.failed ? Date.parse(d.failed.at) : 0);
    if (nowOf(deps).getTime() - last < DISPUTE_INTERVAL_MS) continue;
    current = await refreshDispute(deal.id, d.id, 'page', deps).catch(async () => (await deps.store.getDeal(deal.id))?.value ?? current);
  }
  return current;
}
