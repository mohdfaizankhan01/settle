// PayPal REST client: every call this demo makes to PayPal goes through here. It covers
// catalog products, billing plans, invoicing, Transaction Search, balances, webhook signature
// checks, seller onboarding (Partner Referrals) and orders, with plain fetch and no SDK. Server-side only: it reads the client
// secret from the environment.

const BASE_URL = 'https://api-m.sandbox.paypal.com';
const MAX_ATTEMPTS = 4;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
    // From the paypal-debug-id response header; PayPal support asks for it.
    readonly debugId?: string,
  ) {
    super(`PayPal ${status} on ${path}${debugId ? ` (debug id ${debugId})` : ''}: ${body.slice(0, 300)}`);
    this.name = 'PayPalApiError';
  }
}

let cachedToken: { value: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const { PAYPAL_CLIENT_ID: id, PAYPAL_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_SECRET must be set (see .env.local)');

  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    cache: 'no-store',
  });
  if (!res.ok) throw new PayPalApiError(res.status, '/v1/oauth2/token', await res.text());

  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so an in-flight request never carries an expired token.
  cachedToken = { value: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  return access_token;
}

async function get<T>(path: string, headers?: Record<string, string>): Promise<T> {
  return (await send<T>('GET', path, undefined, undefined, headers)).data;
}

// POSTs carry a PayPal-Request-Id, kept the same across retries so PayPal treats a retry as
// the same request rather than a second one. A caller can pass its own ID to make a repeated
// call (a double click, a retried page) idempotent too.
async function post<T>(path: string, body: unknown): Promise<T> {
  return (await send<T>('POST', path, body, crypto.randomUUID())).data;
}

/** A successful response with its paypal-debug-id, which receipts keep. */
export type WithDebugId<T> = { data: T; debugId?: string };

// A string body is sent as-is: it is already JSON (verify-webhook-signature needs PayPal's exact bytes).
async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): Promise<WithDebugId<T>> {
  let tokenRefreshed = false;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(requestId && { 'PayPal-Request-Id': requestId }),
        ...extraHeaders,
      },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      cache: 'no-store',
    });
    if (res.ok) return { data: (await res.json()) as T, debugId: res.headers.get('paypal-debug-id') ?? undefined };

    // A revoked or expired token: drop it and mint a new one, once per call. The retry doesn't use
    // up one of the attempts kept for 429 and 5xx.
    if (res.status === 401 && !tokenRefreshed) {
      tokenRefreshed = true;
      cachedToken = undefined;
      attempt--;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
      continue;
    }
    throw new PayPalApiError(res.status, path, await res.text(), res.headers.get('paypal-debug-id') ?? undefined);
  }
}

// `path` must already carry whatever flag makes the endpoint report `total_pages`.
async function listAll<T>(path: string, key: string, pageSize: number): Promise<T[]> {
  const items: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const res = await get<{ total_pages?: number } & Record<string, unknown>>(
      `${path}${sep}page_size=${pageSize}&page=${page}`,
    );
    items.push(...((res[key] as T[] | undefined) ?? []));
    if (page >= (res.total_pages ?? 1)) return items;
  }
}

export type Money = { value: string; currency_code: string };

// PayPal sends amounts as decimal strings; missing amounts count as 0.
export const amountOf = (m?: Money | null) => (m?.value === undefined ? 0 : Number(m.value));

// --- Catalog products & billing plans ------------------------------------------

export type Product = {
  id: string;
  name: string;
  description?: string;
  type?: 'PHYSICAL' | 'DIGITAL' | 'SERVICE';
  category?: string;
  create_time: string;
};

export type IntervalUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export type BillingCycle = {
  frequency: { interval_unit: IntervalUnit; interval_count: number };
  tenure_type: 'REGULAR' | 'TRIAL';
  sequence: number;
  total_cycles: number;
  pricing_scheme?: { fixed_price?: Money };
};

export type Plan = {
  id: string;
  product_id: string;
  name: string;
  status: 'CREATED' | 'INACTIVE' | 'ACTIVE';
  create_time: string;
  billing_cycles: BillingCycle[];
  payment_preferences?: { setup_fee?: Money };
};

// The list endpoints return summaries (no product type/category, no billing cycles),
// so each record is fetched in full.
export async function listProducts(): Promise<Product[]> {
  const summaries = await listAll<{ id: string }>('/v1/catalogs/products?total_required=true', 'products', 20);
  return Promise.all(summaries.map((p) => get<Product>(`/v1/catalogs/products/${encodeURIComponent(p.id)}`)));
}

export async function listPlans(): Promise<Plan[]> {
  const summaries = await listAll<{ id: string }>('/v1/billing/plans?total_required=true', 'plans', 20);
  return Promise.all(summaries.map((p) => get<Plan>(`/v1/billing/plans/${encodeURIComponent(p.id)}`)));
}

// --- Invoicing -------------------------------------------------------------------

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'SCHEDULED'
  | 'UNPAID'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'MARKED_AS_PAID'
  | 'PARTIALLY_PAID'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'MARKED_AS_REFUNDED'
  | 'CANCELLED';

export type Invoice = {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number: string;
    currency_code: string;
    invoice_date?: string;
    payment_term?: { term_type?: string; due_date?: string };
  };
  primary_recipients?: {
    billing_info?: {
      name?: { full_name?: string };
      business_name?: string;
      email_address?: string;
    };
  }[];
  items?: {
    id?: string;
    name: string;
    quantity: string;
    unit_amount: Money;
    unit_of_measure?: string;
    tax?: { percent?: string; amount?: Money };
    discount?: { percent?: string; amount?: Money };
  }[];
  amount?: Money & { breakdown?: { tax_total?: Money; shipping?: { amount?: Money } } };
  due_amount?: Money;
  payments?: {
    paid_amount?: Money;
    transactions?: { payment_id?: string; payment_date?: string; method?: string; amount: Money }[];
  };
  refunds?: {
    refund_amount?: Money;
    transactions?: { recipient_transaction_id?: string; refund_date?: string; method?: string; amount: Money }[];
  };
};

// The list omits line items, payments and refunds; the detail endpoint has them.
export async function listInvoices(): Promise<Invoice[]> {
  const summaries = await listAll<{ id: string }>('/v2/invoicing/invoices?total_required=true', 'items', 100);
  return Promise.all(summaries.map((i) => get<Invoice>(`/v2/invoicing/invoices/${encodeURIComponent(i.id)}`)));
}

// --- Transaction Search & balances -------------------------------------------------

export type Transaction = {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_amount?: Money;
    fee_amount?: Money;
    transaction_status?: string;
    ending_balance?: Money;
    transaction_subject?: string;
    transaction_note?: string;
    custom_field?: string;
  };
  payer_info?: { email_address?: string };
};

// Transaction Search allows ranges of at most 31 days and rejects fractional seconds.
export const TRANSACTION_SEARCH_MAX_DAYS = 31;

export function searchTransactions(start: Date, end: Date): Promise<Transaction[]> {
  const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
  return listAll<Transaction>(
    `/v1/reporting/transactions?start_date=${iso(start)}&end_date=${iso(end)}&fields=all`,
    'transaction_details',
    500,
  );
}

export type Balances = {
  as_of_time?: string;
  balances?: { currency: string; total_balance?: Money; available_balance?: Money; withheld_balance?: Money }[];
};

export function getBalances(): Promise<Balances> {
  return get<Balances>('/v1/reporting/balances');
}

// --- Webhooks ----------------------------------------------------------------------

// The transmission headers PayPal sends with every webhook, and the verify-webhook-signature
// field each one fills.
const SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

export type WebhookEvent = { id: string; event_type: string; resource?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Asks PayPal whether a webhook really came from PayPal, for the webhook registered as
 * `webhookId`. `rawBody` is the request body exactly as received (already checked to be JSON):
 * it is spliced into the request unparsed, because re-serializing can change number formats or
 * escapes and break the signature. Missing signature headers mean FAILURE without a call; a
 * PayPal error throws, and the caller must treat that as unverified.
 */
export async function verifyWebhookSignature(
  headers: Headers,
  rawBody: string,
  webhookId: string,
): Promise<'SUCCESS' | 'FAILURE'> {
  const fields = Object.fromEntries(
    Object.entries(SIGNATURE_HEADERS).map(([field, header]) => [field, headers.get(header)]),
  );
  if (Object.values(fields).some((value) => !value)) return 'FAILURE';

  const envelope = JSON.stringify({ ...fields, webhook_id: webhookId });
  const { verification_status } = await post<{ verification_status: string }>(
    '/v1/notifications/verify-webhook-signature',
    `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`,
  );
  return verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
}

// --- Seller onboarding (Partner Referrals, D1) ----------------------------------

/**
 * Lets our platform app act for a connected seller (D1): an unsigned JWT naming our client ID
 * and the seller's merchant ID, sent as PayPal-Auth-Assertion.
 * https://developer.paypal.com/api/rest/requests/
 */
export function authAssertion(sellerMerchantId: string): string {
  const id = process.env.PAYPAL_CLIENT_ID;
  if (!id) throw new Error('PAYPAL_CLIENT_ID must be set');
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ iss: id, payer_id: sellerMerchantId })}.`;
}

// The features the D1 and D2 spikes needed: take payments, refund, read the seller's account
// status, and read and answer the seller's disputes.
const SELLER_FEATURES = ['PAYMENT', 'REFUND', 'ACCESS_MERCHANT_INFORMATION', 'READ_SELLER_DISPUTE', 'UPDATE_SELLER_DISPUTE'];

/** Starts onboarding. Returns PayPal's URL where the seller signs in and grants permission. */
export async function createPartnerReferral(trackingId: string, returnUrl: string): Promise<WithDebugId<{ actionUrl: string }>> {
  const { data, debugId } = await send<{ links?: { rel: string; href: string }[] }>(
    'POST',
    '/v2/customer/partner-referrals',
    {
      tracking_id: trackingId,
      operations: [
        {
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              third_party_details: { features: SELLER_FEATURES },
            },
          },
        },
      ],
      products: ['EXPRESS_CHECKOUT'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      partner_config_override: { return_url: returnUrl },
    },
    crypto.randomUUID(),
  );
  const actionUrl = data.links?.find((l) => l.rel === 'action_url')?.href;
  if (!actionUrl) throw new PayPalApiError(200, '/v2/customer/partner-referrals', 'no action_url in response', debugId);
  return { data: { actionUrl }, debugId };
}

export type SellerStatus = {
  merchantId: string;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  /** True when the seller granted our app third-party permissions. */
  granted: boolean;
};

/**
 * Looks up the seller who finished onboarding with our own `trackingId`, then their status.
 * We never trust the merchant ID in the return URL's query string: it is read back from PayPal.
 * Returns undefined while PayPal has no seller for that tracking ID.
 */
export async function sellerByTrackingId(trackingId: string): Promise<SellerStatus | undefined> {
  const partner = process.env.PAYPAL_PARTNER_MERCHANT_ID;
  if (!partner) throw new Error('PAYPAL_PARTNER_MERCHANT_ID must be set');
  let merchantId: string | undefined;
  try {
    ({ merchant_id: merchantId } = await get<{ merchant_id?: string }>(
      `/v1/customer/partners/${encodeURIComponent(partner)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`,
    ));
  } catch (error) {
    if (error instanceof PayPalApiError && error.status === 404) return undefined;
    throw error;
  }
  if (!merchantId) return undefined;
  const status = await get<{
    merchant_id: string;
    payments_receivable?: boolean;
    primary_email_confirmed?: boolean;
    oauth_integrations?: { integration_type?: string; oauth_third_party?: { partner_client_id?: string }[] }[];
  }>(`/v1/customer/partners/${encodeURIComponent(partner)}/merchant-integrations/${encodeURIComponent(merchantId)}`);
  const granted = (status.oauth_integrations ?? []).some(
    (o) => o.integration_type === 'OAUTH_THIRD_PARTY' && (o.oauth_third_party ?? []).some((t) => t.partner_client_id === process.env.PAYPAL_CLIENT_ID),
  );
  return {
    merchantId: status.merchant_id,
    paymentsReceivable: status.payments_receivable === true,
    primaryEmailConfirmed: status.primary_email_confirmed === true,
    granted,
  };
}

// --- Orders (checkout) --------------------------------------------------------

export type OrderRequest = {
  dealId: string;
  /** `<dealId>:<card hash>`: ties the order to the exact card both sides confirmed. */
  customId: string;
  payeeMerchantId: string;
  amount: Money;
  item: { name: string; description: string; physical: boolean };
  returnUrl: string;
  cancelUrl: string;
};

export type Order = {
  id: string;
  status: string;
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    amount?: Money;
    payee?: { merchant_id?: string; email_address?: string };
    items?: { name: string; description?: string; quantity: string; unit_amount: Money }[];
    shipping?: { address?: Record<string, string> };
    payments?: { captures?: { id: string; status: string; amount?: Money }[] };
  }[];
  links?: { rel: string; href: string }[];
};

/** Creates the order on the server from the locked card. Never from browser input. */
export async function createOrder(o: OrderRequest, requestId: string): Promise<WithDebugId<Order>> {
  return send<Order>(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: o.dealId,
          custom_id: o.customId,
          payee: { merchant_id: o.payeeMerchantId },
          amount: { ...o.amount, breakdown: { item_total: o.amount } },
          items: [
            {
              name: o.item.name,
              description: o.item.description,
              quantity: '1',
              unit_amount: o.amount,
              category: o.item.physical ? 'PHYSICAL_GOODS' : 'DIGITAL_GOODS',
            },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Settle',
            user_action: 'PAY_NOW',
            shipping_preference: o.item.physical ? 'GET_FROM_FILE' : 'NO_SHIPPING',
            return_url: o.returnUrl,
            cancel_url: o.cancelUrl,
          },
        },
      },
    },
    requestId,
  );
}

/** A fresh read of the order, as the connected seller. */
export function getOrder(orderId: string, sellerMerchantId: string): Promise<WithDebugId<Order>> {
  return send<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, undefined, undefined, {
    'PayPal-Auth-Assertion': authAssertion(sellerMerchantId),
  });
}

/** Captures an approved order. The request ID makes a repeated capture the same request. */
export function captureOrder(orderId: string, requestId: string): Promise<WithDebugId<Order>> {
  return send<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
}
