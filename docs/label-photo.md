# Label photo

On the ship check, the seller types the postcode from the shipping label and code compares it with
the address on the PayPal payment. A seller can now read that postcode from a photo of the label
instead. The photo only fills the box: the seller checks it and presses Compare, so the typed path
is still the only thing the ship gate uses.

## How it works

1. The seller picks a photo. The browser shrinks it to at most 1600 px and re-encodes it as JPEG
   (`app/d/[id]/shrink-photo.ts`), which keeps the upload small and drops location and camera data.
2. `POST /api/deals/[id]/label/photo` is seller-only and only after the buyer has paid. The type
   is checked from the file's first bytes (JPEG, PNG or WebP), at most 3 MB.
3. A vision model on Groq (`qwen/qwen3.8-27b`, set by `SETTLE_LABEL_MODEL`) is asked for the
   recipient's address block as printed and the postcode in it, and the sender's postcode if one
   is printed. Text on the label is data, never instructions (`lib/label/read-label.ts`).
4. Code checks what the model pointed at: the postcode must be in the recipient block it quoted,
   in the country's format, and not the sender's. Anything else is "couldn't read it".
5. The page shows "The photo says 95131. Check it against your label, then press Compare." The
   seller can edit it. Nothing is compared until the seller presses Compare.

The photo is never stored or logged. The deal record gets a `shipping.label_photo` receipt with
only the result (read, unreadable or skipped), the model and a reason: never the image, the
postcode or the address. The buyer doesn't see these steps.

Judge mode never calls the model: an uploaded photo is not sent anywhere, and **Try the sample
label** replays a real reading of `public/sample-label.png` recorded by `npm run label:eval`
(`data/demo/label-recorded.json`).

## Limits and caps

- A label photo is a call to the same metered provider as the AI reader, so it counts against the
  same caps (per address per hour, and in total per minute and per day), counted only when a call
  goes out. Each deal can ask for 6 reads an hour.
- Groq's free tier allows this model 8,000 tokens a minute and 200,000 a day. A photo is about
  2,000 tokens, so roughly 4 reads a minute and 90 a day. Past that, the page says the reader is
  busy and the seller types the postcode.
- The photo is not redacted: it shows the recipient's name and address, and it goes to Groq to be
  read. The page and `/privacy` say so, and suggest cropping to the postcode.
- `SETTLE_LABEL_PHOTO=off` turns photo reading off.

## Measured

`npm run label:eval` renders 28 synthetic labels (`lib/label/samples.ts`: US and UK, sender and
recipient blocks, ZIP+4, a postcode without its space, tilted and faint print, text aimed at the
AI, and two with no recipient postcode), sends each once and scores the reply after code's checks.
Results are in `data/eval/label.json` and on `/proof`:

- **Prompt `label-2`:** 17 right, 0 wrong, 3 refused of 20 measured. 8 were not run because
  Groq's free daily token limit was used up; they are listed and not counted. Rerunning the script
  later fills them in from the cache.
- **Prompt `label-1` (the first run, reported too):** 18 right, 0 wrong, 10 refused of 28. The
  refusals were the model renaming or dropping the address field, so `label-2` states the JSON
  shape and code reads the common field names.

These are clean rendered labels, not phone photos of real parcels: a sanity check of the reader
and of code's checks, not a benchmark.
