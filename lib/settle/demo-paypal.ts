// Judge mode's PayPal (M5): replays responses recorded from the Nov 3 sandbox run
// (data/demo/recorded.json) instead of calling PayPal. Each answer is built from the demo deal
// it is about (its amount, payee, custom_id, item and tracking) plus the recorded IDs and values,
// so Settle's real code checks it exactly as it checks a live answer. Every debug ID it returns
// starts with "rec-", so a replayed answer can never be mistaken for a live one. It never takes
// a payment: order creation and capture are refused.

import { PaypalClient } from 'paypal';
import recorded from '../../data/demo/recorded.json';
import * as paypal from '../paypal';
import { moneyOf } from './card';
import { customIdFor } from './checkout';
import type { DealStore } from './store';
import type { Deal } from './types';

export const RECORDED = recorded;
export const REPLAY_NOTE = `PayPal in judge mode: responses recorded from the PayPal sandbox on ${recorded.recordedAt}, replayed for this demo deal. Nothing is sent to PayPal.`;

const rec = (debugId: string) => `rec-${debugId}`;
const API = paypal.BASE_URL;

export class DemoRefused extends Error {}

/** The order PayPal would return for this demo deal, built from the recorded run. */
export function replayedOrder(deal: Deal): paypal.Order {
  const money = moneyOf(deal);
  const currency = deal.card.price?.value.currency ?? 'USD';
  const t = deal.shipping?.tracking;
  return {
    id: recorded.order.id,
    status: 'COMPLETED',
    payer: { payer_id: 'DEMOBUYER' },
    purchase_units: [
      {
        reference_id: deal.id,
        custom_id: customIdFor(deal),
        amount: { currency_code: currency, value: money?.total ?? '0.00' },
        payee: { merchant_id: deal.payeeMerchantId },
        items: [{ name: deal.card.item?.value ?? '', quantity: '1', unit_amount: { currency_code: currency, value: deal.card.price?.value.amount ?? '0.00' } }],
        shipping: {
          name: { full_name: recorded.shipping.name },
          address: recorded.shipping.address,
          ...(t && t.state !== 'unknown' ? { trackers: [{ id: `${recorded.capture.id}-${t.number}`, status: 'SHIPPED' }] } : {}),
        },
        payments: {
          captures: [
            {
              id: recorded.capture.id,
              status: 'COMPLETED',
              amount: { currency_code: currency, value: money?.total ?? '0.00' },
              seller_receivable_breakdown: {
                paypal_fee: { currency_code: currency, value: money?.fee ?? recorded.capture.fee },
                net_amount: { currency_code: currency, value: money?.sellerGets ?? recorded.capture.net },
              },
            },
          ],
        },
      },
    ],
  };
}

/** The dispute PayPal would return for this demo deal (the recorded item-not-received case). */
export function replayedDispute(deal: Deal): paypal.Dispute {
  const d = recorded.dispute;
  const money = moneyOf(deal);
  return {
    dispute_id: d.id,
    create_time: d.createTime,
    reason: d.reason,
    status: d.status,
    dispute_life_cycle_stage: d.stage,
    dispute_amount: { currency_code: deal.card.price?.value.currency ?? 'USD', value: money?.total ?? '0.00' },
    disputed_transactions: [{ seller_transaction_id: recorded.capture.id, custom: customIdFor(deal) }],
    links: [
      { href: `${API}/v1/customer/disputes/${d.id}`, rel: 'self', method: 'GET' },
      ...d.linkRels.map((rel) => ({ href: `${API}/v1/customer/disputes/${d.id}/${rel.replaceAll('_', '-')}`, rel, method: 'POST' })),
    ],
  };
}

/** The verified webhook event the demo replays for a capture or a dispute. */
export function replayedEvent(deal: Deal, kind: 'capture' | 'dispute'): paypal.WebhookEvent {
  return kind === 'capture'
    ? { id: `${recorded.webhook.captureCompleted}-${deal.id.slice(0, 8)}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: recorded.capture.id, status: 'COMPLETED', custom_id: customIdFor(deal) } }
    : { id: `${recorded.webhook.disputeCreated}-${deal.id.slice(0, 8)}`, event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: recorded.dispute.id, disputed_transactions: [{ seller_transaction_id: recorded.capture.id, custom: customIdFor(deal) }] } };
}

/** PayPal stand-in for one demo deal. Reads always reflect the deal as it is now in the store. */
export function replayPayPal(store: DealStore, dealId: string) {
  const current = async () => {
    const d = (await store.getDeal(dealId))?.value;
    if (!d?.demo) throw new DemoRefused('not a demo deal');
    return d;
  };
  return {
    async getOrder(): Promise<paypal.WithDebugId<paypal.Order>> {
      return { data: replayedOrder(await current()), debugId: rec(recorded.order.debugId) };
    },
    async getDispute(): Promise<paypal.WithDebugId<paypal.Dispute>> {
      return { data: replayedDispute(await current()), debugId: rec(recorded.dispute.debugId) };
    },
    async sendDisputeAction(): Promise<paypal.WithDebugId<unknown>> {
      await current();
      return { data: {}, debugId: rec(recorded.submission.debugId) };
    },
    async createOrder(): Promise<never> {
      throw new DemoRefused('judge mode never takes a payment');
    },
    async captureOrder(): Promise<never> {
      throw new DemoRefused('judge mode never takes a payment');
    },
  };
}

/** An SDK client whose fetch answers from the recording, for add-tracking in judge mode. */
export function replaySdk(store: DealStore, dealId: string): PaypalClient {
  return new PaypalClient({
    oauth2: { clientId: 'judge-mode', clientSecret: 'judge-mode' },
    retry: { maxRetries: 0 },
    logging: { level: 'off' },
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'judge-mode', token_type: 'Bearer', expires_in: 3600 });
      const deal = (await store.getDeal(dealId))?.value;
      if (!deal?.demo) return Response.json({ name: 'NOT_DEMO' }, { status: 403 });
      return Response.json({ id: recorded.order.id, status: 'COMPLETED' }, { headers: { 'paypal-debug-id': rec('tracking') } });
    },
  });
}
