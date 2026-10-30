# PayPal seller fees Settle shows

Source for the deal card's fee term (problem statement, build change 4). Code computes the fee from this table; no model touches a number. Retrieved **2026-10-30** with `curl` from PayPal's own pages. Re-check on Nov 9 together with `protection-terms.md`.

| Key | Page | Updated |
| --- | --- | --- |
| US-FEES | [US merchant fees](https://www.paypal.com/us/business/paypal-business-fees) | "Last Updated: October 1, 2026" |
| UK-FEES | [UK merchant fees](https://www.paypal.com/uk/business/paypal-business-fees) | "Last Updated: 1, October 2026" |

| ID | Country | Rate Settle uses | Row on PayPal's page |
| --- | --- | --- | --- |
| FEE-US | US, USD | 3.49% + 0.49 USD | "Standard rate for receiving domestic transactions": "PayPal Checkout" 3.49% + fixed fee; fixed fee for "US dollar" 0.49 USD |
| FEE-UK | UK, GBP | 2.9% + 0.30 GBP | "Standard rate for receiving domestic transactions": "All Other Commercial Transactions" 2.9% + fixed fee; fixed fee for "UK pounds sterling" 0.30 GBP |

What this leaves out, so the card calls the fee an **estimate** and PayPal's own figure wins:

- International payments add a percentage (US-FEES and UK-FEES, "Additional percentage-based fee for international commercial transactions"). Settle deals are domestic: the seller's country sets the currency.
- In the UK, a guest card payment ("Card funded payment from a user of our Terms for Payments without a PayPal account") has a lower rate (1.2% + fixed fee). Settle can't know how the buyer will fund the payment before they pay.
- Optional plans such as the UK tiered rate plan.

After capture, PayPal's capture response gives the actual fee (`seller_receivable_breakdown.paypal_fee`). M3 shows that figure next to the estimate.

## Who pays the fee

Both sides answer "Who pays PayPal's fee?" before confirming, and the answer is part of the locked card.

- **Seller pays:** the buyer pays the agreed price; the seller receives about price − fee.
- **Buyer pays:** the order total is grossed up so the seller still receives about the agreed price: `total = ceil_to_cent((price + fixed) / (1 − rate))`, and the fee line is `total − price`.
