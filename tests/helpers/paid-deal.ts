// A deal that is locked, has an order and was captured, with PayPal mocked. Jev is mocked too;
// `askWith` lets a test make the check flag a signal.

import type { AskJev } from '../../lib/jev/deal-check';
import { PayPalApiError, type Order, type WebhookEvent } from '../../lib/paypal';
import { cardHash } from '../../lib/settle/card';
import { customIdFor } from '../../lib/settle/checkout';
import { answerQuestion, confirmCard, createDeal, openLinks, setPayee, type Deps } from '../../lib/settle/deals';
import type { PaymentPayPal } from '../../lib/settle/payment';
import { SIGNALS } from '../../lib/settle/signals';
import { MemoryDealStore } from '../../lib/settle/store';

const pick = (choice: string) => ({ choice, confidence: 0.95, probabilities: { [choice]: 0.95 } });
export const askWith = (flag: string[] = []): AskJev => async ({ questions }) => {
  // Valid picks for whatever messages were sent: the preferred option if offered, else the first.
  const criteria = (k: string) => Object.keys((questions as Record<string, { criteria?: object }>)[k]?.criteria ?? {});
  const choose = (k: string, preferred: string) => pick(criteria(k).includes(preferred) ? preferred : (criteria(k)[0] ?? preferred));
  const answers: Record<string, unknown> = {
    price: choose('price', 'PRICE_1'),
    shipBy: choose('shipBy', 'none'),
    delivery: choose('delivery', 'post'),
    itemMessage: choose('itemMessage', 'm1'),
    deliveryMessage: choose('deliveryMessage', 'm2'),
  };
  for (const s of SIGNALS) {
    const flagged = flag.includes(s.id);
    answers[`sig_${s.id}`] = { noul: flagged ? 0.99 : 0.01 };
    // A flagged signal's evidence is the last message offered.
    answers[`ev_${s.id}`] = pick(flagged ? (criteria(`ev_${s.id}`).filter((c) => c !== 'none').at(-1) ?? 'none') : 'none');
  }
  return { model: 'jev-test', answers };
};

export const clock = { at: new Date('2026-11-04T12:00:00Z') };
const now = () => clock.at;
export const tick = (ms: number) => void (clock.at = new Date(clock.at.getTime() + ms));

export async function paidSetup(ask: AskJev = askWith()) {
  clock.at = new Date('2026-11-04T12:00:00Z');
  const store = new MemoryDealStore();
  const deps: Deps = { store, ask, now };
  const { deal, keys: rawKeys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, deps);
  const keys = await openLinks(deal.id, rawKeys, deps);
  await answerQuestion(deal.id, keys.seller, 'q_fee', 'seller', deps);
  await answerQuestion(deal.id, keys.buyer, 'q_fee', 'seller', deps);
  const s = await setPayee(deal.id, 'SELLER1', deps);
  await confirmCard(deal.id, keys.seller, cardHash(s.value), deps);
  const c = await confirmCard(deal.id, keys.buyer, cardHash(s.value), deps);
  // As if checkout created and captured the order.
  const locked = c.value;
  await store.updateDeal(deal.id, c.version, { ...locked, order: { id: 'ORDER-1', cardHash: cardHash(locked), createdAt: clock.at.toISOString(), status: 'CAPTURE_REQUESTED' } });

  const order: Order = {
    id: 'ORDER-1',
    status: 'COMPLETED',
    payer: { payer_id: 'BUYER1' },
    purchase_units: [{
      custom_id: customIdFor(locked),
      amount: { currency_code: 'GBP', value: '350.00' },
      payee: { merchant_id: 'SELLER1' },
      shipping: { name: { full_name: 'Sam Buyer' }, address: { address_line_1: '1 High St', admin_area_2: 'Leeds', postal_code: 'LS1 1AA', country_code: 'GB' } },
      payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '350.00' }, seller_receivable_breakdown: { paypal_fee: { currency_code: 'GBP', value: '10.80' }, net_amount: { currency_code: 'GBP', value: '339.20' } } }] },
    }],
  };
  const calls: string[] = [];
  let failGet = false;
  const pp: PaymentPayPal = {
    async getOrder(id, seller) {
      calls.push(`get ${id} as ${seller}`);
      if (failGet) throw new PayPalApiError(503, '/v2/checkout/orders', 'down', 'dbg-down');
      return { data: structuredClone(order), debugId: 'dbg-get' };
    },
  };
  const event = (id: string, captureId = 'CAP-1', type = 'PAYMENT.CAPTURE.COMPLETED'): WebhookEvent => ({
    id,
    event_type: type,
    resource: { id: captureId, status: 'COMPLETED', custom_id: customIdFor(locked), supplementary_data: { related_ids: { order_id: 'ORDER-1' } } },
  });
  const get = async () => (await store.getDeal(deal.id))!.value;
  return { store, keys, deps, dealId: deal.id, order, pp, calls, event, get, failGet: (v: boolean) => void (failGet = v), pdeps: { store, paypal: pp, now } };
}

