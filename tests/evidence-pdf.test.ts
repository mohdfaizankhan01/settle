import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { customIdFor } from '../lib/settle/checkout';
import { addMessages } from '../lib/settle/deals';
import { evidencePdf } from '../lib/settle/evidence-pdf';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { setLabelPostcode } from '../lib/settle/shipping';
import { fakeDispute } from './helpers/dispute';
import { paidSetup } from './helpers/paid-deal';

// The PDF is built from the record only; the same record gives the same bytes.

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

/** The page content streams, inflated, upper-cased: text is drawn as hex strings in them. */
function contentOf(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf);
  let out = '';
  for (let i = buf.indexOf('stream'); i !== -1; i = buf.indexOf('stream', i + 6)) {
    const start = i + (buf[i + 6] === 0x0d ? 8 : 7);
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    try {
      out += inflateSync(buf.subarray(start, end)).toString('latin1');
    } catch {
      out += buf.subarray(start, end).toString('latin1');
    }
    i = end;
  }
  return out.toUpperCase();
}

async function setup() {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  // A message the standard PDF fonts can't encode must not break the pack.
  await addMessages(t.dealId, t.keys.buyer, 'Sam: thanks 🚲 ありがとう', t.deps);
  const d = fakeDispute(customIdFor(await t.get()));
  await applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal });
  return t;
}

test('the evidence pack builds, is deterministic, and says where each part came from', async () => {
  const t = await setup();
  const deal = await t.get();
  const receipts = await t.store.listReceipts(t.dealId);
  const a = await evidencePdf(deal, deal.disputes![0], receipts);
  const b = await evidencePdf(deal, deal.disputes![0], receipts);
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));

  const doc = await PDFDocument.load(a);
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(doc.getTitle(), 'Settle Link evidence pack, dispute PP-D-1');
  const raw = contentOf(a);
  for (const s of ['Source: PayPal API', 'Source: Settle record', 'The receipt chain verifies', 'PayPal does.', 'Missing: Proof of delivery']) {
    assert.ok(raw.includes(hex(s)), s);
  }
  // Names are redacted in the chat section: "Sam" never appears as text.
  assert.ok(!raw.includes(hex('Sam:')));
});

test('a tampered receipt chain is reported in the pack, not hidden', async () => {
  const t = await setup();
  const deal = await t.get();
  const receipts = await t.store.listReceipts(t.dealId);
  receipts[1] = { ...receipts[1], kind: 'edited' };
  const pdf = await evidencePdf(deal, deal.disputes![0], receipts);
  assert.ok(contentOf(pdf).includes(hex('does NOT verify')));
});
