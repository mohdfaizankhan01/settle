import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announce, COALESCE_MS, watch, watcherCount } from '../lib/settle/changes';
import { PgDealStore } from '../lib/settle/pg-store';
import { MemoryDealStore, StaleWriteError } from '../lib/settle/store';
import type { Deal } from '../lib/settle/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(COALESCE_MS + 80);
const deal = (id: string) => ({ id }) as unknown as Deal;

test('a change signals every watcher of that deal once, and not the watchers of other deals', async () => {
  let a1 = 0, a2 = 0, b = 0;
  const stops = [watch('d-a', () => a1++), watch('d-a', () => a2++), watch('d-b', () => b++)];
  announce('d-a');
  await settle();
  assert.deepEqual([a1, a2, b], [1, 1, 0]);
  stops.forEach((s) => s());
});

test('a burst of writes makes one signal; a later write makes another', async () => {
  let n = 0;
  const stop = watch('d-burst', () => n++);
  for (let i = 0; i < 6; i++) announce('d-burst');
  await settle();
  assert.equal(n, 1, 'six writes close together, one signal');
  announce('d-burst');
  await settle();
  assert.equal(n, 2);
  stop();
});

test('stopping watching frees everything, and announcing with no watchers does nothing', async () => {
  const before = watcherCount();
  let n = 0;
  const stop = watch('d-free', () => n++);
  assert.equal(watcherCount('d-free'), 1);
  announce('d-free');
  stop();
  assert.equal(watcherCount('d-free'), 0);
  assert.equal(watcherCount(), before);
  await settle();
  assert.equal(n, 0, 'a signal that was pending is dropped with its last watcher');
  announce('d-nobody');
  await settle();
  assert.equal(watcherCount('d-nobody'), 0);
  stop();
});

test('one broken listener never stops the others, and stopping twice is harmless', async () => {
  let ok = 0;
  const stops = [watch('d-err', () => { throw new Error('boom'); }), watch('d-err', () => ok++)];
  announce('d-err');
  await settle();
  assert.equal(ok, 1);
  stops.forEach((s) => { s(); s(); });
  assert.equal(watcherCount('d-err'), 0);
});

test('the memory store announces creates, updates and receipts, and not a stale write', async () => {
  const store = new MemoryDealStore();
  let n = 0;
  const stop = watch('m1', () => n++);
  await store.createDeal(deal('m1'));
  await settle();
  assert.equal(n, 1, 'created');
  const stored = (await store.getDeal('m1'))!;
  await store.updateDeal('m1', stored.version, deal('m1'));
  await settle();
  assert.equal(n, 2, 'updated');
  await store.addReceipt({ dealId: 'm1', kind: 'deal.checked', at: '2026-11-16T10:00:00Z', data: {} });
  await settle();
  assert.equal(n, 3, 'receipt');
  await assert.rejects(store.updateDeal('m1', stored.version, deal('m1')), StaleWriteError);
  await settle();
  assert.equal(n, 3, 'a write that lost to another one changed nothing');
  stop();
});

/** A minimal fake of the Postgres client: just enough SQL to run the three write paths. */
function fakeSql(updateRows: unknown[]) {
  const run = async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FOR UPDATE')) return [{ id: 'p1' }];
    if (text.includes('RETURNING version')) return updateRows;
    return [];
  };
  return Object.assign(run, {
    unsafe: async () => [],
    json: (v: unknown) => v,
    begin: async (fn: (tx: typeof run & { json: (v: unknown) => unknown }) => Promise<unknown>) => fn(Object.assign(run, { json: (v: unknown) => v })),
  });
}

test('the Postgres store announces after a committed write, and not after a stale one', async () => {
  let n = 0;
  const stop = watch('p1', () => n++);
  const ok = new PgDealStore(fakeSql([{ version: 2 }]) as never);
  await ok.createDeal(deal('p1'));
  await settle();
  assert.equal(n, 1, 'created');
  await ok.updateDeal('p1', 1, deal('p1'));
  await settle();
  assert.equal(n, 2, 'updated');
  await ok.addReceipt({ dealId: 'p1', kind: 'deal.checked', at: '2026-11-16T10:00:00Z', data: {} });
  await settle();
  assert.equal(n, 3, 'receipt');
  const stale = new PgDealStore(fakeSql([]) as never);
  await assert.rejects(stale.updateDeal('p1', 1, deal('p1')), StaleWriteError);
  await settle();
  assert.equal(n, 3, 'stale write: no signal');
  stop();
});
