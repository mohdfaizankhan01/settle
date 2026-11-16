# Live updates

The deal page used to ask the server for the whole deal every 10 seconds, so when the other side
confirmed, paid or triggered a Hold, a page reacted after up to 10 seconds. Now the server tells
the page the moment a deal changes.

## How it works

1. **A signal when anything is written.** `lib/settle/changes.ts` is a small in-process
   publish/subscribe. Both stores (`lib/settle/store.ts`, `lib/settle/pg-store.ts`) call
   `announce(dealId)` after a committed write to a deal or its receipts. That covers a
   confirmation, a verified payment webhook, new chat messages that trigger a Hold, and a dispute
   event. Writes within 150 ms of each other make one signal.
2. **A stream per page.** `GET /api/deals/[id]/watch` (`lib/settle/watch.ts`) is a server-sent
   events stream with the same link and device check as reading the deal. It never claims a link.
   It sends `data: {"changed":true}` and nothing else, plus a heartbeat every 25 s so proxies keep
   it open. It closes itself after 4 minutes and the page reconnects.
3. **The page reads the deal again.** On each signal `app/d/[id]/use-live.ts` makes the page call
   the normal deal route, so every check (link, device lock, buyer and seller views) stays in one
   place and the stream never carries deal data. `fetch` is used rather than `EventSource`, which
   can't send the link headers.
4. **A slower poll stays.** While the stream is open the page still reads the deal every 30 s;
   that read is also the missed-webhook fallback (it re-reads PayPal at most once a minute). With
   no stream it polls every 10 s, as before. The page says which: "Updates: live" or "Updates:
   checking every 10 seconds".

## Limits

- **Caps:** 8 open streams per deal, 12 per address, 300 in all; 40 new streams per address in
  5 minutes. Over a cap the page simply keeps polling.
- **One server process.** Signals are in memory, which is how Render's free plan runs us. A change
  made by another process, or while a restart reconnects the stream, is caught by the poll, not
  the stream. Postgres `LISTEN/NOTIFY` would carry signals between processes if we ever scale out.
- **PayPal's own timing is unchanged.** Live updates make the page react the moment Settle Link
  learns something; they don't speed up PayPal's notices. A dispute webhook can still take many
  minutes in the sandbox.
- **No email.** An optional email on changes would need an email service and consent handling for
  people's addresses, so it isn't built.

## Tests

`tests/changes.test.ts` (signals, merging, cleanup, both stores), `tests/watch.test.ts` (the
stream, heartbeat, age limit, caps, the route's link checks, no deal data in the stream) and
`e2e/live.spec.ts` (one side acts, the other side's page changes within 5 s; with the stream
blocked, the page says so and still catches up on its 10 s poll).
