@AGENTS.md

# Project rules

- PayPal sandbox only. All PayPal calls run on the server in lib/paypal.ts. Secrets live in .env.local or Render env vars, never in git or logs.
- Never trust the browser for money: create orders on the server from the locked deal card, and check amount, currency and payee (the seller's merchant ID from Partner Referrals, verified with merchant-integrations; D1).
- Payment is confirmed only by a verified webhook (verify-webhook-signature) plus a fresh GET of the order. Never by client callbacks, screenshots or emails.
- Jev only adds caution. It never approves shipping and never sends a dispute response. The seller approves every dispute response.
- Fail closed: any error means HOLD or REVIEW, never "safe". The UI says "no warning signs found", never "safe deal".
- Redact chat text (lib/settle/redact.ts) before it goes to Jev or any LLM. Prices, dates and links are handled in code, not by AI.
- Every decision writes a receipt (lib/settle/receipts.ts).
- npm test must pass before every commit. New logic gets tests with Jev and PayPal mocked. Small commits with clear messages.
- Ask me before adding a dependency or external service, or changing the plan.
- Every feature serves the thread: chat, deal card, PayPal order, ship gate, dispute. One record.
- Deal terms are locked by hash. The PayPal order carries it, and a mismatch blocks payment and shipping.
- Protection checks cite docs/protection-terms.md. Never tell anyone they're protected or will win a dispute: say which checks pass and that PayPal decides.
- Dispute text is templated from records. Jev never writes text. The seller approves the exact request before it's sent.
- Every screen says what's real and what's simulated.
- Judge mode data is per session and never touches real deals.
- Running late: drop COULD, then SHOULD items, and ask me before cutting a MUST.
- AI can only point: candidate IDs code built, message IDs, or exact quotes code verifies. It never writes a value onto the card.
- A term is filled automatically only when code and the AI reader agree. Any disagreement is a question for both people.
- The AI never approves a payment, a shipment, a handover or a dispute response, and never judges a dispute.
- Screenshots are read and discarded. Only the answer and its counts are recorded.
- Approved Nov 10: Groq's API (GROQ_API_KEY), called with plain fetch, for the AI reader (M8) and screenshot check (M9). Ask me before any other dependency or service.
- Plan: docs/PLAN.md (v2, M1 to M6). Decisions: docs/DECISIONS.md.

# Tools

- PayPal APIs: the paypal plugin (best-practices skill, /paypal:sandbox, /paypal:explain-error, /paypal:doctor), not memory. An expired sandbox token is renewed with /paypal:setup refresh.
- APIMatic PayPal SDK skills: only if we switch from plain fetch to PayPal's TypeScript Server SDK. Ask me first.
- Warning check: Settle's own model (lib/model; `npm run model:fetch` once, `npm run model:train`), MiniLM embeddings by default, `SETTLE_MODEL=a` for hashed patterns; Jev (typesafe skill) only with `JEV_PROVIDER=typesafe`. Re-run `npm run eval` after changing training data, a question or a threshold, and never train on data/test-chats.jsonl.
- AG Grid and AG Studio: ag-mcp for docs at our exact version. frontend-design for UI work.
- Next.js: read the docs in node_modules/next/dist/docs before writing Next.js code, as AGENTS.md says.
- Deploys, logs and render.yaml: the render plugin.
- End-to-end checks of the sandbox checkout and demo screenshots: playwright.
- security-guidance runs on its own. Run code-review before each milestone.
