// A mocked PayPal dispute on the paid-deal fixture's capture (CAP-1).

import { PayPalApiError, type Dispute, type WebhookEvent } from '../../lib/paypal';

const API = 'https://api-m.sandbox.paypal.com';

export function fakeDispute(customId: string, over: Partial<Dispute> = {}) {
  const dispute: Dispute = {
    dispute_id: 'PP-D-1',
    create_time: '2026-11-05T10:00:00.000Z',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'INQUIRY',
    dispute_amount: { currency_code: 'GBP', value: '350.00' },
    seller_response_due_date: '2026-11-15T10:00:00.000Z',
    disputed_transactions: [{ seller_transaction_id: 'CAP-1', custom: customId }],
    links: [
      { href: `${API}/v1/customer/disputes/PP-D-1`, rel: 'self', method: 'GET' },
      { href: `${API}/v1/customer/disputes/PP-D-1/provide-evidence`, rel: 'provide_evidence', method: 'POST' },
      { href: `${API}/v1/customer/disputes/PP-D-1/accept-claim`, rel: 'accept_claim', method: 'POST' },
      { href: `${API}/v1/customer/disputes/PP-D-1/make-offer`, rel: 'make_offer', method: 'POST' },
    ],
    ...over,
  };
  const calls: string[] = [];
  let fail = false;
  const paypal = {
    async getDispute(id: string, seller: string) {
      calls.push(`get ${id} as ${seller}`);
      if (fail) throw new PayPalApiError(503, '/v1/customer/disputes', 'down', 'dbg-d-down');
      return { data: structuredClone(dispute), debugId: 'dbg-dispute' };
    },
  };
  const event = (id: string, type = 'CUSTOMER.DISPUTE.CREATED'): WebhookEvent => ({
    id,
    event_type: type,
    resource: { dispute_id: dispute.dispute_id, disputed_transactions: [{ seller_transaction_id: 'CAP-1', custom: customId }] },
  });
  return { dispute, paypal, calls, event, failGet: (v: boolean) => void (fail = v) };
}
