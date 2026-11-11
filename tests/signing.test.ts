import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { makeReceipt, type Receipt } from '../lib/settle/receipts';
import {
  demoSigningKey,
  encodeSeed,
  liveSigningKey,
  pdfSha256,
  publishedKeys,
  signingKeyFor,
  signRecord,
  verifyRecord,
  type SignedRecord,
} from '../lib/settle/signing';

const chain = (dealId = 'd1'): Receipt[] => {
  const a = makeReceipt(undefined, { dealId, kind: 'deal.checked', at: '2026-11-11T10:00:00Z', data: { warnings: 1 } });
  const b = makeReceipt(a, { dealId, kind: 'card.confirmed', at: '2026-11-11T10:01:00Z', data: { by: 'buyer', cardHash: 'abc' } });
  const c = makeReceipt(b, { dealId, kind: 'card.confirmed', at: '2026-11-11T10:02:00Z', data: { by: 'seller', cardHash: 'abc' } });
  return [a, b, c];
};
const now = () => new Date('2026-11-11T12:00:00Z');
const seed = () => encodeSeed(randomBytes(32));
const liveKey = (s = seed()) => liveSigningKey({ SETTLE_SIGNING_KEY: s })!;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const signed = (key = liveKey(), extra: Partial<Parameters<typeof signRecord>[0]> = {}) => signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: chain(), now, ...extra }, key);
const status = (r: Awaited<ReturnType<typeof verifyRecord>>, id: string) => r.checks.find((c) => c.id === id)?.status;

test('a signed record verifies against the published key', async () => {
  const key = liveKey();
  const rec = signed(key);
  const out = (await verifyRecord(rec, [key.info]));
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'live');
  for (const id of ['format', 'key', 'signature', 'chain', 'head', 'deal']) assert.equal(status(out, id), 'pass', id);
  assert.equal(rec.body.receiptCount, 3);
  assert.equal(rec.body.chainHead, rec.body.receipts[2].hash);
  assert.equal(rec.body.signedAt, '2026-11-11T12:00:00.000Z');
});

test('the same record survives being written out and read back', async () => {
  const key = liveKey();
  assert.equal((await verifyRecord(JSON.parse(JSON.stringify(signed(key))), [key.info])).ok, true);
  assert.equal((await verifyRecord(JSON.parse(JSON.stringify(signed(key), null, 2)), [key.info])).ok, true);
});

test('changing anything in the signed body fails the signature', async () => {
  const key = liveKey();
  const changes: ((r: SignedRecord) => void)[] = [
    (r) => { r.body.cardHash = 'def'; },
    (r) => { r.body.signedAt = '2026-11-12T12:00:00.000Z'; },
    (r) => { r.body.demo = true; },
    (r) => { r.body.dealId = 'd2'; },
    (r) => { r.body.receipts[1].data = { by: 'seller', cardHash: 'abc' }; },
    (r) => { r.body.pdf = { disputeId: 'PP-D-1', sha256: 'a'.repeat(64) }; },
  ];
  for (const [i, change] of changes.entries()) {
    const rec = clone(signed(key));
    change(rec);
    const out = (await verifyRecord(rec, [key.info]));
    assert.equal(out.ok, false, `change ${i} must fail`);
    assert.equal(status(out, 'signature'), 'fail', `change ${i} must fail the signature`);
  }
});

test('a dropped, reordered or edited receipt is caught by the chain even when re-signed', async () => {
  const key = liveKey();
  const dropped = chain();
  dropped.splice(1, 1);
  const out = (await verifyRecord(signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: dropped, now }, key), [key.info]));
  assert.equal(status(out, 'signature'), 'pass', 'signed by the real key');
  assert.equal(status(out, 'chain'), 'fail');
  assert.equal(out.ok, false);

  const [a, b, c] = chain();
  assert.equal(status((await verifyRecord(signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: [a, c, b], now }, key), [key.info])), 'chain'), 'fail');

  const edited = chain();
  edited[1] = { ...edited[1], data: { by: 'seller' } };
  assert.equal(status((await verifyRecord(signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: edited, now }, key), [key.info])), 'chain'), 'fail');
});

test('a chain head or count that does not match the receipts fails, and so does a receipt from another deal', async () => {
  const key = liveKey();
  const rec = clone(signed(key));
  rec.body.chainHead = 'f'.repeat(64);
  assert.equal(status((await verifyRecord(rec, [key.info])), 'head'), 'fail');
  const mixed = [...chain('d1').slice(0, 1), ...chain('d2').slice(1)];
  assert.equal((await verifyRecord(signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: mixed, now }, key), [key.info])).ok, false);
});

test('a record signed by another key, or a changed signature, does not verify', async () => {
  const key = liveKey();
  const other = liveKey();
  const byOther = signed(other);
  const out = (await verifyRecord(byOther, [key.info]));
  assert.equal(status(out, 'key'), 'fail', 'the other key is not on the list');
  assert.equal(out.ok, false);

  // Claiming our key id on a signature made by someone else's key.
  const forged = clone(byOther);
  forged.signature.keyId = key.info.keyId;
  assert.equal(status((await verifyRecord(forged, [key.info])), 'signature'), 'fail');

  const flipped = clone(signed(key));
  flipped.signature.value = `${flipped.signature.value.slice(0, -2)}AA`;
  assert.equal((await verifyRecord(flipped, [key.info])).ok, false);
});

test('malformed input is a failed check, never a throw', async () => {
  const key = liveKey();
  for (const input of [null, undefined, 42, 'text', [], {}, { format: 'settle-link-record/1' }, { format: 'settle-link-record/1', body: {}, signature: {} }, { format: 'other/9', body: {}, signature: {} }]) {
    const out = (await verifyRecord(input, [key.info]));
    assert.equal(out.ok, false);
  }
  const badSig = clone(signed(key));
  (badSig.signature as { value: unknown }).value = 12;
  await assert.doesNotReject(verifyRecord(badSig, [key.info]));
  assert.equal((await verifyRecord(badSig, [key.info])).ok, false);
  const badReceipts = clone(signed(key));
  badReceipts.body.receipts = [{ nope: 1 } as unknown as Receipt];
  await assert.doesNotReject(verifyRecord(badReceipts, [key.info]));
  assert.equal((await verifyRecord(badReceipts, [key.info])).ok, false);
});

test('key rules: production without a valid key signs nothing; judge mode and development use the public demo key', async () => {
  const s = seed();
  assert.equal(signingKeyFor(false, { NODE_ENV: 'production' }), undefined, 'production, no key: off');
  assert.equal(signingKeyFor(false, { NODE_ENV: 'production', SETTLE_SIGNING_KEY: 'not base64 of 32 bytes' }), undefined, 'production, bad key: off');
  assert.equal(signingKeyFor(false, { NODE_ENV: 'production', SETTLE_SIGNING_KEY: encodeSeed(randomBytes(16)) }), undefined, 'a 16-byte seed is refused');
  assert.equal(signingKeyFor(false, { NODE_ENV: 'production', SETTLE_SIGNING_KEY: s })!.info.kind, 'live');
  assert.equal(signingKeyFor(false, { NODE_ENV: 'development' })!.info.kind, 'demo', 'development without a key: demo key');
  assert.equal(signingKeyFor(true, { NODE_ENV: 'production', SETTLE_SIGNING_KEY: s })!.info.kind, 'demo', 'a judge-mode deal never uses the live key');
  assert.equal(signingKeyFor(true, { NODE_ENV: 'production' })!.info.keyId, demoSigningKey().info.keyId);
});

test('the same seed gives the same key id; different seeds do not', async () => {
  const s = seed();
  assert.equal(liveKey(s).info.keyId, liveKey(s).info.keyId);
  assert.notEqual(liveKey().info.keyId, liveKey().info.keyId);
  assert.match(liveKey().info.keyId, /^[0-9a-f]{16}$/);
  assert.equal(Buffer.from(liveKey().info.publicKey, 'base64url').length, 32);
});

test('published keys: the live key when set, always the demo key; never a private part', async () => {
  const s = seed();
  const withLive = publishedKeys({ SETTLE_SIGNING_KEY: s });
  assert.deepEqual(withLive.map((k) => k.kind), ['live', 'demo']);
  assert.deepEqual(publishedKeys({}).map((k) => k.kind), ['demo']);
  assert.ok(!JSON.stringify(withLive).includes(Buffer.from(s, 'base64').toString('base64url')), 'the seed is not published');
});

test('a judge-mode record verifies and says it is demo data', async () => {
  const rec = signRecord({ dealId: 'd1', demo: true, cardHash: 'abc', receipts: chain(), now }, demoSigningKey());
  const out = (await verifyRecord(rec, publishedKeys({})));
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'demo');
  assert.equal(status(out, 'demo'), 'info');
  assert.match(out.checks.find((c) => c.id === 'demo')!.detail, /anyone can use/);
});

test('a record that covers an evidence PDF names it, and the PDF hash is the SHA-256 of the bytes', async () => {
  const key = liveKey();
  const pdf = new TextEncoder().encode('%PDF-1.4 test');
  const rec = signed(key, { pdf: { disputeId: 'PP-D-1', sha256: pdfSha256(pdf) } });
  assert.equal(rec.body.pdf!.sha256, pdfSha256(pdf));
  assert.equal(pdfSha256(pdf).length, 64);
  assert.notEqual(pdfSha256(pdf), pdfSha256(new TextEncoder().encode('%PDF-1.4 other')));
  const out = (await verifyRecord(rec, [key.info]));
  assert.equal(out.ok, true);
  assert.match(out.checks.find((c) => c.id === 'pdf')!.detail, /PP-D-1/);
  assert.equal((await verifyRecord(signed(key), [key.info])).checks.some((c) => c.id === 'pdf'), false);
});

test('an empty chain signs and verifies with the genesis head', async () => {
  const key = liveKey();
  const rec = signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: [], now }, key);
  assert.equal(rec.body.chainHead, '0'.repeat(64));
  assert.equal((await verifyRecord(rec, [key.info])).ok, true);
});
