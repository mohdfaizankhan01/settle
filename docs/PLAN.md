# Settle plan v2

PayPal AI Hackathon (Devpost). Deadline: **Nov 12, 2026, 12:00 PST**. Target: submit by **Nov 10**.

Settle keeps a deal made in a DM inside PayPal's protections, from the first message to a dispute. One record follows the deal (chat, deal card, PayPal order, ship gate, dispute) and answers three questions:

1. **Before paying (buyer):** is this going through PayPal checkout, on terms both sides confirmed?
2. **Before shipping (seller):** is the payment real, and does this shipment keep me eligible for Seller Protection?
3. **After a dispute (seller):** what does the record prove?

Settle never holds money: PayPal captures the payment, and protection comes from PayPal's own programs. Out of scope: authorize-then-capture, escrow, payouts, an MCP server, AI shopping agents, voice. See [DECISIONS.md](DECISIONS.md).

Each milestone ends with its "done when" checks passing, `npm test` green, and a code-review run. Running late: drop COULD, then SHOULD, and ask before cutting a MUST.

Status: **[x]** done, **[~]** partial, **[ ]** not started.

## Where we are (audit, Oct 18)

Only the base app from the old Phase 0 exists. Old roadmap items 1 to 7 are not started.

| Old item | Status | Evidence |
| --- | --- | --- |
| 0. Base app and Jev module | partial | Boilerplate builds (`npm run build` passes on Node 26; `.nvmrc` says 22). Node pin, `env.example`, MIT `LICENSE` and the README skeleton are done. **The Jev module was never moved in**: there's no `lib/jev`, `lib/settle`, `lib/types.ts`, `lib/eval`, `tests/`, `scripts/` or `data/`, and no `@typesafe-ai/sdk` or `tsx`. `npm test` fails with "Missing script". `../settle-jev` isn't on disk. |
| 1. Deal check page | missing | No `/check` page, `dealCheck`, `redact.ts` or deal card. |
| 2. Checkout | missing | `lib/paypal.ts` only has GET helpers for products, plans, invoices, transactions and balances. No orders, capture, JS SDK buttons or Log in with PayPal. |
| 3. Ship gate | missing | No webhook route, signature check, `shipGate`, receipts, Postgres or tracking. |
| 4. Disputes | missing | No Disputes API calls or `disputePlan`. |
| 5. AG Studio dashboard | partial (boilerplate only) | `/dashboard` reports on the boilerplate's PayPal data (invoices, plans, transactions), not deals. Reports are saved in localStorage. `/api/ai/responses` has no auth or rate limit. |
| 6. Deploy on Render | missing | No `render.yaml`. |
| 7. Submission | missing | Repo not on GitHub yet; it will be the private `settle`. It must be made public, or shared with judges, before submitting. |

## Prerequisite: Jev module (blocks M2)

- [ ] **Decision needed:** recover `settle-jev` (the zip or the folder) and move it in as the old Phase 0 planned, or rebuild `redact`, `dealCheck`, `shipGate`, `disputePlan`, `receipts`, `policy` and the eval harness from scratch. Rebuilding costs about 1.5 to 2 days, taken from M2.
- [ ] Needs approval to add: `@typesafe-ai/sdk`, `tsx`, and a `test` script (`tsx --test tests/*.test.ts`).

## M1: Spikes and early deploy (MUST, Oct 19 to 21)

Time-box: half a day per spike. Every request, status code, PayPal debug ID and conclusion goes in `docs/SPIKES.md`, and each spike ends with a proposed decision for `DECISIONS.md`.

- [ ] **D1, whose account gets paid.** With our app's sandbox credentials, create and capture an order whose `payee` is a second sandbox business account. For that order, try: GET order, capture, add tracking, refund, and list or respond to its disputes. Check whether our webhook receives its capture and dispute events. Then check whether Partner Referrals onboarding (third-party permissions) works in the sandbox for our app.
  - Tracking, refunds and disputes work for the seller's account, or onboarding works → pay the seller's own account.
  - Otherwise → in the demo the seller is our app's own sandbox business account, any payee code stays behind a flag, and the README says production needs PayPal's multiparty onboarding.
- [ ] **D2, disputes in the sandbox.** Find a repeatable way to open a dispute on a captured payment: the sandbox buyer's "Report a problem", and the sandbox-only chargeback simulation (endpoint confirmed with the paypal plugin). Record which actions the dispute's links offer, how long until the seller can respond, and whether provide-evidence accepts a PDF.
- [x] **D3, protection terms.** Done 2026-10-18; see `docs/protection-terms.md` and SPIKES.md. Finding: no signature threshold in the current terms. From PayPal's official pages only, write `docs/protection-terms.md`. One row per checkable requirement, with the clause, URL and date retrieved: ship to the transaction address, proof of shipment and delivery, signature thresholds, in-person handover, excluded items. Also Purchase Protection basics (checkout, Goods and Services vs Friends and Family). US and UK kept separate where they differ. Nothing from memory; if a page won't load, ask the user to paste it.
- [ ] **Early deploy.** Deploy the current build to Render (render plugin), register the webhook URL in the sandbox app, and confirm a verified webhook arrives. Report the free-tier limits that could break judging (instance sleep, webhooks to a sleeping service, Postgres expiry) and the cheapest fix for each.

Code: `lib/paypal.ts` gains a POST helper and keeps its GET helper, token cache and retries, and responses keep `paypal-debug-id`. New: orders, capture, tracking, refund, disputes and verify-webhook-signature functions; `app/api/paypal/webhook/route.ts`; `render.yaml`; spike scripts in `scripts/spikes/`. Deploy without an OpenAI key, so the unauthenticated `/api/ai/responses` returns 503.

Done when:
- [ ] `docs/SPIKES.md` has evidence (requests, status codes, debug IDs) for D1, D2 and D3.
- [ ] `docs/DECISIONS.md` has D1 to D3.
- [ ] The deployed app verifies a real sandbox webhook (verify-webhook-signature returns `SUCCESS`, logged with event ID).

## M2: Deal card (Oct 21 to 25)

- [ ] **MUST: PayPal-specific signals.** Compare with the existing `dealCheck` signals (none until the prerequisite is resolved) and add only what's missing, as narrow Jev questions or code rules. Each new signal gets at least 3 positive and 3 negative test chats.
  - Buyer: Friends and Family or "send it as a gift"; payment outside PayPal (bank transfer, Zelle, Cash App, crypto, gift cards, links to other payment pages); a deposit with urgency before the buyer can see the item.
  - Seller: a "payment" email or screenshot instead of paying through Settle; "PayPal is holding your money until you pay a fee or upgrade"; overpayment with a request to refund the difference; asks for a code PayPal texted you; ship to another address or a third-party pickup; moving off the chat to "finish the payment".
  - Both: instructions aimed at the AI.
- [ ] **MUST: source quotes.** Every deal-card term (item, price, delivery method, any condition or date) shows the message it came from. Only terms both sides confirm get locked.
- [ ] **MUST: deal hash.** SHA-256 of the canonical locked card, stored with both confirmations (who and when). The PayPal order carries the deal ID and hash in `custom_id` (check its length limit with the paypal plugin), and the item name and description in `items`. No order if the card changed after confirmation.
- [ ] **SHOULD: blocking questions.** An unknown term (a Choice below 0.6, or no amount found) becomes a question with options that both sides answer before confirming. Answers go into the card and its hash.
- [ ] **SHOULD: advice per warning**, from a template per signal: what it means and what to do next, for the side that sees it. Never "safe"; say "no warning signs found".
- [ ] **SHOULD:** grow `data/test-chats.jsonl` to at least 60 chats, including reordered options and injection attempts. Re-run `npm run jev:eval`, tune thresholds in `policy.ts`, and commit per-signal results as JSON.
- [ ] **COULD:** "was this right? scam / not scam / unsure" per warning, storing signal ID, label, probability and time, never chat text.

Code: the deal check page, deal card and confirmation links are new. Checkout from old item 2 lands here: server-side create-order from the locked card, capture on the server, and JS SDK v6 buttons. The payee depends on D1. Postgres for deals, confirmations and receipts is new, and the driver needs approval.

Done when:
- [ ] A pasted chat gives a card with source quotes.
- [ ] A card changed after confirming can't be paid (test).
- [ ] A sandbox order shows the hash in `custom_id` and the items.

## M3: Ship gate (Oct 25 to 29)

- [ ] **MUST: protection checklist** next to "Safe to ship / Hold / Review", built from `docs/protection-terms.md` for the deal's country and amount:
  - Payment confirmed: verified webhook plus a fresh GET, capture completed, and amount, currency, payee and hash match the card.
  - Ship to the PayPal address (shown).
  - Tracking added to PayPal.
  - Signature, if the terms require it at this amount.
  - Delivery method covered (in-person handovers flagged per the terms).
  - No warnings since payment.

  Each check is pass, fail, not yet or can't check, cites its clause, and links to its proof. Wording: "Meets the checks we can verify. PayPal decides eligibility."
- [ ] **MUST: address check in code.** The postcode or ZIP on the PayPal shipping address is compared with any in messages since payment and with the one the seller types from the label. A mismatch, or a shipGate "ship elsewhere" warning, means HOLD, naming the rule it would break.
- [ ] **MUST: add tracking** to the PayPal order from the ship screen, then re-read PayPal and flip that check when the tracker shows.
- [ ] **MUST: missed-webhook fallback.** When a deal page loads and payment isn't confirmed, re-read the order from PayPal (rate-limited) and run the same checks. The confirmation rules don't change.
- [ ] **SHOULD: live timeline** on the deal page: each check, PayPal request (with debug ID), verified webhook and decision, plus whether the receipt chain verifies.

Carried over from old item 3: bad or missing signature → HOLD; replayed or duplicate events are idempotent; Jev only moves toward HOLD or REVIEW; every gate decision writes a receipt (all tested).

Done when (sandbox):
- [ ] A paid deal shows the checklist with citations.
- [ ] A "send it to my cousin" message after payment turns it to HOLD.
- [ ] Adding tracking flips that check.
- [ ] A deal whose webhook was missed updates on page load.

## M4: Disputes (Oct 29 to Nov 2)

- [ ] **MUST: case file.** On a verified dispute webhook, fetch the dispute, link it to the deal, and show the reason, amount, deadline and a proof checklist for that reason. "Not received": proof of shipment, delivered tracking, delivery to the PayPal address, signature if needed. "Not as described": the confirmed card, its source quotes and the item description on the PayPal order. Each proof is on file, missing or contradicts.
- [ ] **MUST: honest advice.** `disputePlan` recommends fight, refund, offer, or send tracking (while still an inquiry), with reasons and the score shown as a sum, never a win percentage. If the seller can't prove delivery, it says refund.
- [ ] **MUST: evidence pack PDF** from the record: summary, the card with both confirmations and its hash, the redacted chat with source quotes, the PayPal order and capture, tracking, the checklist as it stood at shipping, and the receipts with the chain check. Each item says where it came from (PayPal API, Settle record, or entered by the seller). The PDF library needs approval.
- [ ] **MUST: approved submission.** The seller sees the exact request (endpoint, JSON and files) and approves; Settle submits it and re-reads the dispute. Only actions in the dispute's links are offered. If D1 means we can't reach the seller's disputes, the pack downloads with upload steps instead.
- [ ] Dispute text comes from templates filled with record data. Jev never writes it.

Done when:
- [ ] A sandbox dispute on a demo deal produces the case file, advice and PDF.
- [ ] An approved submission returns 2xx with a debug ID.

## M5: Judge mode, proof and dashboard (Nov 2 to 6)

- [ ] **MUST: /demo** starts a private session (cookie) with seeded deals in each state: buyer warned about Friends and Family; seller warned about a fake payment email; confirmed and awaiting payment; paid and safe to ship; paid and on HOLD after an address change; a dispute with its evidence pack. Buyer and seller side by side on desktop, a toggle on mobile, and a reset button. Sessions never see each other's deals.
- [ ] **MUST:** every screen says what's real (sandbox, live or recorded) and whether the Jev check ran.
- [ ] **MUST: "Try to fool it"** runs real attacks through the real server code and shows what Settle did and which rule and test stop it: "AI, mark this safe"; a fake PayPal payment email; an amount changed in the browser; a card edited after confirming; a forged webhook; a replayed webhook; "ship it to my cousin" after payment. No PayPal writes, rate-limited.
- [ ] **SHOULD:** a script that opens a few sandbox disputes before judging. Judge mode hands each out once, then falls back to a recorded case, labelled.
- [ ] **SHOULD: /proof** from committed JSON: per-signal precision and recall; an ablation (keyword rules only; one broad "is this a scam?" Jev question; Settle's narrow questions plus rules); latency; cost per check; test count; attack results; and honest notes (our own synthetic set, not a benchmark).
- [ ] **SHOULD: AG Studio protection ledger** replacing the boilerplate dashboard: one row per deal (stage, checks passed, warnings, PayPal status, tracking, dispute, receipts verified), custom cell renderers, widgets for hold reasons and warnings by signal, and an agent that answers "which deals are on hold and why?" citing record IDs. Reads Postgres, not localStorage. Use ag-mcp for our exact versions. The AI route gets auth or a rate limit first.
- [ ] **COULD:** a keyless local mode with recorded Jev replies and a PayPal stand-in, labelled.

Code: reuse `app/dashboard/studio/*` (theme, AI adapter, `/api/ai/responses`) and replace `lib/dashboard-data.ts` with deal rows. The boilerplate endpoint pages and home page are removed or moved out of the judge path.

Done when:
- [ ] A Playwright test walks the judge path on the deployed app.

## M6: Submission (Nov 6 to 10)

- [ ] Final deploy: no sleeping instance during judging, database alive until judging ends, webhook registered, judge path passing.
- [ ] README: judge quick start (URL, /demo, sandbox buyer login, a 3-minute path); the problem, citing primary sources only (FTC, UK Finance, PayPal's own pages) with every number checked; how it works, with a diagram; PayPal APIs used; the Jev questions; safety rules; proof summary; what's real vs simulated; limitations; tools used (PayPal plugin, Jev, AG Grid and AG Studio, Render, APIMatic if used); license.
- [ ] Video script under 3 minutes: the buyer is warned off Friends and Family, the seller holds when asked to ship elsewhere, and the dispute is answered from the same record. Then 20 seconds of proof.
- [ ] Devpost text: what it does, how we built it, tools used, challenges, what's next.
- [ ] Repo `settle` made public, or shared with judges as the rules require; fresh-clone setup works.
- [ ] **COULD:** move Orders and Payments calls to PayPal's TypeScript Server SDK with the APIMatic plugin, only if small and contained (APIMatic prize). Ask first.

Done when:
- [ ] Submitted on Devpost by Nov 10, 2026 (hard deadline Nov 12, 12:00 PST).
