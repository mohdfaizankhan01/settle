// npm run eval — runs the warning check over the held-out data/test-chats.jsonl and writes
// per-signal precision and recall (model, keyword rules, both), a threshold sweep, Brier score,
// term accuracy and latency to data/eval/results-<engine>.json. Engine: Settle's own model by
// default; `npm run jev:eval` uses TypeSafe Jev (needs TYPESAFE_API_KEY). Re-run after changing
// any question, training data or threshold (CLAUDE.md).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dealCheck, defaultAskJev, type AskJev, type DealCheckResult } from '../lib/jev/deal-check';
import { localCheck, localThresholds } from '../lib/model/local-check';
import { loadChats, type EvalChat } from '../lib/eval/chats';
import { parseChat } from '../lib/settle/chat';
import { signalThreshold, TERM_MIN_CONFIDENCE } from '../lib/settle/policy';
import { redactChat } from '../lib/settle/redact';
import { ruleWarnings } from '../lib/settle/rules';
import { SIGNALS } from '../lib/settle/signals';

type Row = {
  id: string;
  ok: boolean;
  ms: number;
  model?: string;
  scores: Record<string, number>;
  rules: string[];
  price: { expected: string | null; got: string | null; confidence: number | null };
  delivery: { expected: string | null; got: string | null; confidence: number | null };
  usage?: { input_tokens: number | null; output_tokens: number | null };
};

async function runOne(c: EvalChat, base: AskJev | undefined): Promise<Row> {
  const messages = parseChat(c.chat, c.seller);
  const redacted = redactChat(messages);
  let usage: Row['usage'];
  const ask: AskJev | undefined = base && (async (req) => {
    const out = (await base(req)) as Awaited<ReturnType<AskJev>> & { usage?: Row['usage'] };
    usage = out.usage;
    return out;
  });
  const t = performance.now();
  const r: DealCheckResult = ask ? await dealCheck(redacted, ask) : await localCheck(redacted);
  const ms = Math.round(performance.now() - t);
  const priceToken = redacted.tokens.find((x) => x.id === r.picks.price?.id);
  const sure = (conf?: number) => conf !== undefined && conf >= TERM_MIN_CONFIDENCE;
  return {
    id: c.id,
    ok: r.run.status === 'ran',
    ms,
    model: r.run.status === 'ran' ? r.run.model : undefined,
    scores: r.scores,
    rules: [...new Set(ruleWarnings(redacted.messages).map((w) => w.signalId))],
    price: { expected: c.price, got: sure(r.picks.price?.confidence) ? (priceToken?.amount ?? null) : null, confidence: r.picks.price?.confidence ?? null },
    delivery: {
      expected: c.delivery,
      got: sure(r.picks.delivery?.confidence) && r.picks.delivery?.id !== 'unclear' ? (r.picks.delivery?.id ?? null) : null,
      confidence: r.picks.delivery?.confidence ?? null,
    },
    usage,
  };
}

function prf(rows: Row[], chats: Map<string, EvalChat>, signal: string, flagged: (r: Row) => boolean) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const pos = chats.get(r.id)!.positive.includes(signal);
    const hit = flagged(r);
    if (pos && hit) tp++;
    else if (!pos && hit) fp++;
    else if (pos && !hit) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return { tp, fp, fn, tn, precision, recall, falsePositives: rows.filter((r) => !chats.get(r.id)!.positive.includes(signal) && flagged(r)).map((r) => r.id), misses: rows.filter((r) => chats.get(r.id)!.positive.includes(signal) && !flagged(r)).map((r) => r.id) };
}

async function main() {
  const engine = process.argv.includes('--engine=typesafe') ? 'typesafe' : 'local';
  if (engine === 'typesafe' && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set (.env.local)');
  const chats = loadChats();
  const byId = new Map(chats.map((c) => [c.id, c]));
  const ask = engine === 'typesafe' ? defaultAskJev() : undefined;
  const rows: Row[] = [];
  const queue = [...chats];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        rows.push(await runOne(c, ask));
        process.stdout.write('.');
      }
    }),
  );
  process.stdout.write('\n');
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const ran = rows.filter((r) => r.ok);

  const signals = Object.fromEntries(
    SIGNALS.map((s) => {
      const th = engine === 'local' ? localThresholds()[s.id] : signalThreshold(s.id);
      return [
        s.id,
        {
          threshold: th,
          positives: chats.filter((c) => c.positive.includes(s.id)).length,
          model: prf(ran, byId, s.id, (r) => (r.scores[s.id] ?? 0) >= th),
          brier: ran.reduce((sum, r) => sum + ((r.scores[s.id] ?? 0) - (byId.get(r.id)!.positive.includes(s.id) ? 1 : 0)) ** 2, 0) / Math.max(ran.length, 1),
          rulesOnly: prf(ran, byId, s.id, (r) => r.rules.includes(s.id)),
          combined: prf(ran, byId, s.id, (r) => (r.scores[s.id] ?? 0) >= th || r.rules.includes(s.id)),
          sweep: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
            const m = prf(ran, byId, s.id, (r) => (r.scores[s.id] ?? 0) >= t);
            return { threshold: t, precision: m.precision, recall: m.recall };
          }),
        },
      ];
    }),
  );
  const acc = (key: 'price' | 'delivery') => {
    const labelled = ran.filter((r) => r[key].expected !== null);
    const right = labelled.filter((r) => r[key].got === r[key].expected).length;
    const wrongButSure = labelled.filter((r) => r[key].got !== null && r[key].got !== r[key].expected).map((r) => r.id);
    return { labelled: labelled.length, correct: right, accuracy: labelled.length ? right / labelled.length : null, wrongWhileConfident: wrongButSure };
  };
  const ms = ran.map((r) => r.ms).sort((a, b) => a - b);
  const results = {
    note: 'Synthetic chats written for Settle; not a benchmark. Each chat is a negative for every signal it does not list. The local model never trains on these chats.',
    engine,
    ranAt: new Date().toISOString(),
    model: ran[0]?.model ?? null,
    chats: chats.length,
    failedChecks: rows.filter((r) => !r.ok).map((r) => r.id),
    latencyMs: { p50: ms[Math.floor(ms.length * 0.5)] ?? null, p95: ms[Math.floor(ms.length * 0.95)] ?? null },
    tokens: {
      input: ran.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0),
      output: ran.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0),
    },
    terms: { price: acc('price'), delivery: acc('delivery') },
    signals,
    rows,
  };
  const out = join(process.cwd(), 'data', 'eval', `results-${engine}.json`);
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  for (const [id, s] of Object.entries(signals)) {
    const f = (x: number | null) => (x === null ? ' n/a' : x.toFixed(2));
    console.log(`${id.padEnd(20)} model P ${f(s.model.precision)} R ${f(s.model.recall)} | rules P ${f(s.rulesOnly.precision)} R ${f(s.rulesOnly.recall)} | both P ${f(s.combined.precision)} R ${f(s.combined.recall)} | brier ${s.brier.toFixed(3)}`);
  }
  console.log(`price ${results.terms.price.correct}/${results.terms.price.labelled}, delivery ${results.terms.delivery.correct}/${results.terms.delivery.labelled}, failed ${results.failedChecks.length}, p50 ${results.latencyMs.p50} ms`);
  console.log(`wrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
