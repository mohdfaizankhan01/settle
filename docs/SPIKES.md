# M1 spikes

Evidence log for D1 to D3: every request, status code, PayPal debug ID and conclusion. Newest entries last within each spike.

## D3: protection terms — done 2026-10-18

Pages fetched with `curl` (GET, all HTTP 200), converted to text, and quoted in [protection-terms.md](protection-terms.md). All 62 quotes were machine-checked against the downloaded text.

| Page | Status | Updated |
| --- | --- | --- |
| https://www.paypal.com/us/legalhub/paypal/useragreement-full | 200 | September 14, 2026 |
| https://www.paypal.com/us/legalhub/paypal/seller-protection | 200 | January 26, 2026 |
| https://www.paypal.com/us/legalhub/paypal/buyer-protection | 200 | January 26, 2026 |
| https://www.paypal.com/uk/legalhub/paypal/useragreement-full | 200 | 12 October 2026 |
| https://www.paypal.com/uk/legalhub/paypal/seller-protection | 200 | 12 October 2026 |
| https://www.paypal.com/uk/legalhub/paypal/buyer-protection | 200 | 12 October 2026 |

Findings:

- **No signature threshold** in any current US or UK page; "signature" doesn't appear at all. M3's "signature if the terms require it" check is dropped unless the terms change. Proposed: remove it from the M3 and M4 checklists.
- **In-person handover is excluded** from Seller Protection in both countries unless the buyer pays in person with a PayPal goods and services QR code. Settle doesn't offer QR payment, so "collect" or "meet up" deals fail SP-INPERSON. Buyers also lose Item Not Received cover for collection (PP-COLLECT).
- **Not as described is never covered by Seller Protection** (SP-SNAD). M4's "not as described" case file is evidence only, with no protection claim.
- **UK only:** "a single payment from one PayPal account … (partial payment and/or payment in instalments are excluded)" (SP-SINGLE). Deposit or split-payment chats are a UK seller warning.
- **US vs UK proof of shipment:** the US requires a matching address *and* at least city/state/ZIP; the UK says *or*. Settle checks the stricter US rule in both countries.
- **Friends and Family** is excluded from both programs, and asking a buyer for it breaks both user agreements (SP-FF, PP-FF, PP-SELLER-FF).

Proposed decision **D3**: the ship gate and dispute checklist check only the rows in `protection-terms.md`: SP-ADDR, SP-PROOF-SHIP, SP-PROOF-DELIV, SP-INPERSON, SP-FF, SP-SINGLE (UK), SP-EXCLUDED, SP-RELEASE, SP-SHIP-TIME (advice), plus the PP rows for buyer warnings. Each says pass, fail, not yet or can't check, with its row ID. Re-fetch and diff the pages before submission (Nov 9).

## API facts gathered for D1 and D2 (from PayPal's specs and docs, no API calls yet)

Sources: PayPal's OpenAPI specs (`github.com/paypal/paypal-rest-api-specifications`: `checkout_orders_v2.json`, `notifications_webhooks_v1.json`) and the docs page `developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api.md`.

- **`purchase_units[].custom_id`: maxLength 255** ("not visible to the payer"). The deal ID plus a 64-hex SHA-256 fits. `invoice_id` is 127 and must be unique per merchant. `description` keeps 127 characters. `items[].name` up to 3000, `items[].description` up to 4000.
- **Tracking:** `POST /v2/checkout/orders/{id}/track`, body `capture_id` (required, ≤50), `tracking_number` (≤64), `carrier`, optional `notify_payer` and `items`. The endpoint also takes a **`PayPal-Auth-Assertion`** header, which is how an app acts on another merchant's account and is central to D1.
- **Payee:** `purchase_units[].payee` takes `email_address` or `merchant_id`.
- **Webhook verify:** `POST /v1/notifications/verify-webhook-signature`, all required: `auth_algo` (header `PAYPAL-AUTH-ALGO`), `cert_url` (`PAYPAL-CERT-URL`), `transmission_id` (`PAYPAL-TRANSMISSION-ID`), `transmission_sig` (`PAYPAL-TRANSMISSION-SIG`), `transmission_time` (`PAYPAL-TRANSMISSION-TIME`), `webhook_id`, and `webhook_event` (the parsed body). Response: `verification_status` is `SUCCESS` or `FAILURE`.
- **Disputes:** `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`. Actions come from the dispute's HATEOAS `links` (for example `send-message`, `escalate`, `accept-claim`, `make-offer`, `provide-evidence`). `provide-evidence` is `multipart/form-data` with a JSON part and file parts; the docs' example attaches `file1=@NewDoc.pdf;type=application/pdf`, so PDFs are accepted. To confirm in D2.
- **Sandbox chargeback (unconfirmed):** the Exhibit reference repo's README calls `POST /v2/customer-support/process-chargeback` ("sandbox only"), with card reason codes such as 13.1 or 4855 (not received) and C2 (not as described). It also says "PayPal reviews a new chargeback for five to eight minutes before the seller can respond". The paypal plugin's references don't mention this endpoint; D2 must confirm it with a real call.

## D1: whose account gets paid — run 2026-10-21

Setup: sandbox REST app `settle`, type **Platform** (partner account `sb-bggow53338036@business.example.com`, merchant ID `L6E4H2XBV8NP6`). Seller `sb-s74z753471539@business.example.com` (merchant ID `RRBVDNUTQMAXN`), buyer `sb-9aelh53480109@personal.example.com`, all US. App token scopes include `customer/partner-referrals/readwrite`, `disputes/read-seller`, `disputes/update-seller`, `reporting/search/read`. Throwaway script, plain fetch, unsigned `PayPal-Auth-Assertion` (`alg: none`, `iss` = our client ID, `payer_id` = seller) per developer.paypal.com/api/rest/requests/.

Order `8YK30689B0267651L`, USD 10.00, `payee.email_address` = seller, `custom_id` = 73 chars (deal ID + 64-hex hash). Buyer approved in the browser.

| Step | Assertion | Status | Debug ID | Result |
| --- | --- | --- | --- | --- |
| Create order, payee = seller | — | 200 | ca4e12d6ebc57 | `PAYER_ACTION_REQUIRED` |
| Capture, seller not onboarded | — | **403** | f853492d72d1f | `PAYEE_NOT_CONSENTED` |
| Partner Referrals (PAYMENT, REFUND, ACCESS_MERCHANT_INFORMATION) | — | 201 | ca4e12d7b5cd3 | `action_url`; seller signed in and allowed |
| Capture after consent | — | 201 | f801206f9697d | `6CL39374CJ081260C` COMPLETED, `seller_protection: ELIGIBLE` (ITEM_NOT_RECEIVED, UNAUTHORIZED_TRANSACTION), fee 0.84 |
| GET order / GET capture | none and seller | 200 | f280444e7601a, f389844fe2a8c | `custom_id` kept; capture shows `payee.merchant_id` |
| Add tracking | none | 403 | f62475647dcad | `PERMISSION_DENIED` |
| Add tracking | seller | **201** | f5013755514bd | works without `TRACKING_SHIPMENT_READWRITE` |
| Refund 1.00 | none | 403 | f9195367a6839 | `PERMISSION_DENIED` |
| Refund 1.00 | seller | **201** | f197758619422 | capture `PARTIALLY_REFUNDED` |
| List disputes | none | 200 | f37121943ad96 | 0 items (our own account's disputes, not the seller's) |
| List disputes | seller | 403 | f197758b4524c | `NOT_AUTHORIZED` (no dispute feature requested yet) |
| Partner Referrals + READ/UPDATE_SELLER_DISPUTE, ADVANCED_TRANSACTIONS_SEARCH | — | 201 | f476823f3578f | seller allowed again; `TRACKING_SHIPMENT_READWRITE` alone gives 422 `FEATURES_UNAUTHORIZED` (f190886fc4237) |
| merchant-integrations | — | 200 | f8139607f1d56 | `payments_receivable` and `primary_email_confirmed` true; scopes include `disputes/read-seller`, `disputes/update-seller`, `reporting/search/read`, `payments/partnerfee` |
| List disputes | seller (payer_id, then email) | **403** | f10874245da55, f494357b7d0b6 | `NOT_AUTHORIZED` even with the grant |
| Transaction search | seller | **403** | f7005632cecc9, f49435750464d | `NOT_AUTHORIZED` |

Findings:

- **A platform can't take money for a seller until the seller consents.** Partner Referrals onboarding works in the sandbox for our app; after it, the seller is paid directly, and capture, GET, tracking and refunds on the seller's payment all work with `PayPal-Auth-Assertion`.
- **Disputes and Transaction Search on behalf of the seller are unproven.** The seller's grant lists the dispute and search scopes, but listing still returns 403. D2 must test `GET /v1/customer/disputes/{id}` and `provide-evidence` with the assertion on a real dispute against this capture before we rely on it.
- Seller onboarding shows the app's display name (`Test Store`) and PayPal's wording that the app may "manage any disputes … on your behalf". Rename the display name to Settle before the demo.
- The capture response states Seller Protection eligibility and categories. The ship gate can show this, citing protection-terms.md, and still say PayPal decides.
- We never request `PARTNER_FEE`, but PayPal's consent screen and scopes include fee deduction by default.

Proposed decision **D1**: the seller's own PayPal account is the payee, connected through Partner Referrals, with `payer_id` from merchant-integrations as the locked payee on the deal card. Payments, tracking and refunds go through `PayPal-Auth-Assertion`. Disputes depend on D2: if seller-dispute calls work on a real dispute, Settle sends the seller-approved response through the API; if not, Settle builds the templated case file and the seller submits it in PayPal's Resolution Center.

## D2: disputes in the sandbox — run 2026-10-21 and 2026-10-22

Opening a dispute by API failed; the buyer's Resolution Center works.

| Step | Assertion | Status | Debug ID | Result |
| --- | --- | --- | --- | --- |
| `POST /v2/customer-support/process-chargeback`, empty or capture-only body | — | 500 | f245170b44362, f9332024d1608 | endpoint exists; needs the full card-chargeback body from developer.paypal.com/platforms/disputes/test-go-live and a card-funded payment |
| `POST /v1/customer/disputes` (sandbox-only create), seller capture ID | buyer | 400 | f462995a1db19 | `No permissions to set target_client_id` |
| same, buyer transaction ID `4SS78204TL630382C` | buyer (payer_id, then email) | 400 | f839257b656c3, f257004173a03 | same: acting as the buyer needs the buyer's consent to our app |
| same | seller | 403 | f611484f846af, f245261ce1ca3 | `NOT_AUTHORIZED` |

| Buyer opens Item Not Received in the sandbox Resolution Center on buyer txn `4SS78204TL630382C` | — | — | — | case `PP-R-XYO-10194059`, USD 8.00 requested |
| GET dispute | none | 403 | f484405a9f762 | `ACTION_NOT_ALLOWED` |
| GET dispute | seller | **200** | f974974804ee7 | `INQUIRY`, `UNDER_REVIEW`; carries our `custom` (deal ID + hash) and `seller_transaction_id` = our capture |
| List disputes | seller | 200 | f45157537f9b9 | was 403 on 2026-10-21 (before the dispute existed / grant settled) |
| Webhooks on Render | — | 200 | — | `CUSTOMER.DISPUTE.CREATED` and `CUSTOMER.DISPUTE.UPDATED`, both `verified` |
| GET dispute after ~3 min | seller | 200 | — | stage now `CHARGEBACK`, still `UNDER_REVIEW`; only action link `provide_supporting_info` |
| provide-supporting-info, JSON `{notes}`, text built from logged records, approved by the user first | seller | **200** | f109742f431f2 | re-read shows the note verbatim, `source: SUBMITTED_BY_SELLER` |

Findings:

- **Settle can work a dispute for a connected seller**: read it, receive its webhooks, and send seller-approved supporting info with `PayPal-Auth-Assertion`. PayPal records the note as the seller's.
- Opening disputes on demand needs a buyer login (Resolution Center). The disputes create API needs the buyer's consent to our app; `process-chargeback` needs a card-funded payment and the full chargeback body. For judge mode, pre-open a dispute per demo, or retry `process-chargeback` with a card payment in M4.
- The buyer sees tracking we uploaded before they can file.
- Only actions in the dispute's links are offered: here just `provide_supporting_info`. `provide-supporting-info` also takes multipart documents: **confirmed 2026-11-03 (M4)**, dispute PP-R-BTN-10196230, `input` JSON part plus `file1` PDF, 2xx debug f4289668a7883, PayPal lists the PDF under `supporting_info.documents`, source SUBMITTED_BY_SELLER.
- The dispute's `seller_protection_eligible` was `false` although the capture said `ELIGIBLE`. Don't present either field as a verdict; cite the checks and say PayPal decides.
- Stages moved from `INQUIRY` to `CHARGEBACK` within minutes in the sandbox; Settle must re-read the dispute before offering an action.

Proposed decision **D2**: disputes run through the API for the connected seller. Settle reads the dispute, offers only the actions in its links, builds text from records, shows the seller the exact request, and sends only after approval. The Resolution Center upload stays as the fallback when an action isn't offered. Demo disputes are opened by the buyer in the sandbox Resolution Center.

## Early deploy — done 2026-10-21

- Render Blueprint `settle` from `render.yaml` (validated by the Render API, `valid: true`): web service `srv-dbcdsm1srm7s738g1iog`, free plan, Frankfurt, https://settle-ulya.onrender.com. Secrets set through the Render API from `.env.local`.
- Before deploying, the boilerplate data pages and `/api/ai` were closed in production (`proxy.ts` plus a guard in each route, `SETTLE_DEV_PAGES=1` to override). Live check: `/` 200 with the sandbox notice, `/transactions` and `/dashboard` 404, unsigned webhook POST 400.
- PayPal sandbox webhook `14T357433V893904A` → `/api/paypal/webhook`, 11 events (order approved, capture completed/denied/pending/refunded/reversed, dispute created/updated/resolved, merchant onboarding completed, partner consent revoked).
- **Verified webhook received:** a $1 refund on the seller's capture (made with `PayPal-Auth-Assertion`, debug f59915509156f) produced `PAYMENT.CAPTURE.REFUNDED`, logged as `{"status":200,"outcome":"verified","eventId":"WH-9AJ45519YM173530G-6T229948JJ436592U"}`. So events for a connected seller's payments reach our webhook.
- Free-tier limits (render.com/docs/free): spins down after 15 minutes idle, about 1 minute to wake (PayPal retries webhooks; wake the site before a demo); ephemeral filesystem, so receipts go to Postgres; free Postgres expires 30 days after creation and only one per workspace; 750 instance hours a month.

## D4: meet-up mode, authorize then capture for the connected seller — run 2026-11-05

Question (DECISIONS #20): can our Platform app run Orders v2 with `intent: AUTHORIZE` when the connected seller (`RRBVDNUTQMAXN`) is the payee, then capture or void later? Throwaway script (plain fetch, outside the repo), same accounts as D1. Two orders, USD 10.00, `payee.merchant_id` = seller, `custom_id` = tag + 64 hex. The sandbox buyer approved both in the browser.

| Step | Assertion | Status | Debug ID | Result |
| --- | --- | --- | --- | --- |
| Create A and B, `intent: AUTHORIZE` | none | 200 | f16323157a106, f337127b46c20 | `PAYER_ACTION_REQUIRED`, payee and `custom_id` kept |
| Authorize A and B (`/v2/checkout/orders/{id}/authorize`) | none | **201** | f784679c2e62e, f48573867bafc | order `COMPLETED`; authorization `CREATED`, `expiration_time` 29 days later (2026-12-04), `seller_protection: ELIGIBLE` |
| GET authorization A | seller | 200 | f6370999c7477 | `CREATED` |
| Capture A (`/v2/payments/authorizations/{id}/capture`, `final_capture: true`) | none | **201** | f316499aa1dd7 | capture `3G062671F6794610L` `COMPLETED` |
| Capture A again | seller | 422 | f129303926c8f | `AUTHORIZATION_ALREADY_CAPTURED` (no double capture) |
| GET order A | seller | 200 | f454376f8a31d | authorization `CAPTURED`, capture `COMPLETED` |
| Reauthorize B on day 0 | seller | 422 | f385376f75a99 | `REAUTHORIZATION_TOO_SOON`: "only allowed once from Day 4 to Day 29" |
| Void B | none | **403** | f5033000dd049 | `PERMISSION_DENIED` |
| Void B | seller | **200** | f83420130b6b2 | `VOIDED` |
| Capture B after void | seller | 422 | f262069f6fbeb | `AUTHORIZATION_VOIDED` |

Findings:

- **Meet-up mode works for the connected seller.** No new Partner Referrals feature is needed: the existing grant (PAYMENT, REFUND, …) covers authorize, capture and void.
- **Void needs `PayPal-Auth-Assertion`; capture works with or without it.** Settle sends the assertion on both, as for refunds and tracking.
- **Timing:** the authorization is valid for 29 days. Reauthorizing is allowed **once, from day 4 to day 29**, not inside the first 3 days. So: a meet-by date within 3 days needs no reauthorization; a later one needs one reauthorization on day 4 or later, which may fail if the buyer's funding changed. Plan for that as HOLD, never as "paid".
- `seller_protection: ELIGIBLE` on the authorization does **not** change SP-INPERSON. Settle doesn't show it as protection for a handover.
- **Webhooks:** our webhook `14T357433V893904A` isn't subscribed to `PAYMENT.AUTHORIZATION.CREATED` or `PAYMENT.AUTHORIZATION.VOIDED`. `CHECKOUT.ORDER.APPROVED` for order A appeared in the event log. Before building: add both types to the webhook and confirm a verified event arrives (then the "payment held" rule is the same as today: verified webhook plus a fresh GET of the authorization).

### D4 live check on Render — run 2026-11-05 (after commit 1f99909)

A real meet-up deal end to end on https://settle-ulya.onrender.com, PayPal sandbox, USD 10.00 ("iPad Air", "meet at the Union Square station"; read as Meet up in person). The seller side was driven through the API; the user played the buyer in their browser.

| Step | Result | Debug ID |
| --- | --- | --- |
| Each link claimed by the first device to open it | seller link on the API client, buyer link in the user's browser | — |
| Seller connected through Partner Referrals | `RRBVDNUTQMAXN` | f514771ed5041 |
| Both confirmed; order created from the locked card, `intent: AUTHORIZE` | order `0NX663001G8895145` | ca55ee4920d61 |
| Buyer approved; authorize | hold CREATED | f33798875ad5c |
| Verified `PAYMENT.AUTHORIZATION.CREATED` plus a fresh GET | "PayPal holds $10.00" (the event carries our `custom_id`) | f97913108f57f |
| Seller showed the code; buyer opened it on the paying browser and confirmed | capture `5BA07833XB888404F` COMPLETED | f667901a2475c |
| Verified `PAYMENT.CAPTURE.COMPLETED` plus a fresh GET | paid | f349969ef30ef |
