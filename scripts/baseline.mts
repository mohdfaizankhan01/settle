// npm run baseline — a general-purpose LLM asked one broad question, as a baseline for /proof:
// each held-out chat in data/test-chats.jsonl, redacted exactly as the warning check sees it, goes
// to one Groq call asking only "Is this chat a scam attempt? yes or no, and which message."
// Plain fetch, no dependency, nothing at runtime: this writes data/eval/baseline.json and the page
// reads that committed file. Our side comes from the committed rows of `npm run eval`
// (data/eval/results-settle-link-b.json) with the same "any warning" rule the eval uses.
// Replies are kept in data/eval/baseline-replies.local.json (git-ignored), so a re-run spends no
// quota. Needs GROQ_API_KEY; BASELINE_MODEL picks the model (default openai/gpt-oss-120b).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import evalB from '../data/eval/results-settle-link-b.json';
import { loadChats } from '../lib/eval/chats';
import { localThresholds } from '../lib/model/local-check';
import { parseChat } from '../lib/settle/chat';
import { redactChat } from '../lib/settle/redact';
import { SIGNALS } from '../lib/settle/signals';

/** Groq's paid-tier prices per million tokens (the free tier is $0), as in scripts/reader-eval.mts. */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
};

const MODEL = process.env.BASELINE_MODEL || 'openai/gpt-oss-120b';
const URL = 'https://api.groq.com/openai/v1/chat/completions';
const REPLIES = join(process.cwd(), 'data', 'eval', 'baseline-replies.local.json');
/** Milliseconds between live calls: Groq's free tier allows 8K tokens a minute per model. */
const PACE_MS = Number(process.env.BASELINE_PACE_MS ?? 7000);

const QUESTION = 'Is this chat a scam attempt? Answer yes or no, and which message.';
const SYSTEM = `${QUESTION} Reply with JSON only: {"scam": "yes" or "no", "message": the message ID such as "m2", or null}.`;
const SCHEMA = {
  type: 'object',
  properties: { scam: { type: 'string', enum: ['yes', 'no'] }, message: { type: ['string', 'null'] } },
  required: ['scam', 'message'],
  additionalProperties: false,
};

type Reply = { scam: 'yes' | 'no' | null; message: string | null; ms: number; input: number; output: number; error?: string };

const key = process.env.GROQ_API_KEY;
const cache: Record<string, Reply> = existsSync(REPLIES) ? JSON.parse(readFileSync(REPLIES, 'utf8')) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(user: string): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    const res = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'scam_check', strict: false, schema: SCHEMA } },
        max_completion_tokens: 2000,
      }),
    });
    const ms = Math.round(performance.now() - t);
    // The free tier's per-minute limit: wait it out (a script, not a request path).
    if (res.status === 429 && attempt < 6) {
      await sleep(Number(res.headers.get('retry-after') ?? 20) * 1000 + 1000);
      continue;
    }
    if (!res.ok) return { scam: null, message: null, ms, input: 0, output: 0, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const usage = { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 };
    try {
      const a = JSON.parse(body.choices?.[0]?.message?.content ?? '') as { scam?: string; message?: string | null };
      const scam = a.scam === 'yes' || a.scam === 'no' ? a.scam : null;
      return { scam, message: typeof a.message === 'string' ? a.message : null, ms, ...usage, ...(scam ? {} : { error: 'no yes/no answer' }) };
    } catch {
      return { scam: null, message: null, ms, ...usage, error: 'not JSON' };
    }
  }
}

if (!key) {
  console.error('GROQ_API_KEY is not set (.env.local): the baseline was not run, and /proof keeps showing it as not run.');
  process.exit(1);
}

const chats = loadChats();
const replies = new Map<string, Reply>();
let live = 0;
for (const c of chats) {
  const redacted = redactChat(parseChat(c.chat, c.seller));
  const user = redacted.messages.map((m) => `[${m.id}] ${m.role}: ${m.text}`).join('\n');
  const k = createHash('sha256').update(`${MODEL}\n${SYSTEM}\n${user}`).digest('hex');
  let r = cache[k];
  if (!r || r.error) {
    if (live++ > 0) await sleep(PACE_MS);
    r = await ask(user);
    cache[k] = r;
    writeFileSync(REPLIES, JSON.stringify(cache));
    console.log(`${c.id.padEnd(12)} ${r.scam ?? r.error}${r.message ? ` (${r.message})` : ''}  ${r.ms} ms`);
  }
  replies.set(c.id, r);
}

// Groups, as /proof counts them (the same split as `npm run eval`).
const groups = {
  scam: chats.filter((c) => c.positive.length > 0).map((c) => c.id),
  clean: chats.filter((c) => c.positive.length === 0 && !c.id.startsWith('refuse-')).map((c) => c.id),
  refusals: chats.filter((c) => c.positive.length === 0 && c.id.startsWith('refuse-')).map((c) => c.id),
  injection: chats.filter((c) => c.positive.includes('ai_instructions')).map((c) => c.id),
};

// Ours: any warning on the chat (model over its threshold, or a keyword rule), from the eval rows.
type EvalRow = { id: string; ms: number; scores: Record<string, number>; rules: string[] };
const thresholds = localThresholds();
const ourRows = new Map((evalB.rows as EvalRow[]).map((r) => [r.id, r]));
const ourFlags = (id: string) => {
  const r = ourRows.get(id)!;
  return SIGNALS.filter((s) => r.rules.includes(s.id) || (r.scores[s.id] ?? 0) >= thresholds[s.id]).map((s) => s.id);
};

const tally = (flagged: (id: string) => boolean | null) => {
  const count = (ids: string[], want: boolean) => {
    const hit = ids.filter((id) => flagged(id) === want);
    const failed = ids.filter((id) => flagged(id) === null);
    return { of: ids.length, count: hit.length, failed: failed.length, ids: ids.filter((id) => flagged(id) !== want) };
  };
  return {
    scamCaught: count(groups.scam, true),
    cleanFlagged: { ...count(groups.clean, true), ids: groups.clean.filter((id) => flagged(id) === true) },
    refusalsFlagged: { ...count(groups.refusals, true), ids: groups.refusals.filter((id) => flagged(id) === true) },
  };
};

const base = (id: string) => (replies.get(id)!.scam === null ? null : replies.get(id)!.scam === 'yes');
const ran = [...replies.values()].filter((r) => !r.error);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], p: number) => sorted(xs)[Math.floor(xs.length * p)] ?? null;
const price = PRICES_PER_MTOK[MODEL];
const tokens = { input: Math.round(avg(ran.map((r) => r.input))), output: Math.round(avg(ran.map((r) => r.output))) };
function avg(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

const out = {
  note: 'A general-purpose LLM asked one broad question per chat, on the same redacted held-out chats as the warning check. Synthetic chats written for Settle Link; not a benchmark.',
  ranAt: new Date().toISOString(),
  provider: 'Groq',
  model: MODEL,
  question: QUESTION,
  chats: chats.length,
  failed: chats.filter((c) => replies.get(c.id)!.error).map((c) => c.id),
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  baseline: {
    ...tally(base),
    // Injection chats: handled when the chat is flagged as a scam (the instruction didn't talk it out of it).
    injectionHandled: { of: groups.injection.length, count: groups.injection.filter((id) => base(id) === true).length, ids: groups.injection.filter((id) => base(id) !== true) },
    latencyMs: { p50: pct(ran.map((r) => r.ms), 0.5), p95: pct(ran.map((r) => r.ms), 0.95) },
    tokensPerChat: tokens,
    costPerChatUsd: price ? (tokens.input * price.input + tokens.output * price.output) / 1e6 : null,
    pricesChecked: 'https://console.groq.com/docs/models, 2026-11-10 (paid tier; the free tier we used is $0)',
  },
  ours: {
    model: evalB.model,
    ranAt: evalB.ranAt,
    ...tally((id) => ourFlags(id).length > 0),
    // Injection chats: handled when the "instructions aimed at the AI" warning is raised.
    injectionHandled: { of: groups.injection.length, count: groups.injection.filter((id) => ourFlags(id).includes('ai_instructions')).length, ids: groups.injection.filter((id) => !ourFlags(id).includes('ai_instructions')) },
    latencyMs: evalB.latencyMs,
    costPerChatUsd: 0,
  },
};
writeFileSync(join(process.cwd(), 'data', 'eval', 'baseline.json'), `${JSON.stringify(out, null, 2)}\n`);

const row = (label: string, b: { count: number; of: number }, o: { count: number; of: number }) => console.log(`${label.padEnd(32)} baseline ${b.count}/${b.of}   ours ${o.count}/${o.of}`);
row('scam chats caught', out.baseline.scamCaught, out.ours.scamCaught);
row('clean chats wrongly flagged', out.baseline.cleanFlagged, out.ours.cleanFlagged);
row('honest refusals wrongly flagged', out.baseline.refusalsFlagged, out.ours.refusalsFlagged);
row('injection chats handled', out.baseline.injectionHandled, out.ours.injectionHandled);
console.log(`baseline: ${out.failed.length} failed; p50 ${out.baseline.latencyMs.p50} ms, p95 ${out.baseline.latencyMs.p95} ms; ${tokens.input} in / ${tokens.output} out tokens per chat; $${out.baseline.costPerChatUsd?.toFixed(5)} at paid rates`);
