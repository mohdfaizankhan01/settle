// npm run model:train — trains Settle's own warning model on data/train-messages.jsonl and writes
// data/model/settle-model.json. Deterministic: the same data gives the same file. Never trains on
// data/test-chats.jsonl (the held-out test set; tests/model.test.ts checks there's no overlap).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeModel } from '../lib/model/model';
import { crossValidatedThresholds, train, type TrainRow } from '../lib/model/train';
import { SIGNALS } from '../lib/settle/signals';

const path = join(process.cwd(), 'data', 'train-messages.jsonl');
const raw = readFileSync(path, 'utf8');
const rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as TrainRow);
const ids = SIGNALS.map((s) => s.id);
const model = train(rows, ids);
const { thresholds, cv } = crossValidatedThresholds(rows, ids);
const file = encodeModel('settle-local-1', model, { messages: rows.length, sha256: createHash('sha256').update(raw).digest('hex') }, thresholds, cv);
mkdirSync(join(process.cwd(), 'data', 'model'), { recursive: true });
const out = join(process.cwd(), 'data', 'model', 'settle-model.json');
writeFileSync(out, `${JSON.stringify(file)}\n`);
for (const id of ids) console.log(`${id.padEnd(20)} threshold ${thresholds[id].toFixed(2)}  cv F1 ${cv[id].f1}  P ${cv[id].precision}  R ${cv[id].recall}`);
console.log(`trained on ${rows.length} messages, ${SIGNALS.length} signals → ${out}`);
