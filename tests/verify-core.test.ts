import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { GENESIS_HASH, makeReceipt, verifyChain, type Receipt } from '../lib/settle/receipts';
import { demoSigningKey, encodeSeed, liveSigningKey, nodeCrypto, pdfSha256, signRecord, verifyRecord, type SignedRecord } from '../lib/settle/signing';
import { checkPdfWith, chainProblem, GENESIS, parseKeys, verifyRecordWith } from '../lib/settle/verify-core';
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
