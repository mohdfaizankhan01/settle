// The boilerplate data pages (/dashboard, /products, /plans, /invoices, /transactions, /balances)
// and the AI proxy (/api/ai) read our own PayPal account or spend our OpenAI key, with no login.
// They are for local development only: in production they answer 404 unless SETTLE_DEV_PAGES=1.
// Fail closed: anything other than exactly "1" keeps them off in production.

type Env = Partial<Record<'NODE_ENV' | 'SETTLE_DEV_PAGES', string>>;

export function devPagesEnabled(env: Env = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.SETTLE_DEV_PAGES === '1';
}
