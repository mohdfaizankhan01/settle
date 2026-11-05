import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import modelA from '../data/model/settle-model-a.json';
import modelB from '../data/model/settle-model-b.json';
import { loadChats } from '../lib/eval/chats';
import { normalise } from '../lib/model/features';
import { engineFor } from '../lib/model/engine';
import { clauses, localCheck, localThresholds, MAX_CLAUSES_PER_MESSAGE, MAX_PIECE_CHARS } from '../lib/model/local-check';
import type { ModelFile } from '../lib/model/model';
import { parseChat } from '../lib/settle/chat';
import { redactChat } from '../lib/settle/redact';
import { SIGNALS } from '../lib/settle/signals';

// Settle's own model. These check the training/test split and the engine's behaviour, not
// accuracy (that's `npm run eval`).

const files = [modelA, modelB] as unknown as ModelFile[];
const trainRaw = readFileSync('data/train-messages.jsonl', 'utf8');

test('both committed models were trained on the committed training data', () => {
  for (const f of files) assert.equal(f.trainedOn.sha256, createHash('sha256').update(trainRaw).digest('hex'), `${f.name}: run npm run model:train`);
});

test('no test-chat message appears in the training data', () => {
  const train = new Set(trainRaw.split('\n').filter(Boolean).map((l) => normalise(JSON.parse(l).text)));
  for (const c of loadChats()) {
    for (const m of redactChat(parseChat(c.chat, c.seller)).messages) {
      assert.ok(!train.has(normalise(m.text)) || normalise(m.text).split(' ').length <= 2, `${c.id}: "${m.text}" is in the training data`);
    }
  }
});

test('every signal has a cross-validated threshold in both models', () => {
  for (const f of files) for (const s of SIGNALS) assert.ok(f.thresholds[s.id] >= 0.1 && f.thresholds[s.id] < 1, `${f.name} ${s.id}`);
  assert.deepEqual(localThresholds(), files[1].thresholds, 'model B is the default');
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

test('clause splitting is bounded per message and per piece', () => {
  const long = Array.from({ length: 50 }, (_, i) => `this is clause number ${i}`).join(', ');
  const parts = clauses(long);
  assert.ok(parts.length <= MAX_CLAUSES_PER_MESSAGE + 1);
  assert.ok(parts.every((p) => p.length <= MAX_PIECE_CHARS));
});

test('a risky clause inside an ordinary message is still flagged', async () => {
  const r = await localCheck(chat('Sam: is the PS5 still for sale?\nAlex: yes £350 posted, send it as a gift so no fees\nSam: ok'));
  assert.ok(r.warnings.some((w) => w.signalId === 'ff_payment'));
});

test('a chat too long to check in full fails closed, never "no warning signs"', async () => {
  const filler = Array.from({ length: 150 }, (_, i) =>
    `${i % 2 ? 'Alex' : 'Sam'}: the frame is fine on number ${i}, the wheels are true and straight, the tyres were fitted last spring`,
  );
  const r = await localCheck(chat([...filler, 'Alex: yes £350 posted, send it as a gift so no fees'].join('\n')));
  assert.equal(r.run.status, 'failed');
  assert.match(r.run.status === 'failed' ? r.run.reason : '', /^ChatTooLongError/);
});

test('delivery term quotes where the seller offered it, not a later scam line', async () => {
  const { localTermPicks } = await import('../lib/model/terms');
  const ff = redactChat(parseChat(
    'Ann: hi, is the Nintendo Switch OLED still for sale?\nSam: yes, $260 and I post it tracked\nAnn: great, I\'ll take it\nSam: please send it as friends and family so there are no fees',
    'Sam',
  ));
  const picks = localTermPicks(ff);
  assert.equal(picks.delivery?.id, 'post');
  assert.equal(picks.deliveryMessage?.id, ff.messages[1].id);

  const fake = redactChat(parseChat(
    'Bo: is the Sony A7 III camera still available?\nCy: yes, $450, posted tracked\nBo: deal\nBo: I\'ve paid already, PayPal emailed you. The money is on hold until you send me the tracking number, so ship it first',
    'Cy',
  ));
  assert.equal(localTermPicks(fake).deliveryMessage?.id, fake.messages[1].id);

  // Only the buyer names delivery: fall back to the first message that does.
  const buyerOnly = redactChat(parseChat('Bo: can you post it?\nCy: yes\nBo: and ship it tracked please', 'Cy'));
  assert.equal(localTermPicks(buyerOnly).deliveryMessage?.id, buyerOnly.messages[0].id);
});
