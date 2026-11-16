// npm run label:eval — the label-photo reader (Part B) on the synthetic labels in
// lib/label/samples.ts. Each label is rendered to a PNG with Playwright, sent once to the vision
// model, and the reply goes through readLabel's own checks, exactly as in the app. Writes
// data/eval/label.json (committed; /proof reads it). Also renders the judge-mode sample label to
// public/sample-label.png and records its reading in data/demo/label-recorded.json, so judge mode
// never calls the model. Replies are cached in data/eval/label-replies.local.json (git-ignored).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { askGroqVision, VisionSkip, type AskVision, type VisionReply } from '../lib/label/provider';
import { LABEL_PROMPT_VERSION, labelModel, readLabel } from '../lib/label/read-label';
import { SAMPLE_LABEL, sampleLabels, type SampleLabel } from '../lib/label/samples';

/** Groq's paid-tier prices per million tokens (the free tier is $0), as in scripts/reader-eval.mts. */
const PRICES: Record<string, { input: number; output: number }> = { 'qwen/qwen3.8-27b': { input: 0.8, output: 4.0 } };
// Groq's free tier allows 8,000 tokens a minute on this model and a photo is about 2,000: ~4 a minute.
const PACE_MS = 25000;
/** --cached-only: score the replies already cached, call nothing (for when the daily limit is used up). */
const CACHED_ONLY = process.argv.includes('--cached-only');
const CACHE = 'data/eval/label-replies.local.json';
const model = labelModel();
const cache: Record<string, VisionReply & { ms: number }> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

if (!process.env.GROQ_API_KEY) {
  console.error('GROQ_API_KEY is not set (.env.local): the label eval was not run.');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 680, height: 440 }, deviceScaleFactor: 1 });
async function render(label: SampleLabel) {
  await page.setContent(label.html);
  return new Uint8Array(await page.screenshot({ type: 'png', fullPage: true }));
}

let live = 0;
/** One reply per image, cached; the live call is paced for Groq's free tier and retried once on a rate limit. */
async function replyFor(png: Uint8Array): Promise<(VisionReply & { ms: number }) | undefined> {
  const key = `${LABEL_PROMPT_VERSION}|${model}|${sha(png)}`;
  if (cache[key]) return cache[key];
  if (CACHED_ONLY) return undefined;
  let captured: (VisionReply & { ms: number }) | undefined;
  const ask: AskVision = async (req, m) => {
    for (let attempt = 0; ; attempt++) {
      if (live++ > 0) await sleep(PACE_MS);
      const t = performance.now();
      try {
        const r = await askGroqVision(req, m);
        captured = { ...r, ms: Math.round(performance.now() - t) };
        return r;
      } catch (e) {
        if (e instanceof VisionSkip && attempt < 3) {
          await sleep(60_000);
          continue;
        }
        throw e;
      }
    }
  };
  await readLabel(png, 'US', { ask, model });
  if (captured) {
    cache[key] = captured;
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  return captured;
}

type Row = { id: string; country: string; expected: string | null; got: string | null; outcome: 'right' | 'wrong' | 'refused' | 'not run'; reason?: string };
const rows: Row[] = [];
const squash = (s: string) => s.toUpperCase().replace(/\s+/g, '');
for (const label of sampleLabels()) {
  const png = await render(label);
  const reply = await replyFor(png);
  if (!reply) {
    // No reply (Groq's limit, or --cached-only): not measured, so not counted either way.
    rows.push({ id: label.id, country: label.country, expected: label.expected, got: null, outcome: 'not run' });
    console.log(`${label.id.padEnd(16)} not run`);
    continue;
  }
  const read = await readLabel(png, label.country, { ask: async () => reply, model });
  const got = read.status === 'read' ? read.postcode : null;
  const outcome: Row['outcome'] =
    label.expected === null ? (got === null ? 'right' : 'wrong') : got === null ? 'refused' : squash(got) === squash(label.expected) ? 'right' : 'wrong';
  rows.push({ id: label.id, country: label.country, expected: label.expected, got, outcome, ...(read.status !== 'read' ? { reason: read.reason } : {}) });
  console.log(`${label.id.padEnd(16)} expected ${String(label.expected).padEnd(11)} got ${String(got).padEnd(11)} ${outcome}${read.status !== 'read' ? ` (${read.reason})` : ''}`);
}

// The judge-mode sample: rendered once, read once, recorded.
const samplePng = await render(SAMPLE_LABEL);
writeFileSync('public/sample-label.png', samplePng);
const sampleReply = await replyFor(samplePng);
const sampleRead = sampleReply ? await readLabel(samplePng, 'US', { ask: async () => sampleReply, model }) : undefined;
if (sampleRead?.status !== 'read' || squash(sampleRead.postcode) !== squash(SAMPLE_LABEL.expected!)) {
  console.error('The sample label was not read right; judge mode keeps its previous recording.');
} else {
  writeFileSync('data/demo/label-recorded.json', `${JSON.stringify({ note: 'A real reading of public/sample-label.png, replayed in judge mode so judge sessions never call the model.', sha256: sha(samplePng), postcode: sampleRead.postcode, model: sampleRead.model, promptVersion: LABEL_PROMPT_VERSION, recordedAt: new Date().toISOString() }, null, 2)}\n`);
}
await browser.close();

const replies = rows.filter((r) => r.outcome !== 'not run').length;
const all = Object.entries(cache).filter(([k, c]) => k.startsWith(`${LABEL_PROMPT_VERSION}|`) && c.model).map(([, c]) => c);
const ms = all.map((c) => c.ms).sort((a, b) => a - b);
const tokens = { input: Math.round(all.reduce((n, c) => n + c.usage.input, 0) / Math.max(1, all.length)), output: Math.round(all.reduce((n, c) => n + c.usage.output, 0) / Math.max(1, all.length)) };
const price = PRICES[model];
const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length;
const out = {
  note: 'Synthetic labels rendered from HTML by this script (lib/label/samples.ts): clean, fictional and upright or slightly tilted. A sanity check of the reader and of code\'s checks, not a benchmark of real phone photos.',
  ranAt: new Date().toISOString(),
  model,
  promptVersion: LABEL_PROMPT_VERSION,
  labels: replies,
  right: count('right'),
  wrong: count('wrong'),
  refused: count('refused'),
  notRun: rows.filter((r) => r.outcome === 'not run').map((r) => r.id),
  ofLabels: rows.length,
  misses: rows.filter((r) => r.outcome === 'wrong' || r.outcome === 'refused').map(({ id, expected, got, outcome, reason }) => ({ id, expected, got, outcome, reason: reason ?? null })),
  latencyMs: { p50: ms[Math.floor(ms.length * 0.5)] ?? null, p95: ms[Math.floor(ms.length * 0.95)] ?? null },
  tokensPerLabel: tokens,
  costPerLabelUsd: price ? (tokens.input * price.input + tokens.output * price.output) / 1e6 : null,
  pricesChecked: 'https://console.groq.com/docs/models, 2026-11-10 (paid tier; the free tier we use is $0)',
  rows,
  // Reported, not hidden: the first run, before the prompt stated the JSON shape. Its refusals were
  // the model renaming or dropping the address field; every postcode it did return was right.
  earlierRuns: [{ promptVersion: 'label-1', ranAt: '2026-11-16T21:41:44Z', labels: 28, right: 18, wrong: 0, refused: 10, note: 'The model often renamed or left out the recipient-address field, so code refused the reading; label-2 states the JSON shape and code reads the common field names.' }],
};
writeFileSync('data/eval/label.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.right} right, ${out.wrong} wrong, ${out.refused} refused of ${out.labels} measured (${out.notRun.length} not run); p50 ${out.latencyMs.p50} ms; ${tokens.input} in / ${tokens.output} out tokens; $${out.costPerLabelUsd?.toFixed(5)} per label at paid rates`);
