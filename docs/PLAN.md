# Settle plan

PayPal AI Hackathon (Devpost). Deadline: **Nov 12, 2026, 12:00 PST**.

Each phase ends with its "done when" checks passing, `npm test` green, and a code-review run.

## Phase 0: Base app and Jev module

- Node 22 pinned (`.nvmrc`, `engines`); `npm install` and `npm run dev` work.
- Jev module moved in: `src/jev` → `lib/jev`, `src/settle` → `lib/settle`, `src/types.ts` → `lib/types.ts`, `src/eval` → `lib/eval`, `test/` → `tests/`, plus `scripts/` and `data/`. Imports fixed.
- `@typesafe-ai/sdk` and `tsx` added; scripts `test`, `jev:smoke`, `jev:eval` (the last two with `--env-file=.env.local`).
- `env.example` lists names only; MIT `LICENSE`; README skeleton for judges.

Done when:
- [ ] Boilerplate pages (`/products`, `/plans`, `/invoices`, `/transactions`, `/balances`, `/dashboard`) load with the sandbox keys.
- [ ] `npm test` passes all 18 tests; `npm run build` succeeds.
- [ ] `npm run jev:smoke` runs (if `TYPESAFE_API_KEY` is set) and reports latency, tokens and cost.
- [ ] `git check-ignore .env.local` confirms it is ignored; no secrets in `git log -p`.

## Phase 1: Deal check page

Paste a chat, run `dealCheck`, show warnings split into "for the buyer" and "for the seller", and build the deal card (item, price, delivery) that both sides confirm by link.

Done when:
- [ ] Chat text is redacted (`lib/settle/redact.ts`) before Jev sees it; a test proves no raw phone/email/link reaches the Jev mock.
- [ ] Price, currency, dates and links are parsed in code, with tests; Jev output never sets them.
- [ ] Warnings render in two groups; with none, the UI says "no warning signs found" (never "safe").
- [ ] A Jev error or timeout yields REVIEW, with a test.
- [ ] Deal card locks after both sides confirm via their links; edits after locking are rejected; each confirmation writes a receipt.
- [ ] `npm run jev:eval` re-run if any question or threshold changed.

## Phase 2: Checkout

Deal page with PayPal JS SDK v6 buttons, order created and captured on the server, Log in with PayPal for sellers.

Done when:
- [ ] Seller connects with Log in with PayPal; their merchant ID is stored on the deal.
- [ ] The create-order route builds the order only from the locked deal card (amount, currency, payee); a test shows browser-supplied amounts are ignored.
- [ ] Capture runs on the server; the client callback never marks the deal paid.
- [ ] A sandbox buyer completes checkout end to end (playwright run, screenshot saved).

## Phase 3: Ship gate

Webhook route with signature check, order re-fetch, `shipGate`, receipts in Postgres, a "Safe to ship / Hold / Review" screen, and tracking added to the PayPal order.

Done when:
- [ ] Webhook route calls verify-webhook-signature; a bad or missing signature leaves the deal on HOLD (test).
- [ ] After verification, the order is fetched fresh and amount, currency, payee and status are checked against the deal card; any mismatch → HOLD (test).
- [ ] Replayed or duplicate webhook events are idempotent (test).
- [ ] Receipts persist in Postgres for every gate decision.
- [ ] "Safe to ship" appears only on verified + re-fetched COMPLETED capture; Jev can only move a deal toward HOLD/REVIEW (test).
- [ ] Seller adds tracking; it is sent to the PayPal order and shows in the sandbox.

## Phase 4: Disputes

Create a test dispute in the sandbox, run `disputePlan` on the dispute webhook, seller approves, submit evidence through the Disputes API.

Done when:
- [ ] A sandbox dispute triggers the dispute webhook (verified as in Phase 3).
- [ ] `disputePlan` drafts a response from receipts, tracking and the deal card; nothing is sent automatically (test).
- [ ] The seller reviews, edits and approves; only then is evidence submitted through the Disputes API; a receipt is written.
- [ ] Errors leave the dispute in REVIEW with a clear message.

## Phase 5: AG Studio dashboard

Deals, warnings and receipts, with custom widgets and theme, plus an agent that answers "which deals are on hold and why?".

Done when:
- [ ] Dashboard reads deals, warnings and receipts from Postgres (not localStorage).
- [ ] Custom widgets and a Settle theme are in place (checked against ag-mcp docs for our AG Studio version).
- [ ] The agent answers "which deals are on hold and why?" correctly on seed data, citing receipts.
- [ ] The AI route has auth or rate limiting before it is deployed.

## Phase 6: Deploy on Render

`render.yaml`, register the webhook URL in the sandbox app, seed demo data.

Done when:
- [ ] `render.yaml` validates and deploys; all env vars set in Render, none in git.
- [ ] Sandbox webhook points at the Render URL; `PAYPAL_WEBHOOK_ID` set; a test event verifies.
- [ ] Demo data seeded by a script.
- [ ] Free-tier limits checked (cold starts, Postgres lifetime/expiry) and a list of what could break during judging is written in this file, with mitigations.

## Phase 7: Submission

Done when:
- [ ] Repo is public, with MIT license and judge setup steps that work from a fresh clone.
- [ ] Demo video under 3 minutes.
- [ ] Devpost text written; AG Grid sponsor prize requirements met.
- [ ] Submitted before Nov 12, 2026, 12:00 PST.
