// npm run model:train — trains both feature sets of Settle Link's warning model on
// data/train-messages.jsonl and writes data/model/settle-model-a.json (hashed patterns) and
// settle-model-b.json (MiniLM embeddings; needs `npm run model:fetch` first). Deterministic for
// the same data. Never trains on data/test-chats.jsonl (tests/model.test.ts checks there's no
// overlap).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBED_DIMS, embedTexts } from '../lib/model/embed';
import { DIMS, featurise } from '../lib/model/features';
import { encodeModel, type FeatureSet } from '../lib/model/model';
import { crossValidatedThresholds, train, type Example, type TrainRow } from '../lib/model/train';
import { SIGNALS } from '../lib/settle/signals';

const raw = readFileSync(join(process.cwd(), 'data', 'train-messages.jsonl'), 'utf8');
const rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as TrainRow);
const ids = SIGNALS.map((s) => s.id);
const trainedOn = { messages: rows.length, sha256: createHash('sha256').update(raw).digest('hex') };
mkdirSync(join(process.cwd(), 'data', 'model'), { recursive: true });

function fit(name: string, features: FeatureSet, dims: number, data: Example[], out: string) {
  const model = train(data, ids, dims);
  const { thresholds, cv } = crossValidatedThresholds(data, ids, dims);
  writeFileSync(join(process.cwd(), 'data', 'model', out), `${JSON.stringify(encodeModel({ name, features, dims, trainedOn, thresholds, cv }, model))}\n`);
  const mean = ids.reduce((s, id) => s + cv[id].f1, 0) / ids.length;
  console.log(`${name}: mean cv F1 ${mean.toFixed(3)}`);
  for (const id of ids) console.log(`  ${id.padEnd(20)} threshold ${thresholds[id].toFixed(2)}  cv F1 ${cv[id].f1}  P ${cv[id].precision}  R ${cv[id].recall}`);
}

fit('settle-link-a', 'hashed-ngrams', DIMS, rows.map((r) => ({ x: featurise(r.text), signals: r.signals })), 'settle-model-a.json');
const vectors = await embedTexts(rows.map((r) => r.text));
fit('settle-link-b', 'minilm-l6-q8', EMBED_DIMS, rows.map((r, i) => ({ x: vectors[i], signals: r.signals })), 'settle-model-b.json');
