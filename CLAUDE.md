@AGENTS.md

# Project rules

- PayPal sandbox only. All PayPal calls run on the server in lib/paypal.ts. Secrets live in .env.local or Render env vars, never in git or logs.
- Never trust the browser for money: create orders on the server from the locked deal card, and check amount, currency and payee (the seller's merchant ID from Log in with PayPal).
- Payment is confirmed only by a verified webhook (verify-webhook-signature) plus a fresh GET of the order. Never by client callbacks, screenshots or emails.
- Jev only adds caution. It never approves shipping and never sends a dispute response. The seller approves every dispute response.
- Fail closed: any error means HOLD or REVIEW, never "safe". The UI says "no warning signs found", never "safe deal".
- Redact chat text (lib/settle/redact.ts) before it goes to Jev or any LLM. Prices, dates and links are handled in code, not by AI.
- Every decision writes a receipt (lib/settle/receipts.ts).
- npm test must pass before every commit. New logic gets tests with Jev and PayPal mocked. Small commits with clear messages.
- Ask me before adding a dependency or external service, or changing the plan.

# Tools

- PayPal APIs: the paypal plugin (best-practices skill, /paypal:sandbox, /paypal:explain-error, /paypal:doctor), not memory. An expired sandbox token is renewed with /paypal:setup refresh.
- APIMatic PayPal SDK skills: only if we switch from plain fetch to PayPal's TypeScript Server SDK. Ask me first.
- Jev: the typesafe skill for question design. Re-run npm run jev:eval after changing any question or threshold.
- AG Grid and AG Studio: ag-mcp for docs at our exact version. frontend-design for UI work.
- Next.js: read the docs in node_modules/next/dist/docs before writing Next.js code, as AGENTS.md says.
- Deploys, logs and render.yaml: the render plugin.
- End-to-end checks of the sandbox checkout and demo screenshots: playwright.
- security-guidance runs on its own. Run code-review before each milestone.
