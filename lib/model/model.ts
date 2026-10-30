// Settle's own warning model: one logistic-regression classifier per signal over hashed text
// features. Trained by `npm run model:train` on data/train-messages.jsonl (never on the test
// chats) and stored in data/model/settle-model.json. Runs in-process: no chat text leaves the
// server, no API key, no cost.

import { DIMS, featurise, type SparseVector } from './features';

export type Weights = { bias: number; w: Float32Array };
export type SignalModel = Record<string, Weights>;

/** File format: int16-quantised weights per signal, base64. */
export type ModelFile = {
  name: string;
  dims: number;
  scale: number;
  trainedOn: { messages: number; sha256: string };
  /** Warning threshold per signal, from cross-validation on the training messages. */
  thresholds: Record<string, number>;
  /** Out-of-fold message-level results behind those thresholds. */
  cv: Record<string, { f1: number; precision: number; recall: number }>;
  signals: Record<string, { bias: number; weights: string }>;
};

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function scoreVector(m: Weights, x: SparseVector): number {
  let z = m.bias;
  for (let i = 0; i < x.idx.length; i++) z += m.w[x.idx[i]] * x.val[i];
  return sigmoid(z);
}

export function encodeModel(
  name: string,
  model: SignalModel,
  trainedOn: ModelFile['trainedOn'],
  thresholds: ModelFile['thresholds'],
  cv: ModelFile['cv'],
): ModelFile {
  const scale = 4096;
  const signals: ModelFile['signals'] = {};
  for (const [id, m] of Object.entries(model)) {
    const q = new Int16Array(DIMS);
    for (let i = 0; i < DIMS; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(m.w[i] * scale)));
    signals[id] = { bias: Math.round(m.bias * 1e4) / 1e4, weights: Buffer.from(q.buffer).toString('base64') };
  }
  return { name, dims: DIMS, scale, trainedOn, thresholds, cv, signals };
}

export function decodeModel(file: ModelFile): SignalModel {
  if (file.dims !== DIMS) throw new Error(`model has ${file.dims} dims, code expects ${DIMS}`);
  const out: SignalModel = {};
  for (const [id, s] of Object.entries(file.signals)) {
    const buf = Buffer.from(s.weights, 'base64');
    const q = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    const w = new Float32Array(DIMS);
    for (let i = 0; i < DIMS; i++) w[i] = q[i] / file.scale;
    out[id] = { bias: s.bias, w };
  }
  return out;
}

/** Probability per signal for one message. */
export function scoreMessage(model: SignalModel, text: string): Record<string, number> {
  const x = featurise(text);
  // A message with no words ("?", an emoji) carries no evidence for any signal.
  if (!/[a-z0-9]/i.test(text)) return Object.fromEntries(Object.keys(model).map((id) => [id, 0]));
  return Object.fromEntries(Object.entries(model).map(([id, m]) => [id, scoreVector(m, x)]));
}
