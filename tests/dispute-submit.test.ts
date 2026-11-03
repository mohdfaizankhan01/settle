import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaypalClient } from 'paypal';
import { PayPalApiError, type DisputeFile } from '../lib/paypal';
import { customIdFor } from '../lib/settle/checkout';
import { previewSubmission, submitApproved, type SubmitPayPal } from '../lib/settle/dispute-submit';
import { applyVerifiedEvent } from '../lib/settle/payment';
import { addTracking, markDelivered, setLabelPostcode } from '../lib/settle/shipping';
import { fakeDispute } from './helpers/dispute';
import { paidSetup } from './helpers/paid-deal';

// PayPal is mocked. Nothing is sent without the seller approving that exact request's hash.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';
const sdkOk = () =>
  new PaypalClient({
    oauth2: { clientId: 'id', clientSecret: 's' },
    retry: { maxRetries: 0 },
    logging: { level: 'off' },
    fetch: async (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/oauth2/token' ? Response.json({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }) : Response.json({ id: 'ORDER-1', status: 'COMPLETED' }),
  });

async function setup(over = {}) {
  const t = await paidSetup();
  await applyVerifiedEvent(t.event('WH-1'), t.pdeps);
  await setLabelPostcode(t.dealId, t.keys.seller, 'LS1 1AA', t.pdeps);
  t.order.purchase_units![0].shipping!.trackers = [{ id: 'CAP-1-AB123456789GB' }];
  await addTracking(t.dealId, t.keys.seller, { carrier: 'ROYAL_MAIL', number: 'AB123456789GB' }, { ...t.pdeps, sdk: sdkOk() });
  await markDelivered(t.dealId, t.keys.seller, '2026-11-04', t.pdeps);
  const d = fakeDispute(customIdFor(await t.get()), over);
  await applyVerifiedEvent(d.event('WH-D1'), { ...t.pdeps, disputes: d.paypal });
  const sent: { path: string; json: unknown; files: DisputeFile[]; seller: string }[] = [];
  let answer: () => Promise<{ data: unknown; debugId?: string }> = async () => ({ data: {}, debugId: 'dbg-submit' });
  const pp: SubmitPayPal = {
    getDispute: d.paypal.getDispute,
    async sendDisputeAction(path, json, files, seller) {
      sent.push({ path, json, files, seller });
      return answer();
    },
  };
  return { t, d, sent, deps: { store: t.store, paypal: pp, now: t.pdeps.now }, setAnswer: (f: typeof answer) => void (answer = f) };
}

test('preview shows the exact request; approving its hash sends exactly that, once, as the seller', async () => {
  const { t, sent, deps } = await setup();
  const { request, recommended } = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, deps);
  assert.equal(recommended, true);
  assert.equal(request.url, 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence');
  const ev = (request.json.evidences as { evidence_type: string; evidence_info: { tracking_info: unknown[] }; notes: string }[])[0];
  assert.equal(ev.evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.deepEqual(ev.evidence_info.tracking_info, [{ carrier_name: 'ROYAL_MAIL', tracking_number: 'AB123456789GB' }]);
  assert.match(ev.notes, /tracking AB123456789GB/);
  assert.match(ev.notes, /delivered on 2026-11-04/);
  assert.equal(request.files.length, 1);
  assert.match(request.files[0].name, /\.pdf$/);

  const out = await submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, request.hash, deps);
  assert.equal(out.state, 'sent');
  assert.equal(out.debugId, 'dbg-submit');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/v1/customer/disputes/PP-D-1/provide-evidence');
  assert.equal(sent[0].seller, 'SELLER1');
  assert.deepEqual(sent[0].json, request.json);
  assert.equal(sent[0].files[0].bytes.length, request.files[0].size);
  const r = (await t.store.listReceipts(t.dealId)).findLast((x) => x.kind === 'dispute.submitted')!;
  assert.equal(r.data.requestHash, request.hash);
  assert.equal(r.data.debugId, 'dbg-submit');

  // Approving the same hash again never sends twice (the record now differs, or it was already sent).
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, request.hash, deps), /already sent|review it again/);
  assert.equal(sent.length, 1);
});

test('a request that changed since approval is refused and nothing is sent', async () => {
  const { t, d, sent, deps } = await setup();
  const { request } = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, deps);
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, 'f'.repeat(64), deps), /review it again/);
  // The dispute moves on: the approved action is gone.
  d.dispute.links = [{ href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/accept-claim', rel: 'accept_claim', method: 'POST' }];
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, request.hash, deps), /does not offer/);
  assert.equal(sent.length, 0);
});

test('only the seller can preview or send', async () => {
  const { t, sent, deps } = await setup();
  await assert.rejects(previewSubmission(t.dealId, t.keys.buyer, 'PP-D-1', { advice: 'refund' }, deps), /only the seller/);
  await assert.rejects(submitApproved(t.dealId, t.keys.buyer, 'PP-D-1', { advice: 'refund' }, 'x', deps), /only the seller/);
  assert.equal(sent.length, 0);
});

test('refund and partial offer are templated, and an offer must be below the disputed amount', async () => {
  const { t, sent, deps } = await setup();
  const refund = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, deps);
  assert.equal(refund.request.rel, 'accept_claim');
  assert.deepEqual(refund.request.json, { note: 'The seller accepts the claim and refunds the buyer in full.' });
  assert.deepEqual(refund.request.files, []);
  await assert.rejects(previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'offer', offerAmount: '350' }, deps), /less than the disputed amount/);
  const offer = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'offer', offerAmount: '40' }, deps);
  assert.deepEqual(offer.request.json.offer_amount, { currency_code: 'GBP', value: '40.00' });
  assert.equal(offer.request.json.offer_type, 'REFUND');
  assert.equal(sent.length, 0);
});

test('PayPal refusing the upload records it with the reason; the notes-only fallback is a new request to approve', async () => {
  const { t, sent, deps, setAnswer } = await setup({
    status: 'UNDER_REVIEW',
    dispute_life_cycle_stage: 'CHARGEBACK',
    links: [{ href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-supporting-info', rel: 'provide_supporting_info', method: 'POST' }],
  });
  const withPdf = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, deps);
  setAnswer(async () => {
    throw new PayPalApiError(422, '/v1/customer/disputes/PP-D-1/provide-supporting-info', '{"name":"UNPROCESSABLE_ENTITY","message":"file not accepted"}', 'dbg-422');
  });
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight' }, withPdf.request.hash, deps), /refused it.*dbg-422/);
  const notesOnly = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight', withFiles: false }, deps);
  assert.notEqual(notesOnly.request.hash, withPdf.request.hash);
  assert.deepEqual(notesOnly.request.files, []);
  setAnswer(async () => ({ data: {}, debugId: 'dbg-ok' }));
  const out = await submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'fight', withFiles: false }, notesOnly.request.hash, deps);
  assert.equal(out.state, 'sent');
  assert.equal(sent.length, 2);
});

test('a 5xx or a dropped connection is unknown, never "failed"', async () => {
  const { t, deps, setAnswer } = await setup();
  const { request } = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, deps);
  setAnswer(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, request.hash, deps), /didn't confirm/);
  assert.equal((await t.get()).submissions![0].state, 'unknown');
});

test('the same notes-only request is never sent twice', async () => {
  const { t, sent, deps } = await setup();
  const { request } = await previewSubmission(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, deps);
  await submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, request.hash, deps);
  await assert.rejects(submitApproved(t.dealId, t.keys.seller, 'PP-D-1', { advice: 'refund' }, request.hash, deps), /already sent/);
  assert.equal(sent.length, 1);
});
