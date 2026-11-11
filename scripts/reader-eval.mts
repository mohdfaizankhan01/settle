// npm run reader:eval — the AI deal reader (PLAN M8) over synthetic chats. Per term (price,
// ship-by, delivery, item): code only, reader only, and both (what runs), each counted as filled
// right, filled wrong and asked. Also the seller's claims (precision, recall), quotes code dropped,
// latency p50/p95, and tokens and cost per chat. Writes data/eval/reader-<set>.json.
//
//   --set=test (default, data/test-chats.jsonl, held out: never tune the prompt on it) | dev
//   --model=<id>   default SETTLE_READER_MODEL or openai/gpt-oss-120b
//   --pace=<ms>    wait between live calls (Groq free tier: 8,000 tokens a minute), default 16000
//
// Live replies are kept in data/eval/reader-replies.local.json (git-ignored) by prompt version,
// model and chat, so a run that hits Groq's daily limit can resume where it stopped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pick, TermPicks } from '../lib/jev/deal-check';
import { DEV_CHATS, loadChats, type EvalChat } from '../lib/eval/chats';
import { localTermPicks } from '../lib/model/terms';
import { cacheKey } from '../lib/reader/deal-reader';
import { mergePicks, MERGED_TERMS } from '../lib/reader/merge';
import { askGroq, type AskReader, type ReaderReply } from '../lib/reader/provider';
import { PROMPT_VERSION, readDeal, readerModel, type Reading } from '../lib/reader/read';
import { buildCard, type CardReading } from '../lib/settle/card';
import { parseChat } from '../lib/settle/chat';
import { redactChat } from '../lib/settle/redact';
import type { DealCard, Question } from '../lib/settle/types';

/** Groq's paid-tier prices (the free tier is $0). https://console.groq.com/docs/models, checked 2026-11-10. */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
  'qwen/qwen3.8-27b': { input: 0.8, output: 4.0 },
};
const PRICES_CHECKED = { url: 'https://console.groq.com/docs/models', on: '2026-11-10' };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const set = arg('set') === 'dev' ? 'dev' : 'test';
const model = arg('model') ?? readerModel();
const pace = Number(arg('pace') ?? 16000);
const REPLIES = join(process.cwd(), 'data', 'eval', 'reader-replies.local.json');

const replies: Record<string, ReaderReply & { ms: number }> = existsSync(REPLIES) ? JSON.parse(readFileSync(REPLIES, 'utf8')) : {};
let lastLive = 0;
const stored = (key: string): AskReader => async (req, m) => {
  if (replies[key]) return replies[key];
  const wait = lastLive + pace - Date.now();
  if (wait > 0) await new Promise((f) => setTimeout(f, wait));
  const t = performance.now();
  const reply = await askGroq(req, m);
  lastLive = Date.now();
  replies[key] = { ...reply, ms: Math.round(performance.now() - t) };
  writeFileSync(REPLIES, JSON.stringify(replies));
  return reply;
};

type Outcome = 'right' | 'wrong' | 'asked' | 'missed';
type Term = 'price' | 'shipBy' | 'delivery' | 'item';
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(the|a|an) /, '').trim();

function grade(term: Term, c: EvalChat, card: DealCard, questions: Question[]): Outcome | undefined {
  const asked = questions.some((q) => q.term === term && !q.resolved);
  if (term === 'item') {
    if (!c.item) return undefined;
    const v = card.item?.value;
    if (!v) return 'missed';
    // Right: names the item (either name contains the other: "Brompton M6L" for "Brompton M6L,
    // 2019") without carrying the rest of the message along.
    const a = norm(v);
    const b = norm(c.item);
    return (a.includes(b) || (a.length >= 3 && b.includes(a))) && v.length <= c.item.length * 2 + 12 ? 'right' : 'wrong';
  }
  if (term === 'shipBy' && c.shipBy === undefined) return undefined;
  const want = term === 'price' ? c.price : term === 'delivery' ? c.delivery : c.shipBy;
  const got = term === 'price' ? card.price?.value.amount : term === 'delivery' ? card.delivery?.value : card.shipBy?.value;
  if (got !== undefined) return want !== null && want !== undefined && String(got).toLowerCase() === String(want).toLowerCase() ? 'right' : 'wrong';
  // The chat settled nothing: leaving it open (or asking both people) is the right outcome.
  if (want === null) return 'right';
  if (asked) return 'asked';
  // Nothing filled and nothing asked: missed.
  return want === null ? 'right' : 'missed';
}

/** The reader alone, as if it filled the card: sure picks fill, unsure ones ask. */
function readerOnlyPicks(reading: Reading): TermPicks {
  const p = (x?: { id: string; sure: boolean }): Pick | undefined => x && { id: x.id, confidence: x.sure ? 0.9 : 0.4, probabilities: { [x.id]: x.sure ? 0.9 : 0.4 } };
  const r = reading.picks;
  return Object.fromEntries(Object.entries({ price: p(r.price), shipBy: p(r.shipBy), delivery: p(r.delivery), itemMessage: p(r.itemMessage), deliveryMessage: p(r.deliveryMessage) }).filter(([, v]) => v)) as TermPicks;
}

const chats = set === 'dev' ? loadChats(DEV_CHATS) : loadChats();
const TERMS: Term[] = ['price', 'shipBy', 'delivery', 'item'];
const MODES = ['codeOnly', 'readerOnly', 'both'] as const;
const table = Object.fromEntries(MODES.map((m) => [m, Object.fromEntries(TERMS.map((t) => [t, { right: 0, wrong: 0, asked: 0, missed: 0 }]))])) as Record<(typeof MODES)[number], Record<Term, Record<Outcome, number>>>;
const claims = { labelled: 0, kept: 0, matched: 0, found: 0, chats: 0 };
const cases: Record<string, Record<string, number>> = Object.fromEntries(MERGED_TERMS.map((t) => [t, {}]));
let dropped = 0;
const ms: number[] = [];
const tokens = { input: 0, output: 0 };
const notRun: { id: string; status: string; reason: string }[] = [];
const misses: { id: string; term: Term; mode: string; outcome: Outcome }[] = [];
let ran = 0;
let stopped: string | undefined;

for (const c of chats) {
  const messages = parseChat(c.chat, c.seller);
  const r = redactChat(messages);
  const code = localTermPicks(r);
  const key = cacheKey(r, model);
  const run = await readDeal(r, { model, ask: stored(key) });
  if (run.status !== 'ran') {
    notRun.push({ id: c.id, status: run.status, reason: run.reason });
    if (run.status === 'skipped' && /rate limit/.test(run.reason)) {
      stopped = `stopped at ${c.id}: ${run.reason}. Re-run to resume (replies so far are kept).`;
      break;
    }
  }
  const reading = run.status === 'ran' ? run.reading : undefined;
  if (run.status === 'ran') {
    ran++;
    ms.push(replies[key]?.ms ?? run.ms);
    tokens.input += run.usage.input;
    tokens.output += run.usage.output;
    dropped += run.reading.dropped;
  }
  const merged = mergePicks(code, reading);
  for (const t of MERGED_TERMS) if (merged.cases[t]) cases[t][merged.cases[t]!] = (cases[t][merged.cases[t]!] ?? 0) + 1;
  const read: CardReading = { cases: merged.cases, itemWords: reading?.itemWords, claims: reading?.claims };
  const cards = {
    codeOnly: buildCard(messages, r.tokens, code, c.country),
    readerOnly: reading
      ? buildCard(messages, r.tokens, readerOnlyPicks(reading), c.country, { cases: { price: 'agree', shipBy: 'agree', delivery: 'agree' }, itemWords: reading.itemWords })
      : { card: {}, questions: [] as Question[] },
    both: buildCard(messages, r.tokens, merged.picks, c.country, read),
  };
  for (const mode of MODES) {
    if (mode === 'readerOnly' && !reading) continue;
    for (const t of TERMS) {
      const o = grade(t, c, cards[mode].card, cards[mode].questions);
      if (!o) continue;
      table[mode][t][o]++;
      if (o !== 'right' && mode !== 'codeOnly') misses.push({ id: c.id, term: t, mode, outcome: o });
    }
  }
  if (c.claims !== undefined && reading) {
    claims.chats++;
    claims.labelled += c.claims.length;
    claims.kept += reading.claims.length;
    const same = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
    claims.matched += reading.claims.filter((k) => c.claims!.some((l) => same(k.quote, l))).length;
    claims.found += c.claims.filter((l) => reading.claims.some((k) => same(k.quote, l))).length;
  }
}

const pctl = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const price = PRICES_PER_MTOK[model];
const perChat = ran ? { input: Math.round(tokens.input / ran), output: Math.round(tokens.output / ran) } : null;
const result = {
  set,
  file: set === 'dev' ? 'data/reader-dev-chats.jsonl' : 'data/test-chats.jsonl',
  model,
  promptVersion: PROMPT_VERSION,
  provider: 'Groq',
  at: new Date().toISOString().slice(0, 10),
  chats: chats.length,
  readerRan: ran,
  ...(stopped ? { incomplete: stopped } : {}),
  terms: table,
  mergeCases: cases,
  claims: {
    chats: claims.chats,
    labelled: claims.labelled,
    kept: claims.kept,
    precision: claims.kept ? claims.matched / claims.kept : null,
    recall: claims.labelled ? claims.found / claims.labelled : null,
  },
  quotesDropped: dropped,
  latencyMs: { p50: pctl(ms, 50), p95: pctl(ms, 95) },
  tokensPerChat: perChat,
  costPerChatUsd: perChat && price ? (perChat.input * price.input + perChat.output * price.output) / 1e6 : null,
  pricing: { ...price, unit: 'USD per million tokens, Groq paid tier (the free tier used here costs $0)', ...PRICES_CHECKED },
  notRun,
  misses,
};
writeFileSync(join(process.cwd(), 'data', 'eval', `reader-${set}.json`), `${JSON.stringify(result, null, 2)}\n`);

const row = (mode: (typeof MODES)[number]) =>
  TERMS.map((t) => {
    const x = table[mode][t];
    return `${t} ${x.right}/${x.wrong}/${x.asked}/${x.missed}`;
  }).join('  ');
console.log(`${set}: ${chats.length} chats, reader ran on ${ran} (${model}, ${PROMPT_VERSION})${stopped ? `\n${stopped}` : ''}`);
console.log('right/wrong/asked/missed');
for (const m of MODES) console.log(`  ${m.padEnd(10)} ${row(m)}`);
console.log(`claims: precision ${result.claims.precision?.toFixed(2)} recall ${result.claims.recall?.toFixed(2)} (${claims.kept} kept, ${claims.labelled} labelled), dropped ${dropped}`);
console.log(`latency p50 ${result.latencyMs.p50} ms, p95 ${result.latencyMs.p95} ms; tokens/chat ${JSON.stringify(perChat)}; cost/chat $${result.costPerChatUsd?.toFixed(6)}`);
