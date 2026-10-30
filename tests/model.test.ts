import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import modelFile from '../data/model/settle-model.json';
import { loadChats } from '../lib/eval/chats';
import { normalise } from '../lib/model/features';
import { engineFor } from '../lib/model/engine';
import { localCheck, localThresholds } from '../lib/model/local-check';
import type { ModelFile } from '../lib/model/model';
import { parseChat } from '../lib/settle/chat';
import { redactChat } from '../lib/settle/redact';
import { SIGNALS } from '../lib/settle/signals';

// Settle's own model. These check the training/test split and the engine's behaviour, not
// accuracy (that's `npm run eval`).

const file = modelFile as unknown as ModelFile;
const trainRaw = readFileSync('data/train-messages.jsonl', 'utf8');

test('the committed model was trained on the committed training data', () => {
  assert.equal(file.trainedOn.sha256, createHash('sha256').update(trainRaw).digest('hex'), 'run npm run model:train');
});

test('no test-chat message appears in the training data', () => {
  const train = new Set(trainRaw.split('\n').filter(Boolean).map((l) => normalise(JSON.parse(l).text)));
  for (const c of loadChats()) {
    for (const m of redactChat(parseChat(c.chat, c.seller)).messages) {
      assert.ok(!train.has(normalise(m.text)) || normalise(m.text).split(' ').length <= 2, `${c.id}: "${m.text}" is in the training data`);
    }
  }
});

test('every signal has a cross-validated threshold', () => {
  for (const s of SIGNALS) assert.ok(localThresholds()[s.id] > 0 && localThresholds()[s.id] < 1, s.id);
});

const chat = (text: string) =>
  redactChat(parseChat(text, 'Alex'));

test('flags a plain Friends and Family request, with its message as evidence', async () => {
  const r = await localCheck(chat('Sam: hi is the guitar still for sale?\nAlex: yes £200, send it friends and family to dodge the fees\nSam: ok'));
  assert.equal(r.run.status, 'ran');
  const w = r.warnings.find((x) => x.signalId === 'ff_payment');
  assert.equal(w?.messageId, 'm2');
  assert.equal(w?.by, 'model');
});

test('one-character messages carry no warning', async () => {
  const r = await localCheck(chat('Sam: ?\nAlex: ?\nSam: k'));
  assert.deepEqual(r.warnings, []);
});

test('the local model is the default engine; a mocked Jev is used when injected', () => {
  delete process.env.JEV_PROVIDER;
  assert.equal(engineFor({}), localCheck);
  assert.notEqual(engineFor({ ask: async () => ({ model: 'x', answers: {} }) }), localCheck);
});
