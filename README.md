# Settle Link

**Nobody has to go first.** Strangers who agree a deal in a DM hit a standoff: the buyer won't pay first and the seller won't ship first. Scammers use that from both sides. Settle Link turns the chat into one deal link both sides confirm. The buyer pays through PayPal checkout, the PayPal order carries the agreed terms, the seller ships only once PayPal confirms the payment, and the record is on file if a dispute comes.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com). Everything runs on the PayPal sandbox: no real money moves.

Started from PayPal's [AG Grid hackathon boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) (Next.js, AG Grid, AG Studio, plain-fetch PayPal client). Its notes are kept below under "Boilerplate reference". Licensed under [MIT](LICENSE).

## Problem

Casual buyers and sellers in the US and UK trade with strangers on Instagram, Facebook Marketplace and WhatsApp. Fake sellers push Friends and Family or a bank transfer, where PayPal's Purchase Protection doesn't apply. Fake buyers send a "payment received" screenshot or ask to ship to another address, which can cost the seller Seller Protection. PayPal's protections cover both sides, but only when the deal runs through PayPal checkout, on clear terms, and the seller ships the protected way.

_TODO: sourced figures (FTC, UK Finance), checked against the primary reports._

## Solution

_TODO: screenshots._

1. **Deal link.** Either side pastes the chat. Settle Link reads the terms (item, price, delivery, ship-by date), shows the message each came from, and asks both sides anything it isn't sure of. It shows PayPal's fee and both sides agree who pays it. Both confirm; the card is locked by its SHA-256 hash. Either side can decline with a reason, which the other side sees first.
2. **Warnings for both sides.** Friends and Family requests, payment outside PayPal, fake payment proof, "ship it to my cousin", instructions aimed at the AI, and more. The AI explains warnings; it never approves a payment or a shipment.
3. **Pay with PayPal.** The server creates the order from the locked card (total, items, and `<dealId>:<hash>` in `custom_id`), never from the browser. The money goes to the seller's own PayPal account. Capture happens only after a fresh read of the order matches the card.
4. **Ship gate** _(in progress)_. Payment counts as confirmed only after a verified PayPal webhook and a fresh order read. Anything else is Hold or Review.
5. **Disputes** _(planned)_. Evidence comes from the record; the seller approves the exact request before it is sent.

## How it works

_TODO: architecture diagram._

- **Redaction first**: names, emails, phone numbers, addresses and bank details are removed before any model sees the chat. Prices, dates and links become tokens whose values stay in code.
- **Warning check**: Settle Link's own small model, plus keyword rules. Each redacted message becomes a MiniLM sentence embedding (quantized, run on our server with transformers.js), and one logistic-regression classifier per warning gives a probability (`lib/model`). No chat text goes to an AI provider. Trained on hand-written messages (`data/train-messages.jsonl`), thresholds picked by cross-validation on those messages, and tested on 73 separate chats it never trains on (`npm run eval`, results in `data/eval/`). A lighter model on word and character patterns is kept for comparison (`SETTLE_MODEL=a`). Fail closed: if the check can't run, nobody can confirm the card.
- **PayPal** (sandbox): Orders v2, JS SDK v6, Partner Referrals (seller onboarding), webhooks with `verify-webhook-signature`, order tracking, Disputes API. All calls run on the server (`lib/paypal.ts`).
- **Wording**: the UI says "no warning signs found", never "safe". Settle Link says which checks pass; PayPal decides eligibility. Every check cites `docs/protection-terms.md`; fees cite `docs/fees.md`.
- **Receipts**: every decision writes a receipt into a hash chain.

## Setup and run (for judges)

_TODO: live demo URL and sandbox test buyer login._

Requires Node.js 22 (`nvm use` reads `.nvmrc`) and a PayPal sandbox REST app of type Platform.

```bash
git clone <repo-url> settle && cd settle
nvm use
npm install
npm run model:fetch         # once: downloads the 24 MB MiniLM model into ./models
cp env.example .env.local   # fill in PAYPAL_CLIENT_ID, PAYPAL_SECRET and the others
npm run dev                 # http://localhost:3000, then open /check
npm test                    # unit tests, the AI check and PayPal mocked
```

_TODO: webhook setup for local runs, seed data, demo walkthrough._

## Tools used

- **PayPal APIs**: Orders v2, JS SDK v6, Partner Referrals, Webhooks, Disputes (sandbox).
- **AI**: Settle Link's own warning model (see How it works). Jev (TypeSafe) is supported behind `JEV_PROVIDER=typesafe`.
- **AG Grid and AG Studio** for the deals, warnings and receipts dashboard (planned).
- **Render** for hosting and Postgres.
- Built with Claude Code; plugins listed under Team setup.

## Team setup

Each teammate runs these once from the repo root. The project-scope plugins are listed in `.claude/settings.json` and `ag-mcp` in `.mcp.json`, so these lines just fetch them.

```bash
# Only if `claude plugin marketplace list` doesn't already show claude-plugins-official
claude plugin marketplace add anthropics/claude-plugins-official

claude plugin marketplace add typesafe-ai/skills
claude plugin install paypal@claude-plugins-official --scope project
claude plugin install typesafe@typesafe-ai --scope project
claude plugin install render@claude-plugins-official --scope project
claude plugin install security-guidance@claude-plugins-official --scope project
claude plugin install frontend-design@claude-plugins-official --scope project
claude plugin install playwright@claude-plugins-official --scope project
claude plugin install code-review@claude-plugins-official --scope project
claude mcp add --scope project ag-mcp -- npx ag-mcp   # already in .mcp.json; skip if present
npx context-plugins install paypal --targets claude -y  # APIMatic PayPal SDK skills (installs at user scope)
claude plugin disable paypal@context-plugins            # keep it off for now (see below)
```

The APIMatic PayPal SDK skills add about 5k tokens to every session and only help if we use PayPal's TypeScript Server SDK. We use plain `fetch` in `lib/paypal.ts`, so keep the plugin disabled until we switch (`claude plugin enable paypal@context-plugins`). It installs at user scope, so disabling it affects all your projects.

Then:

1. Put your sandbox keys in `.env.local` (see `env.example`). It is git-ignored.
2. Put a sandbox access token in **your user** settings (`~/.claude/settings.json`, never the repo) as `env.PAYPAL_SANDBOX_ACCESS_TOKEN`, for the paypal plugin's sandbox MCP. `/paypal:setup` does this; `/paypal:setup refresh` renews it (sandbox tokens last about 9 hours).
3. Restart Claude Code, approve `ag-mcp` when asked, and run `/paypal:setup` to check the token.

# Boilerplate reference

## PayPal SDK data pages

A Next.js app that reads PayPal sandbox data over the [PayPal REST API](https://developer.paypal.com/api/rest/) and shows it two ways:

- **Endpoint pages**: one [AG Grid](https://www.ag-grid.com/react-data-grid/) per PayPal endpoint the demo calls, showing what each returns.
- **Dashboard** (`/dashboard`): an [AG Studio](https://www.ag-grid.com/studio/) report over all of that data, joined together, which you can edit and save in the browser.

## Run locally

Requires Node.js 20.9 or later and a PayPal sandbox REST app ([developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox)). The transactions and balances pages also need the app's **Transaction search** feature enabled.

```bash
npm install
cp env.example .env.local   # then fill in the values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Next.js only loads the dotted `.env.local`; it is git-ignored, so credentials stay out of the repo.

Other scripts: `npm run build` (production build), `npm run start` (serve the build), `npm run lint`.

### AG Studio licence (optional)

Set `AG_STUDIO` in `.env.local` to your AG Studio licence key. The dashboard passes it to `AgStudioProvider`.

### AI assistant (optional)

The AG Studio dashboard at `/dashboard` has an AI assistant backed by OpenAI. The key is taken from the first of these that is set; with neither, the assistant is hidden:

1. `AG_STUDIO_OPENAI_API_KEY`, specific to this app. Put it in `.env.local` to choose the key for this demo.
2. `OPENAI_API_KEY`, the name OpenAI's own tools use. If you already export one (e.g. in `~/.zshrc`), the demo uses it with no setup, and spends against it.

A separate name is needed because Next.js prefers variables already in the environment over `.env.local`, so a globally exported `OPENAI_API_KEY` can't be overridden per project. The server logs which variable it used (never the key) the first time the assistant is configured.

`OPENAI_MODELS` lists the model ids the assistant may use, comma-separated, first one the default (`gpt-5.4-mini` when unset); with two or more, the chat offers a model picker.

The key never reaches the browser. Studio's adapter ([`openai-adapter.ts`](app/dashboard/studio/openai-adapter.ts), copied from the AG Studio docs) runs client-side and posts to this app's own [`/api/ai/responses`](app/api/ai/responses/route.ts), which adds the key, only allows the configured models, caps output tokens, and streams OpenAI's reply back.

In production `.env.local` isn't deployed: set the variable in your host's environment (e.g. Vercel project settings, `docker run --env-file`, or a secrets manager), as with the PayPal credentials. The route has no auth or rate limiting, so don't deploy it publicly with a real key without adding one.

## How it works

```
lib/paypal.ts            Every PayPal call: OAuth token, paging, retries, response types
lib/dashboard-data.ts    Turns those responses into the dashboard's related tables
app/(endpoints)/         One page per endpoint, each rendering an AG Grid
app/dashboard/           The AG Studio dashboard
app/api/ai/responses/    Server-side proxy for the dashboard's AI assistant
```

[`lib/paypal.ts`](lib/paypal.ts) calls the REST API with plain `fetch`, no SDK. It gets an OAuth access token with the client-credentials grant and caches it until just before it expires. It follows `page`/`total_pages` paging, and retries on 401, 429 and 5xx responses. Its types are hand-written for the fields this demo reads, in the API's own snake_case.

Every page is a server component that calls `await connection()`, so it renders per request with live data instead of being prerendered at build time. PayPal credentials never leave the server.

## Endpoint pages

Each page in [`app/(endpoints)`](app/(endpoints)) calls one function in `lib/paypal.ts`, maps the response to flat rows, and passes them with plain column definitions to the shared [`DataGrid`](app/(endpoints)/data-grid.tsx). The page header shows the REST calls behind it.

| Page | `lib/paypal.ts` function | REST calls |
|---|---|---|
| [`/products`](app/(endpoints)/products/page.tsx) | `listProducts()` | `GET /v1/catalogs/products`, then `GET /v1/catalogs/products/{id}` per product |
| [`/plans`](app/(endpoints)/plans/page.tsx) | `listPlans()` | `GET /v1/billing/plans`, then `GET /v1/billing/plans/{id}` per plan |
| [`/invoices`](app/(endpoints)/invoices/page.tsx) | `listInvoices()` | `GET /v2/invoicing/invoices`, then `GET /v2/invoicing/invoices/{id}` per invoice |
| [`/transactions`](app/(endpoints)/transactions/page.tsx) | `searchTransactions(start, end)` | `GET /v1/reporting/transactions` |
| [`/balances`](app/(endpoints)/balances/page.tsx) | `getBalances()` | `GET /v1/reporting/balances` |

Things worth knowing about these endpoints:

- **List endpoints return summaries.** Products have no type or category, plans no billing cycles, and invoices no line items, payments or refunds. So each record is fetched again in full, which is why these pages take a second or two.
- **Billing plans keep their price in `billing_cycles`.** There is an optional `TRIAL` cycle, then the `REGULAR` cycle; `total_cycles: 0` means it bills until cancelled.
- **Transaction Search covers at most 31 days per request** and rejects fractional seconds in dates. New activity can take up to three hours to appear. `fields=all` adds `payer_info` to each `transaction_info`. Event codes are [PayPal T-codes](https://developer.paypal.com/docs/transaction-search/transaction-event-codes/) (`T0001` = payout); status is `S` success, `P` pending, `D` denied, `V` reversed or `F` partially refunded.
- **Amounts are decimal strings with a currency**, e.g. `{ "value": "2.99", "currency_code": "USD" }`. `amountOf()` turns them into numbers, and the grid formats money columns in each row's currency.

### The grid

Pages are server components, so the column definitions they pass to the grid must be plain data, with no functions. Money columns use the `type: 'money'` column type, defined in `data-grid.tsx`, which formats the value in the row's `currency`. Date columns use AG Grid's built-in `cellDataType: 'dateString'` or `'dateTimeString'`. Every column can be sorted and filtered, and the search box filters across all columns.

## Dashboard

[`/dashboard`](app/dashboard/page.tsx) fetches all five endpoints at once. [`lib/dashboard-data.ts`](lib/dashboard-data.ts) turns them into related tables: customers, invoices, invoice line items, invoice payments, products, plans, transactions, payouts and balances. AG Studio's data sources, relationships, theme, default report and AI assistant are configured in [`app/dashboard/studio`](app/dashboard/studio). Reports you create or edit are saved in the browser's localStorage.
