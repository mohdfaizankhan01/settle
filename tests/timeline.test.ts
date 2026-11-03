import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDemo } from '../lib/settle/demo';
import { MemoryDealStore } from '../lib/settle/store';
import { timeline } from '../lib/settle/timeline';

// The seller timeline is built from the deals only: one row per deal, coloured by the ship check.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

test('one row per demo deal, coloured by the ship check, with the events each deal really has', async () => {
  const store = new MemoryDealStore();
  const now = new Date('2026-11-04T10:00:00Z');
  const s = await startDemo(store, () => now);
  const deals = [];
  for (const d of s.deals) deals.push({ deal: (await store.getDeal(d.dealId))!.value, title: d.scenario });
  const t = timeline(deals, now);
  const row = (scenario: string) => t.rows.find((r) => r.scenario === scenario)!;
  const events = (scenario: string) => t.events.filter((e) => e.resourceId === row(scenario).id).map((e) => e.name);
  assert.equal(t.rows.length, 6);
  assert.equal(row('ready').colour, 'green');
  assert.equal(row('hold').colour, 'red');
  assert.equal(row('dispute').colour, 'red');
  assert.equal(row('awaiting').colour, 'blue');
  assert.equal(row('ff').colour, 'orange');
  // The model and the keyword rule both find Friends and Family: shown once.
  assert.equal(events('ff').filter((n) => n.includes('Friends and Family')).length, 1);
  assert.deepEqual(events('awaiting'), ['Both confirmed the card']);
  assert.ok(events('ready').includes('Ship by 2026-11-09'), 'paid 47 h before the session, plus PayPal\'s 7 days');
  const dispute = events('dispute');
  for (const name of ['Paid (PayPal confirmed)', 'Shipped: 9400111899223197428490', 'Delivered']) assert.ok(dispute.includes(name), name);
  assert.ok(dispute.some((n) => n.startsWith('Dispute opened')));
  assert.ok(Date.parse(t.start) < Date.parse('2026-10-25T10:00:00Z'), 'the range covers the oldest event');
});
