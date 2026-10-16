# Claude Code setup prompt for Settle

## Install before pasting the prompt

| Plugin | Why | Install |
| --- | --- | --- |
| PayPal (must) | PayPal's own best practices, error explainer, sandbox setup, sandbox MCP for orders, disputes and tracking | `/plugin install paypal@claude-plugins-official`, then `/paypal:setup` |
| TypeSafe (must) | Official skill for designing Jev questions | `/plugin marketplace add typesafe-ai/skills`, then `/plugin install typesafe@typesafe-ai` |
| AG Grid MCP (must) | Searches AG Grid docs for your exact version | `claude mcp add ag-mcp npx ag-mcp` |
| Render (must) | Deploys, logs, env vars, render.yaml check | `/plugin install render@claude-plugins-official` |
| security-guidance (must) | Flags risky edits, reviews diffs and commits | `/plugin install security-guidance@claude-plugins-official` |
| frontend-design (nice) | More polished UI | `/plugin install frontend-design@claude-plugins-official` |
| playwright (nice) | Clicks through sandbox checkout, screenshots for the demo | `/plugin install playwright@claude-plugins-official` |
| APIMatic Context Plugin (optional, sponsor) | PayPal SDK context, only if you switch to PayPal's TypeScript SDK | `npx context-plugins install paypal` |
| code-review (nice) | Review before submission | `/plugin install code-review@claude-plugins-official` |

The PayPal plugin needs `PAYPAL_SANDBOX_ACCESS_TOKEN` in `~/.claude/settings.json`. Tokens expire about every 9 hours; run `/paypal:setup refresh`.

## Prompt

```
You're helping me build Settle for the PayPal AI Hackathon (Devpost, deadline Nov 12, 2026, 12:00 PST). Today, do only Phase 0 (setup). Show me your plan first and wait for my OK before changing anything.

## What Settle is
People buy and sell with strangers in Instagram, Facebook Marketplace and WhatsApp chats, where scams happen. A buyer or seller pastes the chat into Settle. Settle:
1. Checks the chat for scam signs (Jev decision model plus code rules) and turns it into a deal card both sides confirm.
2. Takes payment through PayPal (sandbox) on a deal page.
3. Says "safe to ship" only after PayPal confirms the money (verified webhook plus a fresh order lookup).
4. Helps the seller answer PayPal disputes with evidence, which the seller approves before anything is sent.
Users: US and UK social sellers and buyers. Sponsor prize target: AG Grid (AG Studio dashboard).

## Starting point
- Base app: PayPal's AG Grid hackathon boilerplate, https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate (Next.js 16, React 19, AG Grid 36, AG Studio 3, plain-fetch PayPal client in lib/paypal.ts).
- Jev module I already have in ../settle-jev (unzipped from settle-jev.zip): src/jev (client, questions), src/settle (dealCheck, shipGate, disputePlan, redaction, link checker, rules, policy, receipts), 18 tests, scripts/smoke.ts, scripts/eval.ts, data/test-chats.jsonl. Read its README.md first.

## Phase 0 tasks
1. Create ./settle from the boilerplate as a new repo, not a fork: clone, remove .git, git init, first commit "chore: start from PayPal AG Grid boilerplate". Credit the boilerplate in the README.
2. Use Node 22 (the Jev SDK needs it): add .nvmrc and "engines". Run npm install and npm run dev, and confirm the boilerplate pages load with my sandbox keys from .env.local.
3. Move the Jev module in: src/jev to lib/jev, src/settle to lib/settle, src/types.ts to lib/types.ts, src/eval to lib/eval, test/ to tests/, plus scripts/ and data/. Fix import paths. Add @typesafe-ai/sdk and tsx. Add scripts: "test" (tsx --test tests/*.test.ts), "jev:smoke" and "jev:eval" (both with --env-file=.env.local). npm test must pass all 18 tests and npm run build must still work.
4. Update env.example with names only, no values: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID, JEV_PROVIDER, TYPESAFE_API_KEY, AI_GATEWAY_API_KEY, JEV_MODEL, SETTLE_PUBLIC_HOST, DATABASE_URL, AG_STUDIO, AG_STUDIO_OPENAI_API_KEY. Confirm .env.local is git-ignored.
5. If TYPESAFE_API_KEY is set, run npm run jev:smoke and show me the latency, tokens and cost.
6. Add the project rules below to CLAUDE.md, keeping the existing @AGENTS.md line at the top.
7. Write docs/PLAN.md with Phases 1 to 7 below, each with "done when" checks.
8. Add an MIT LICENSE and a README skeleton: problem, solution, how it works, setup and run steps for judges, tools used (PayPal APIs, Jev, AG Grid and AG Studio, Render).
9. Commit, then stop. Report what works, what's blocked (missing keys or settings), and anything in the plan you'd change.

## Project rules (copy into CLAUDE.md)
- PayPal sandbox only. All PayPal calls run on the server in lib/paypal.ts. Secrets live in .env.local or Render env vars, never in git or logs.
- Never trust the browser for money: create orders on the server from the locked deal card, and check amount, currency and payee (the seller's merchant ID from Log in with PayPal).
- Payment is confirmed only by a verified webhook (verify-webhook-signature) plus a fresh GET of the order. Never by client callbacks, screenshots or emails.
- Jev only adds caution. It never approves shipping and never sends a dispute response. The seller approves every dispute response.
- Fail closed: any error means HOLD or REVIEW, never "safe". The UI says "no warning signs found", never "safe deal".
- Redact chat text (lib/settle/redact.ts) before it goes to Jev or any LLM. Prices, dates and links are handled in code, not by AI.
- Every decision writes a receipt (lib/settle/receipts.ts).
- Use the PayPal plugin (best-practices skill, /paypal:sandbox) for PayPal API details and the TypeSafe skill for Jev, not memory. Re-run npm run jev:eval after changing any Jev question or threshold. Read the Next.js docs before Next.js code, as AGENTS.md says.
- npm test must pass before every commit. New logic gets tests with Jev and PayPal mocked. Small commits with clear messages.
- Ask me before adding a dependency or external service, or changing the plan.

## Roadmap (context only, don't start these)
1. Deal check page: paste a chat, run dealCheck, show warnings split into "for the buyer" and "for the seller", and build the deal card (item, price, delivery) that both sides confirm by link.
2. Checkout: deal page with PayPal JS SDK v6 buttons, order created and captured on the server, Log in with PayPal for sellers.
3. Ship gate: webhook route with signature check, order re-fetch, shipGate, receipts in Postgres, a "Safe to ship / Hold / Review" screen, and tracking added to the PayPal order.
4. Disputes: create a test dispute in the sandbox, run disputePlan on the dispute webhook, seller approves, submit evidence through the Disputes API.
5. AG Studio dashboard: deals, warnings and receipts, with custom widgets and theme, plus an agent that answers "which deals are on hold and why?".
6. Deploy on Render with render.yaml, register the webhook URL in the sandbox app, seed demo data. Check Render's free-tier limits (cold starts, database lifetime) and tell me what could break during judging.
7. Submission: public repo with license, judge setup steps, demo video under 3 minutes, Devpost text.
```
