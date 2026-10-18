# Decisions

Newest last. Each entry: date, decision, why, and what would change it.

| # | Date | Decision | Why | What would change it |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-16 | Start from PayPal's AG Grid hackathon boilerplate as a new repo, not a fork. | Next.js 16, AG Grid and AG Studio and a plain-fetch PayPal client already wired; AG Grid sponsor prize. | — |
| 2 | 2026-10-16 | Plain `fetch` in `lib/paypal.ts`, no PayPal SDK; APIMatic plugin disabled. | Smaller surface, server-only, already in the boilerplate. | A small, contained switch to the TypeScript Server SDK for the APIMatic prize (M6 COULD, ask first). |
| 3 | 2026-10-18 | GitHub repo is named `settle`, private, on the personal account. | User's choice. | Must be public, or shared with judges, before submission if the rules require it. |
| 4 | 2026-10-18 | The story is one record from DM to dispute: chat, deal card, PayPal order, ship gate, dispute. Every feature must strengthen that thread. | Of about 225 public hackathon repos reviewed, each stage alone is already someone's entry (scam checkers, ship gates, Seller Protection checkers, dispute desks); none connects the pre-sale chat to the dispute. | A public entry that already links chat to dispute. |
| 5 | 2026-10-18 | Settle never holds money: no authorize-then-capture, escrow or payouts. PayPal captures, and protection comes from PayPal's own programs. | About 20 entries already build escrow; holding funds adds licensing and risk questions we can't answer in a hackathon. | — |
| 6 | 2026-10-18 | Out of scope: an MCP server, AI shopping agents and voice. | They don't serve the chat-to-dispute thread. | — |
| 7 | 2026-10-18 | Never say "protected", "safe deal" or "you'll win". Say which checks pass, cite `docs/protection-terms.md`, and that PayPal decides. | Only PayPal decides eligibility; overclaiming would mislead users. | — |
| 8 | 2026-10-18 | Dispute text is templated from records; Jev never writes it; the seller approves the exact request. | Evidence must be traceable to records; a model must not invent claims to PayPal. | — |
| 9 | 2026-10-18 | The Jev module (`settle-jev`) was never imported and isn't on disk. **Open:** recover it or rebuild it before M2. | Audit found no `lib/jev`, `lib/settle`, tests or eval data. | The zip turning up. |
| D1 | open (M1) | Whose account gets paid: the seller's own account, or our app's sandbox business account with payee code behind a flag. | Log in with PayPal proves identity, not that our app can track, refund or answer disputes for that account. | Spike evidence in `docs/SPIKES.md`. |
| D2 | open (M1) | A repeatable way to open sandbox disputes, and what the evidence API accepts. | M4 and judge mode need real disputes on demand. | Spike evidence in `docs/SPIKES.md`. |
| D3 | open (M1) | Which Seller and Purchase Protection requirements we check, per country (US, UK). | Checks must cite PayPal's own terms, not memory. | PayPal changing its terms; re-check before submission. |
