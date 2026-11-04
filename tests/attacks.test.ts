import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAttacks } from '../lib/settle/attacks';

// The attack lab uses the real code with PayPal stood in; every attack must be stopped, for the
// reason it names, and nothing may reach the network.

process.env.PAYPAL_CLIENT_ID ??= 'test-client';

test('every "try to fool it" attack is stopped, with a rule and a test named, and no network call', async () => {
  const realFetch = globalThis.fetch;
  const reached: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reached.push(String(input));
    throw new Error('network is off');
  }) as typeof fetch;
  try {
    const results = await runAttacks();
    assert.equal(results.length, 7);
    for (const r of results) {
      assert.equal(r.stopped, true, `${r.id}: ${r.outcome}`);
      assert.match(r.test, /^tests\/[a-z-]+\.test\.ts › /);
      assert.ok(r.rule.length > 0);
    }
    assert.deepEqual(reached, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('every test an attack names exists', async () => {
  const { readFileSync } = await import('node:fs');
  for (const r of await runAttacks()) {
    const [file, name] = r.test.split(' › ');
    assert.ok(readFileSync(file, 'utf8').includes(`test(${JSON.stringify(name).slice(0, -1)}`) || readFileSync(file, 'utf8').includes(`test('${name.replaceAll("'", "\\\\'")}'`), `${r.id}: ${r.test}`);
  }
});

test('an attack only counts as stopped for its named reason', async () => {
  // If the amount check were gone, a different refusal must not be reported as "stopped".
  const { runAttacks: run } = await import('../lib/settle/attacks');
  const results = await run();
  const amount = results.find((r) => r.id === 'amount-in-browser')!;
  assert.match(amount.outcome, /did not match the \$320\.00/);
});
