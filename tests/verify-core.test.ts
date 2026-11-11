import assert from 'node:assert/strict';
import { randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { GENESIS_HASH, makeReceipt, verifyChain, type Receipt } from '../lib/settle/receipts';
import { demoSigningKey, encodeSeed, liveSigningKey, nodeCrypto, pdfSha256, signRecord, verifyRecord, type SignedRecord } from '../lib/settle/signing';
import { checkPdfWith, chainProblem, GENESIS, parseKeys, recordMessage, RECORD_FORMAT, verifyRecordWith, type RecordBody } from '../lib/settle/verify-core';
import { webCrypto } from '../lib/settle/web-crypto';

const chain = (): Receipt[] => {
  const a = makeReceipt(undefined, { dealId: 'd1', kind: 'deal.checked', at: '2026-11-11T10:00:00Z', data: { warnings: 1, nested: { b: 2, a: [1, 'x', null] } } });
  const b = makeReceipt(a, { dealId: 'd1', kind: 'card.confirmed', at: '2026-11-11T10:01:00Z', data: { by: 'buyer', cardHash: 'abc', p: 0.5 } });
  const c = makeReceipt(b, { dealId: 'd1', kind: 'order.created', at: '2026-11-11T10:02:00Z', data: { id: 'ünïcode ✓' } });
  return [a, b, c];
};
const key = liveSigningKey({ SETTLE_SIGNING_KEY: encodeSeed(randomBytes(32)) })!;
const good = () => signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: chain(), now: () => new Date('2026-11-11T12:00:00Z') }, key);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const tampered: [string, (r: SignedRecord) => void][] = [
  ['none', () => {}],
  ['card hash', (r) => { r.body.cardHash = 'def'; }],
  ['a receipt', (r) => { r.body.receipts[1].data = { by: 'seller', cardHash: 'abc', p: 0.5 }; }],
  ['a dropped receipt', (r) => { r.body.receipts.splice(1, 1); }],
  ['swapped receipts', (r) => { r.body.receipts.reverse(); }],
  ['the signature', (r) => { r.signature.value = `${r.signature.value.slice(0, -2)}AA`; }],
  ['the key id', (r) => { r.signature.keyId = 'ffffffffffffffff'; }],
  ['the format', (r) => { (r as { format: string }).format = 'other/1'; }],
  ['a non-string signature', (r) => { (r.signature as { value: unknown }).value = 7; }],
];

test('the browser check and the Node check give the same verdict, check by check, on good and tampered records', async () => {
  for (const [name, change] of tampered) {
    const rec = clone(good());
    change(rec);
    const node = await verifyRecordWith(rec, [key.info], nodeCrypto);
    const web = await verifyRecordWith(rec, [key.info], webCrypto);
    assert.deepEqual(web, node, `${name}: WebCrypto and node:crypto agree`);
    assert.equal(node.ok, name === 'none', `${name}: verdict`);
  }
});

test('the demo key and a live key verify through WebCrypto too', async () => {
  const demo = signRecord({ dealId: 'd1', demo: true, cardHash: 'abc', receipts: chain() }, demoSigningKey());
  assert.equal((await verifyRecordWith(demo, [demoSigningKey().info], webCrypto)).ok, true);
  assert.equal((await verifyRecordWith(good(), [key.info], webCrypto)).ok, true);
});

test('the shared chain walk agrees with receipts.verifyChain on every kind of tampering', async () => {
  const cases: Receipt[][] = [chain(), [], chain().slice(1), [chain()[0], chain()[2], chain()[1]], chain().map((r, i) => (i === 1 ? { ...r, data: { by: 'seller' } } : r)), chain().map((r, i) => (i === 2 ? { ...r, dealId: 'd2' } : r)), chain().map((r, i) => (i === 0 ? { ...r, prevHash: 'x'.repeat(64) } : r))];
  for (const [i, receipts] of cases.entries()) {
    const official = verifyChain(receipts);
    for (const c of [nodeCrypto, webCrypto]) {
      const problem = await chainProblem(c, receipts);
      assert.equal(problem === null, official.ok, `case ${i}`);
      if (!official.ok) assert.deepEqual(problem, { at: official.brokenAt, reason: official.reason }, `case ${i}: same place and reason`);
    }
  }
  assert.equal(GENESIS, GENESIS_HASH);
});

test('a PDF is compared with the hash the record carries, and a record without one says so', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 evidence');
  const rec = signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: chain(), pdf: { disputeId: 'PP-D-1', sha256: pdfSha256(pdf) } }, key);
  for (const c of [nodeCrypto, webCrypto]) {
    assert.equal((await checkPdfWith(rec, pdf, c)).status, 'pass');
    const other = await checkPdfWith(rec, new TextEncoder().encode('%PDF-1.4 changed'), c);
    assert.equal(other.status, 'fail');
    assert.match(other.detail, /not the one the record covers/);
    assert.equal((await checkPdfWith(good(), pdf, c)).status, 'fail');
  }
});

test('a signature check that throws is a failed check, and an unsupported browser is said plainly', async () => {
  const broken = { ...nodeCrypto, ed25519Verify: async () => { throw new Error('boom'); } };
  const a = await verifyRecordWith(good(), [key.info], broken);
  assert.equal(a.ok, false);
  const unsupported = { ...nodeCrypto, ed25519Verify: async () => { throw Object.assign(new Error('x'), { name: 'NotSupportedError' }); } };
  const b = await verifyRecordWith(good(), [key.info], unsupported);
  assert.equal(b.ok, false);
  assert.match(b.checks.find((c) => c.id === 'signature')!.detail, /cannot check Ed25519/);
});

test('key lists parse from the published file, an array or one key, and nothing else', () => {
  const info = key.info;
  assert.deepEqual(parseKeys(JSON.stringify({ keys: [info] })), [info]);
  assert.deepEqual(parseKeys(JSON.stringify([info])), [info]);
  assert.deepEqual(parseKeys(JSON.stringify(info)), [info]);
  for (const bad of ['', 'nope', '{}', '[]', '{"keys":[]}', JSON.stringify({ ...info, alg: 'RSA' }), JSON.stringify({ ...info, kind: 'other' }), JSON.stringify({ keys: [info, { alg: 'Ed25519' }] })]) assert.equal(parseKeys(bad), undefined, bad);
});

test('the Node wrapper and the shared core are the same check', async () => {
  const rec = good();
  assert.deepEqual(await verifyRecord(rec, [key.info]), await verifyRecordWith(rec, [key.info], nodeCrypto));
});

test('verdicts: a live record is verified, a demo record is only "demo", a changed record is failed', async () => {
  assert.equal((await verifyRecord(good(), [key.info])).verdict, 'verified');
  const demo = signRecord({ dealId: 'd1', demo: true, cardHash: 'abc', receipts: chain() }, demoSigningKey());
  const out = await verifyRecord(demo, [demoSigningKey().info]);
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'demo');
  const bad = clone(good());
  bad.body.cardHash = 'def';
  assert.equal((await verifyRecord(bad, [key.info])).verdict, 'failed');
});

test('a forged "real" record signed with the public demo key is refused, not shown as verified', async () => {
  const demoKey = demoSigningKey();
  const body: RecordBody = { dealId: 'd1', demo: false, signedAt: '2026-11-11T12:00:00.000Z', cardHash: 'abc', chainHead: chain().at(-1)!.hash, receiptCount: 3, receipts: chain(), pdf: null };
  const forged: SignedRecord = { format: RECORD_FORMAT, body, signature: { alg: 'Ed25519', keyId: demoKey.info.keyId, kind: 'live', value: sign(null, Buffer.from(recordMessage(body)), demoKey.privateKey).toString('base64url') } };
  for (const c of [nodeCrypto, webCrypto]) {
    const out = await verifyRecordWith(forged, [key.info, demoKey.info], c);
    assert.equal(out.checks.find((x) => x.id === 'signature')!.status, 'pass', 'the signature itself is valid: the demo key is public');
    assert.equal(out.checks.find((x) => x.id === 'kind')!.status, 'fail');
    assert.equal(out.ok, false);
    assert.equal(out.verdict, 'failed');
  }
});

test('the key kind comes from the published key, never from the label inside the file', async () => {
  const demoKey = demoSigningKey();
  const rec = clone(signRecord({ dealId: 'd1', demo: true, cardHash: 'abc', receipts: chain() }, demoKey));
  rec.signature.kind = 'live';
  const out = await verifyRecord(rec, [key.info, demoKey.info]);
  assert.equal(out.kind, 'demo');
  assert.equal(out.verdict, 'demo');
});

test('a record signed with the demo key always says it is demo data, even for a non-demo deal in development', async () => {
  const rec = signRecord({ dealId: 'd1', demo: false, cardHash: 'abc', receipts: chain() }, demoSigningKey());
  assert.equal(rec.body.demo, true);
  assert.equal((await verifyRecord(rec, [demoSigningKey().info])).verdict, 'demo');
});

test('a record that says it is demo data but is signed with the live key is refused', async () => {
  const rec = signRecord({ dealId: 'd1', demo: true, cardHash: 'abc', receipts: chain() }, key);
  const out = await verifyRecord(rec, [key.info]);
  assert.equal(out.ok, false);
  assert.equal(out.checks.find((x) => x.id === 'kind')!.status, 'fail');
});
