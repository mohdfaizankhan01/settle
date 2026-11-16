import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VisionSkip, type AskVision } from '../lib/label/provider';
import { readLabelPhoto } from '../lib/label/photo';
import { MAX_IMAGE_BYTES } from '../lib/label/read-label';
import { createDeal, DealError, openLinks, withDevice } from '../lib/settle/deals';
import { describe, history } from '../lib/settle/history';
import { getStore, READER_LIMITS } from '../lib/settle/runtime';
import { askWith, paidSetup } from './helpers/paid-deal';
import { PER_DEAL_HOUR } from '../app/api/deals/[id]/label/photo/route';

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 251)]);
const uk = { recipientLines: ['SAM BUYER', '1 HIGH ST', 'LEEDS', 'LS1 1AA'], postcode: 'LS1 1AA', senderPostcode: 'SW1A 1AA' };
const ask = (content: unknown): AskVision => async (_r, model) => ({ model, content: JSON.stringify(content), usage: { input: 1800, output: 20 } });
const rejects = async (p: Promise<unknown>, status: number) => {
  await assert.rejects(p, (e) => e instanceof DealError && e.status === status);
};

test('the seller reads a label photo: the page gets the postcode only, and the receipt holds no photo, postcode or address', async () => {
  const s = await paidSetup();
  const out = await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: ask(uk), model: 'qwen/test' });
  assert.deepEqual(out, { status: 'read', postcode: 'LS1 1AA' });
  const receipts = await s.store.listReceipts(s.dealId);
  const r = receipts.at(-1)!;
  assert.equal(r.kind, 'shipping.label_photo');
  assert.deepEqual(r.data, { result: 'read', model: 'qwen/test', reason: null });
  const everything = JSON.stringify([await s.get(), receipts]);
  assert.ok(!everything.includes(Buffer.from(JPEG).toString('base64')), 'the photo is not stored');
  assert.ok(!/LS1 1AA|HIGH ST|SAM BUYER|SW1A/.test(everything.replace(/"postal_code":"LS1 1AA"/g, '').replace(/1 High St/gi, '').replace(/Sam Buyer/g, '')), 'no address from the photo is stored');
  assert.equal((await s.get()).shipping?.labelPostcode, undefined, 'a photo never sets the label postcode: the seller confirms it by typing it');
});

test('a photo that cannot be read, and a provider that is skipped, are answers with a reason and a receipt', async () => {
  const s = await paidSetup();
  const bad = await readLabelPhoto(s.dealId, s.keys.seller, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), { store: s.store, ask: ask(uk) });
  assert.deepEqual(bad, { status: 'unreadable', reason: 'that file is not a JPEG, PNG or WebP photo' });
  const skipped = await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: async () => { throw new VisionSkip('no AI reader key is set'); } });
  assert.deepEqual(skipped, { status: 'skipped', reason: 'no AI reader key is set' });
  const invented = await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: ask({ ...uk, postcode: 'M1 1AE' }) });
  assert.equal(invented.status, 'unreadable', 'a postcode that is not in the recipient block is refused');
  const kinds = (await s.store.listReceipts(s.dealId)).filter((r) => r.kind === 'shipping.label_photo').map((r) => (r.data as { result: string }).result);
  assert.deepEqual(kinds, ['unreadable', 'skipped', 'unreadable']);
  for (const r of [bad, skipped, invented]) assert.deepEqual(Object.keys(r).sort(), ['reason', 'status'], 'never the address block');
});

test('only the seller, and only once the buyer has paid', async () => {
  const s = await paidSetup();
  await rejects(readLabelPhoto(s.dealId, s.keys.buyer, JPEG, { store: s.store, ask: ask(uk) }), 403);
  await rejects(readLabelPhoto(s.dealId, null, JPEG, { store: s.store, ask: ask(uk) }), 403);
  await rejects(readLabelPhoto('nope', s.keys.seller, JPEG, { store: s.store, ask: ask(uk) }), 404);
  let called = 0;
  const counting: AskVision = async (r, m) => (called++, ask(uk)(r, m));
  const stored = (await s.store.getDeal(s.dealId))!;
  await s.store.updateDeal(s.dealId, stored.version, { ...stored.value, order: undefined });
  await rejects(readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: counting }), 409);
  assert.equal(called, 0, 'nothing is sent to the provider for a request that is refused');
});

test('judge mode never calls the provider', async () => {
  const s = await paidSetup();
  const stored = (await s.store.getDeal(s.dealId))!;
  await s.store.updateDeal(s.dealId, stored.version, { ...stored.value, demo: { session: 's1' } as never });
  let called = 0;
  const out = await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: async (r, m) => (called++, ask(uk)(r, m)) });
  assert.equal(out.status, 'skipped');
  assert.match((out as { reason: string }).reason, /Judge mode does not read photos/);
  assert.equal(called, 0);
});

test('the history says it in words, to the seller only, and without the photo or the postcode', async () => {
  const s = await paidSetup();
  await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: ask(uk) });
  await readLabelPhoto(s.dealId, s.keys.seller, JPEG, { store: s.store, ask: ask({ ...uk, postcode: null }) });
  const receipts = await s.store.listReceipts(s.dealId);
  const sentences = receipts.filter((r) => r.kind === 'shipping.label_photo').map((r) => describe(r, 'seller'));
  assert.match(sentences[0], /label photo was read.*not kept/);
  assert.match(sentences[1], /could not be used \(no recipient postcode was found on the label\)/);
  assert.ok(sentences.every((t) => t !== 'shipping.label_photo' && !/LS1 1AA/.test(t)));
  assert.ok(!history(receipts, 'buyer').items.some((i) => /label photo/i.test(i.text)), 'the buyer does not see the seller\'s label steps');
  assert.ok(history(receipts, 'seller').items.some((i) => /label photo/i.test(i.text)));
});

// The route, with the real provider and no key: a skipped answer, which is what a deploy without a key does.
async function liveSeller() {
  const store = getStore();
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, { store, ask: askWith() });
  const opened = await openLinks(deal.id, keys, { store });
  const stored = (await store.getDeal(deal.id))!;
  await store.updateDeal(deal.id, stored.version, { ...stored.value, order: { id: 'O1', cardHash: 'x', createdAt: '2026-11-16T10:00:00Z', status: 'COMPLETED' } });
  return { id: deal.id, keys: opened, raw: keys, store };
}
const post = async (id: string, key: string | null, body: Uint8Array = JPEG) => {
  const { POST } = await import('../app/api/deals/[id]/label/photo/route');
  const headers: Record<string, string> = { 'content-type': 'image/jpeg' };
  if (key) {
    const [k, device] = key.split('\n');
    headers['x-settle-key'] = k;
    if (device) headers['x-settle-device'] = device;
  }
  return POST(new Request(`http://x/api/deals/${id}/label/photo`, { method: 'POST', headers, body: body as BodyInit }), { params: Promise.resolve({ id }) } as never);
};

test('the route checks the link before it reads a byte: no key, a wrong key, the buyer, an unpaid deal', async () => {
  const d = await liveSeller();
  assert.equal((await post(d.id, null)).status, 403);
  assert.equal((await post(d.id, 'not-a-key')).status, 403);
  assert.equal((await post(d.id, d.keys.buyer)).status, 403);
  assert.equal((await post('00000000-0000-0000-0000-000000000000', d.keys.seller)).status, 404);
  const fresh = await createDeal({ chat: 'Sam: PS5 £350?\nAlex: yes posted\nSam: deal', sellerName: 'Alex', country: 'UK' }, { store: getStore(), ask: askWith() });
  const unpaid = await openLinks(fresh.deal.id, fresh.keys, { store: getStore() });
  assert.equal((await post(fresh.deal.id, unpaid.seller)).status, 409);
});

test('the route answers a read request, and refuses a too-large photo', async () => {
  const d = await liveSeller();
  const ok = await post(d.id, d.keys.seller);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: 'skipped', reason: 'no AI reader key is set' });
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  const tooBig = await post(d.id, d.keys.seller, big);
  assert.equal(tooBig.status, 400);
  assert.match(((await tooBig.json()) as { error: string }).error, /too large/);
  assert.ok(!JSON.stringify(await d.store.listReceipts(d.id)).includes(Buffer.from(JPEG).toString('base64')));
});

test('one deal can ask for a few reads an hour, so it cannot use up everyone\'s budget', async () => {
  const d = await liveSeller();
  for (let i = 0; i < PER_DEAL_HOUR; i++) assert.equal((await post(d.id, d.keys.seller)).status, 200, `read ${i + 1}`);
  const over = await post(d.id, d.keys.seller);
  assert.equal(over.status, 400);
  assert.match(((await over.json()) as { error: string }).error, /too many photos for this deal/);
});

test('label reads share the AI reader\'s caps, and are counted only when a call goes out', async () => {
  // The deals are made first: making a deal runs the AI reader, which is not what is counted here.
  const deals = await Promise.all([liveSeller(), liveSeller()]);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ model: 'qwen/test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(uk) } }], usage: { prompt_tokens: 1800, completion_tokens: 20 } }), { status: 200 });
  }) as typeof fetch;
  process.env.GROQ_API_KEY = 'test-key';
  try {
    // A file that isn't a photo is refused before any call: it costs nothing.
    const junk = await post(deals[0].id, deals[0].keys.seller, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    assert.equal(((await junk.json()) as { status: string }).status, 'unreadable');
    assert.equal(calls, 0);
    const results: string[] = [];
    for (let i = 0; i < READER_LIMITS.totalMinute + 1; i++) {
      const d = deals[i % 2];
      results.push(((await (await post(d.id, d.keys.seller)).json()) as { status: string; reason?: string }).reason ?? 'read');
    }
    assert.equal(calls, READER_LIMITS.totalMinute, 'the provider is called only up to the shared per-minute cap');
    assert.match(results.at(-1)!, /the AI reader is busy \(3 reads a minute in total\)/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GROQ_API_KEY;
  }
});

test('a link used with the wrong device is refused', async () => {
  const d = await liveSeller();
  assert.equal((await post(d.id, withDevice(d.raw.seller, 'not-this-devices-secret'))).status, 403);
});
