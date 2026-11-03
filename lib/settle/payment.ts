// Payment confirmation (PLAN M3). A deal is paid only when both hold:
//   1. PayPal told us its capture completed: a verified PAYMENT.CAPTURE.COMPLETED webhook, or,
//      when that delivery was missed, the same event in PayPal's own webhook event log.
//   2. A fresh GET of the order, as the seller, shows that capture COMPLETED and the order still
//      matches the locked card: amount, currency, payee and dealId:hash.
// A webhook is only ever a trigger: what the deal records comes from the fresh GET. Client
// callbacks, screenshots and emails never count. Any error leaves the deal unconfirmed.

import * as paypal from '../paypal';
import { orderMismatches } from './checkout';
import { isPaid, syncGate } from './ship-gate';
import { StaleWriteError, type DealStore } from './store';
import type { Deal, OrderRead, Payment, ShipTo } from './types';

export type PaymentPayPal = Pick<typeof paypal, 'getOrder' | 'webhookEventsFor'>;
export type PaymentDeps = { store: DealStore; paypal?: PaymentPayPal; now?: () => Date };

const CAPTURE_COMPLETED = 'PAYMENT.CAPTURE.COMPLETED';
/** The page-load fallback reads PayPal at most this often per deal. */
export const FALLBACK_INTERVAL_MS = 60_000;

const nowOf = (deps: PaymentDeps) => (deps.now ?? (() => new Date()))();
const debugIdOf = (error: unknown) => (error instanceof paypal.PayPalApiError ? error.debugId : undefined);

function shipToOf(order: paypal.Order): ShipTo | undefined {
  const s = order.purchase_units?.[0]?.shipping;
  if (!s?.address) return undefined;
  const a = s.address;
  const lines = [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1].filter((x): x is string => !!x?.trim());
  return { name: s.name?.full_name, lines, postalCode: a.postal_code, countryCode: a.country_code };
}

/** What a fresh order says, checked against the card. */
export function readOrder(deal: Deal, order: paypal.Order, at: string, debugId?: string): OrderRead {
  const captures = order.purchase_units?.[0]?.payments?.captures ?? [];
  const capture = captures[0];
  const mismatches = orderMismatches(deal, order);
  if (deal.order && order.id !== deal.order.id) mismatches.push('order is not this deal\'s order');
  // One payment, one capture (SP-SINGLE): a second capture is not something Settle created.
  if (captures.length > 1) mismatches.push('order has more than one capture');
  if (capture?.amount && (capture.amount.value !== order.purchase_units?.[0]?.amount?.value || capture.amount.currency_code !== order.purchase_units?.[0]?.amount?.currency_code)) {
    mismatches.push('captured amount does not match the order');
  }
  const b = capture?.seller_receivable_breakdown;
  return {
    ok: true,
    at,
    orderStatus: order.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    fee: b?.paypal_fee?.value,
    net: b?.net_amount?.value,
    shipTo: shipToOf(order),
    trackers: (order.purchase_units?.[0]?.shipping?.trackers ?? []).map((t) => t.id),
    mismatches,
    debugId,
  };
}

export type Trigger =
  | { kind: 'webhook'; eventId: string; eventType: string; captureId?: string }
  | { kind: 'page' }
  // Re-read after the seller added tracking, to see the tracker on the order.
  | { kind: 'tracking' };

const summary = (p: Payment | undefined, paid: boolean) => {
  const r = p?.read;
  return JSON.stringify([paid, !!p?.webhook, r?.ok, r?.ok && r.orderStatus, r?.ok && r.captureStatus, r?.ok && r.mismatches]);
};

/**
 * Re-reads the deal's order from PayPal and records the result. For a verified capture webhook,
 * the event counts only if it names the capture the fresh GET shows. Writes a receipt when the
 * outcome changes. Throws if PayPal can't be read (after recording "can't check").
 */
export async function refreshPayment(dealId: string, trigger: Trigger, deps: PaymentDeps): Promise<Deal> {
  const pp = deps.paypal ?? paypal;
  const first = await deps.store.getDeal(dealId);
  if (!first) throw new Error('no such deal');
  const deal = first.value;
  if (!deal.order || !deal.payeeMerchantId) throw new Error('deal has no order');
  const at = nowOf(deps).toISOString();

  let read: OrderRead;
  let failure: unknown;
  try {
    const fresh = await pp.getOrder(deal.order.id, deal.payeeMerchantId);
    read = readOrder(deal, fresh.data, at, fresh.debugId);
  } catch (error) {
    failure = error;
    read = { ok: false, at, reason: 'could not read the order from PayPal', debugId: debugIdOf(error) };
  }

  let webhook = deal.payment?.webhook;
  let ignored: string | undefined;
  if (read.ok && read.captureId && !webhook) {
    if (trigger.kind === 'webhook' && trigger.eventType === CAPTURE_COMPLETED) {
      if (trigger.captureId === read.captureId) webhook = { eventId: trigger.eventId, captureId: read.captureId, at, via: 'webhook' };
      else ignored = 'event is for another capture';
    } else if (trigger.kind === 'page') {
      // The delivery to our webhook may have been missed: ask PayPal's event log.
      try {
        const since = new Date(Date.parse(deal.order.createdAt) - 60 * 60 * 1000);
        const events = await pp.webhookEventsFor(read.captureId, CAPTURE_COMPLETED, since);
        const event = events.data.find((e) => e.event_type === CAPTURE_COMPLETED && (e.resource as { id?: string } | undefined)?.id === read.captureId);
        if (event) webhook = { eventId: event.id, captureId: read.captureId, at, via: 'event-log' };
      } catch {
        // No event log answer: stays unconfirmed until a webhook arrives or the next load.
      }
    }
  }

  const payment: Payment = { webhook, read };
  let saved: Deal | undefined;
  let before: Payment | undefined;
  for (let attempt = 0; ; attempt++) {
    const latest = attempt === 0 ? first : (await deps.store.getDeal(dealId))!;
    before = latest.value.payment;
    // Never drop a confirmation already recorded by a concurrent run.
    const merged: Payment = { webhook: latest.value.payment?.webhook ?? payment.webhook, read };
    const next: Deal = {
      ...latest.value,
      payment: merged,
      order: { ...latest.value.order!, status: read.ok ? read.orderStatus : latest.value.order!.status },
    };
    try {
      await deps.store.updateDeal(dealId, latest.version, next);
      saved = next;
      break;
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= 2) throw error;
    }
  }

  const paid = isPaid(saved);
  if (summary(before, isPaid({ ...saved, payment: before })) !== summary(saved.payment, paid) || ignored) {
    await deps.store.addReceipt({
      dealId,
      kind: 'payment.checked',
      at,
      data: {
        trigger: trigger.kind,
        eventId: trigger.kind === 'webhook' ? trigger.eventId : null,
        eventType: trigger.kind === 'webhook' ? trigger.eventType : null,
        webhookVia: saved.payment?.webhook?.via ?? null,
        ignored: ignored ?? null,
        orderId: deal.order.id,
        readOk: read.ok,
        orderStatus: read.ok ? read.orderStatus : null,
        captureId: read.ok ? (read.captureId ?? null) : null,
        captureStatus: read.ok ? (read.captureStatus ?? null) : null,
        mismatches: read.ok ? read.mismatches : [],
        paid,
        debugId: read.debugId ?? null,
      },
    });
  }
  await syncGate(deps.store, dealId, at);
  if (failure) throw failure;
  return saved;
}

/** The deal a capture event is about, from the custom_id Settle put on the order. */
export function dealIdOfEvent(event: paypal.WebhookEvent): string | undefined {
  const customId = (event.resource as { custom_id?: unknown } | undefined)?.custom_id;
  if (typeof customId !== 'string') return undefined;
  const m = /^([0-9a-f-]{36}):[0-9a-f]{64}$/.exec(customId);
  return m?.[1];
}

export type EventResult = { handled: boolean; dealId?: string; reason?: string };

/**
 * Applies a verified webhook event. Replays are no-ops. Throws when PayPal can't be read, so the
 * route answers 503 and PayPal sends the event again.
 */
export async function applyVerifiedEvent(event: paypal.WebhookEvent, deps: PaymentDeps): Promise<EventResult> {
  if (await deps.store.hasEvent(event.id)) return { handled: false, reason: 'already processed' };
  let result: EventResult = { handled: false, reason: 'not a capture event' };
  if (event.event_type.startsWith('PAYMENT.CAPTURE.')) {
    const dealId = dealIdOfEvent(event);
    const stored = dealId ? await deps.store.getDeal(dealId) : undefined;
    if (!stored?.value.order) result = { handled: false, reason: 'no Settle deal for this capture' };
    else {
      const captureId = event.event_type === CAPTURE_COMPLETED ? (event.resource as { id?: string } | undefined)?.id : undefined;
      await refreshPayment(dealId!, { kind: 'webhook', eventId: event.id, eventType: event.event_type, captureId }, deps);
      result = { handled: true, dealId };
    }
  }
  await deps.store.recordEvent({ id: event.id, type: event.event_type, dealId: result.dealId ?? null, at: nowOf(deps).toISOString() });
  return result;
}

/**
 * The missed-webhook fallback: on a deal page load, if a capture was requested but payment isn't
 * confirmed, re-read PayPal at most once a minute per deal. Same rules as the webhook path.
 */
export { isPaid };

export async function maybeRefreshOnLoad(deal: Deal, deps: PaymentDeps): Promise<Deal> {
  if (!deal.order || deal.order.status === 'CREATED' || isPaid(deal)) return deal;
  const last = deal.payment?.read?.at;
  if (last && nowOf(deps).getTime() - Date.parse(last) < FALLBACK_INTERVAL_MS) return deal;
  try {
    return await refreshPayment(deal.id, { kind: 'page' }, deps);
  } catch {
    return (await deps.store.getDeal(deal.id))?.value ?? deal;
  }
}
