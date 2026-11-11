# Signed records and /verify

Settle Link writes a receipt for every decision, each holding the hash of the one before
(`lib/settle/receipts.ts`). A **signed record** is the seller's copy of that chain, signed with
Ed25519, so anyone can check later that it is unchanged since Settle Link signed it, without
trusting our server.

## What is in a record

`settle-link-record-<dealId>.json`, format `settle-link-record/1`:

| Field | Meaning |
| --- | --- |
| `body.dealId`, `body.demo` | The deal, and whether it is a judge-mode (replayed) deal |
| `body.signedAt` | When it was signed |
| `body.cardHash` | SHA-256 of the deal card as it stood |
| `body.receipts`, `body.receiptCount`, `body.chainHead` | The whole receipt chain: decisions, IDs, hashes and probabilities, never chat text |
| `body.pdf` | `{ disputeId, sha256 }` when exported from a dispute: the hash of the evidence PDF |
| `signature` | `{ alg: "Ed25519", keyId, kind, value }` over `settle-link-record/1\n` + the canonical JSON of `body` |

The seller downloads it from the deal's **History** panel, or from the dispute panel next to the
evidence pack (that one also covers the PDF). Only the seller can: the receipts include seller-only
steps. Exporting writes no receipt, so the record and the evidence pack describe the same chain.

## How to check one

- **In a browser:** open [/verify](https://settle-ulya.onrender.com/verify), drop the record (and the
  evidence PDF if it covers one). Nothing is uploaded; WebCrypto does the check.
- **Offline:** `npm run verify:record -- record.json [--pdf evidence.pdf] [--keys keys.json]`. It
  needs no network. Exit code 0: checks out; 3: a judge-mode demo record whose format and chain check
  out (signed with the public demo key, so it shows nothing about a real deal); 1: does not check
  out; 2: unreadable file or usage.

Both run the same code, `lib/settle/verify-core.ts`, with different crypto underneath (WebCrypto
in the browser, `node:crypto` in Node). `tests/verify-core.test.ts` checks that they give the same
verdict, check by check, on good and tampered records.

It checks: the format; that the signing key is on the key list; the signature over the exact
record; every receipt's hash and link to the one before; that the chain head and count match; that
every receipt belongs to the deal; and, if you give it the PDF, that the PDF's SHA-256 is the one
the record names.

## Keys

- `SETTLE_SIGNING_KEY` is the base64 of a 32-byte Ed25519 seed. `npm run verify:keygen` makes one:
  it writes the secret to `.env.local` and never prints it, and writes the public key to
  `docs/signing-public-key.json`, which is committed.
- The public keys are served at `/.well-known/settle-link-key.json`. That list comes from the
  server being checked, so to avoid trusting it, compare the key ID with the committed
  `docs/signing-public-key.json`, or pass your own list (`--keys`, or the box on /verify).
- **Judge mode** deals, and local development without a key, are signed with a fixed **public demo
  key** (its seed is derived from a published string). Anyone can sign with it, so a demo record
  only shows the file format: the page never gives it the green "checks out" headline (it says
  "Demo record"), and the script exits 3 for it, not 0. A record signed with the demo key must say
  `demo: true`; one that claims to be a real deal under that key fails the check, so a forged
  "real" record can't pass as verified. The key kind shown comes from the published key, not from
  the unsigned label inside the file.
- Production without a valid `SETTLE_SIGNING_KEY` signs nothing: the download answers "signing is
  off on this server". It never falls back to the demo key for a real deal.

## What a passing check shows, and what it doesn't

- It shows the file was signed with the key whose ID is shown, and no receipt was changed,
  reordered or removed from the middle since.
- It does **not** show the events happened. PayPal decides what happened with a payment or a
  dispute; receipts are Settle Link's own notes of what it did and saw.
- Whoever holds the signing key could sign false data, and steps cut from the very end of a chain
  cannot be seen. With no outside anchor (for example a published chain head), this is "unchanged
  since Settle Link signed it", not "Settle Link could not have lied".
- Rotating the key makes earlier records fail against the new list unless the old public key stays
  on it. `verify:keygen` refuses to replace a key that is already set.
