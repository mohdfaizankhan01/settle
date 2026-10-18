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

## D1: whose account gets paid — blocked

Needs: our sandbox REST app's client ID and secret in `.env.local`, a **second sandbox business account** (the seller: its email or merchant ID), and a **sandbox personal account** (the buyer) to approve orders.

## D2: disputes in the sandbox — blocked

Needs the same accounts as D1, with the app's *Customer disputes* feature ticked.

## Early deploy — blocked

Needs a Render login (the render plugin's MCP or `RENDER_API_KEY`) and permission to install the packages the webhook route's tests need.
