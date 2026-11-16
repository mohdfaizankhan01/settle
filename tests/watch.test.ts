import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announce, watcherCount } from '../lib/settle/changes';
import { claimLink, createDeal, DealError, withDevice } from '../lib/settle/deals';
import { getStore } from '../lib/settle/runtime';
import { LIMITS, openStreams, watchStream } from '../lib/settle/watch';
import { askWith } from './helpers/paid-deal';

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

const dec = new TextDecoder();
/** Reads chunks until `stop` says enough (or the stream ends or time runs out). One read stays pending, so no chunk is lost. */
async function readUntil(stream: ReadableStream<Uint8Array>, stop: (text: string) => boolean, ms = 2000) {
  const reader = stream.getReader();
  let text = '';
  const deadline = Date.now() + ms;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  while (Date.now() < deadline && !stop(text)) {
    pending ??= reader.read();
    const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
    if (got === null) continue;
    pending = undefined;
    if (got.done) break;
    text += dec.decode(got.value);
  }
  reader.releaseLock();
  return text;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = async () => {
  for (let i = 0; i < 20 && openStreams() > 0; i++) await sleep(25);
};

test('the stream opens, says "changed" when the deal changes, and carries nothing else', async () => {
  const ctl = new AbortController();
  const stream = watchStream('w1', 'a1', { signal: ctl.signal });
  const text = readUntil(stream, (t) => t.includes('"changed":true'));
  await sleep(30);
  announce('w1');
  const got = await text;
  assert.match(got, /retry: 3000/);
  assert.match(got, /data: \{"changed":true\}/);
  assert.ok(!/w1/.test(got.replace('watchStream', '')), 'the deal ID is not in the stream');
  ctl.abort();
  await settled();
  assert.equal(openStreams(), 0);
  assert.equal(watcherCount('w1'), 0);
});

test('a heartbeat keeps an idle stream open', async () => {
  const ctl = new AbortController();
  const stream = watchStream('w2', 'a2', { signal: ctl.signal, heartbeatMs: 30 });
  const got = await readUntil(stream, (t) => t.includes(': ping'));
  assert.match(got, /: ping/);
  ctl.abort();
  await settled();
});

test('a stream closes itself after its maximum age, saying so, and frees everything', async () => {
  const stream = watchStream('w3', 'a3', { maxAgeMs: 60 });
  const got = await readUntil(stream, (t) => t.includes('event: bye'));
  assert.match(got, /event: bye/);
  await settled();
  assert.equal(openStreams(), 0);
  assert.equal(watcherCount('w3'), 0);
});

test('the browser going away (abort, or cancelling the reader) frees the stream', async () => {
  const ctl = new AbortController();
  const a = watchStream('w4', 'a4', { signal: ctl.signal });
  const b = watchStream('w4', 'a4');
  assert.equal(openStreams(), 2);
  assert.equal(watcherCount('w4'), 2);
  ctl.abort();
  await b.cancel();
  await settled();
  void a;
  assert.equal(openStreams(), 0);
  assert.equal(watcherCount('w4'), 0);
  const already = new AbortController();
  already.abort();
  watchStream('w4', 'a4', { signal: already.signal });
  await settled();
  assert.equal(openStreams(), 0, 'an already-aborted request never stays open');
});

test('caps: per deal, per address and in total; a closed stream frees its place', async () => {
  const ctls: AbortController[] = [];
  const open = (deal: string, addr: string) => {
    const c = new AbortController();
    ctls.push(c);
    return watchStream(deal, addr, { signal: c.signal });
  };
  for (let i = 0; i < LIMITS.perDeal; i++) open('cap-d', `cap-a${i}`);
  assert.throws(() => open('cap-d', 'cap-x'), (e) => e instanceof DealError && /too many live connections/.test(e.message));
  ctls[0].abort();
  await sleep(10);
  assert.doesNotThrow(() => open('cap-d', 'cap-y'), 'a freed place can be used again');

  for (let i = 0; i < LIMITS.perAddress; i++) open(`cap-e${i}`, 'cap-same');
  assert.throws(() => open('cap-f', 'cap-same'), DealError);

  const before = LIMITS.total;
  LIMITS.total = openStreams();
  assert.throws(() => open('cap-g', 'cap-z'), DealError, 'the total cap');
  LIMITS.total = before;
  ctls.forEach((c) => c.abort());
  await settled();
  assert.equal(openStreams(), 0);
});

async function liveDeal() {
  const store = getStore();
  const { deal, keys } = await createDeal({ chat: 'Sam: is the PS5 £350?\nAlex: yes, I post it tracked\nSam: deal', sellerName: 'Alex', country: 'UK' }, { store, ask: askWith() });
  return { store, id: deal.id, keys };
}
const route = async () => (await import('../app/api/deals/[id]/watch/route')).GET;
const ask = async (id: string, key: string | null, device?: string, signal?: AbortSignal) => {
  const GET = await route();
  const headers: Record<string, string> = {};
  if (key) headers['x-settle-key'] = key;
  if (device) headers['x-settle-device'] = device;
  return GET(new Request(`http://x/api/deals/${id}/watch`, { headers, signal }), { params: Promise.resolve({ id }) } as never);
};

test('the route checks the link like the deal route does: unknown deal, no key, wrong key, unclaimed link', async () => {
  const d = await liveDeal();
  assert.equal((await ask('00000000-0000-0000-0000-000000000000', d.keys.seller)).status, 404);
  assert.equal((await ask(d.id, null)).status, 403);
  assert.equal((await ask(d.id, 'not-the-key')).status, 403);
  assert.equal((await ask(d.id, d.keys.seller)).status, 409, 'a live link that no device has claimed yet is refused, and watching never claims it');
  const other = await liveDeal();
  assert.equal((await ask(d.id, other.keys.seller)).status, 403, "another deal's key does not open this deal's stream");
  assert.equal(openStreams(), 0);
});

test('both sides of a live deal can watch, and each gets a signal when anything about the deal is written', async () => {
  const d = await liveDeal();
  const sellerDevice = (await claimLink(d.id, d.keys.seller, { store: d.store }))!;
  const buyerDevice = (await claimLink(d.id, d.keys.buyer, { store: d.store }))!;
  const ctl = new AbortController();
  const seller = await ask(d.id, d.keys.seller, sellerDevice, ctl.signal);
  const buyer = await ask(d.id, d.keys.buyer, buyerDevice, ctl.signal);
  for (const r of [seller, buyer]) {
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.match(r.headers.get('cache-control') ?? '', /no-transform/);
  }
  const s = readUntil(seller.body!, (t) => t.includes('"changed":true'));
  const b = readUntil(buyer.body!, (t) => t.includes('"changed":true'));
  await sleep(50);
  // The other side acts: a receipt is written, as a confirmation or a webhook would.
  await d.store.addReceipt({ dealId: d.id, kind: 'card.confirmed', at: '2026-11-16T10:00:00Z', data: { by: 'buyer' } });
  const [st, bt] = await Promise.all([s, b]);
  assert.match(st, /"changed":true/);
  assert.match(bt, /"changed":true/);
  for (const t of [st, bt]) {
    assert.ok(!t.includes(d.id) && !t.includes('Alex') && !t.includes('PS5'), 'no deal data in the stream');
  }
  ctl.abort();
  await settled();
  assert.equal(openStreams(), 0);
  assert.equal(watcherCount(d.id), 0);
});

test('a link used with the wrong device is refused', async () => {
  const d = await liveDeal();
  const device = (await claimLink(d.id, d.keys.seller, { store: d.store }))!;
  assert.equal((await ask(d.id, d.keys.seller, `${device}x`)).status, 403);
  assert.equal(withDevice(d.keys.seller, device)?.includes(device), true);
});
