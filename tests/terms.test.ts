import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TERM_TITLES } from '../lib/settle/term-titles';
import { loadTerms } from '../lib/settle/terms-doc';

test('every clause in docs/protection-terms.md has the same title in the UI map, and no extras', () => {
  const { rows } = loadTerms();
  assert.ok(rows.length >= 20);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.requirement])), TERM_TITLES);
  for (const r of rows) assert.ok(r.us && r.uk && r.how, r.id);
});

test('/terms lists the six PayPal pages the quotes come from', () => {
  const { sources } = loadTerms();
  assert.deepEqual(sources.map((s) => s.key), ['US-SP', 'US-PP', 'US-UA', 'UK-SP', 'UK-BP', 'UK-UA']);
  for (const s of sources) assert.match(s.url, /^https:\/\/www\.paypal\.com\//);
});

test('every clause ID cited in code exists in the doc, so no link on a deal page is dead', () => {
  const cited = new Set<string>();
  for (const f of readdirSync(join(process.cwd(), 'lib', 'settle'))) {
    for (const m of readFileSync(join(process.cwd(), 'lib', 'settle', f), 'utf8').matchAll(/'((?:SP|PP)-[A-Z-]+)'/g)) cited.add(m[1]);
  }
  assert.ok(cited.size > 5);
  for (const id of cited) assert.ok(TERM_TITLES[id], id);
});
