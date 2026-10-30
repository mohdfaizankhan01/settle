// Settle Link's own warning model: one logistic-regression classifier per signal. Two feature
// sets: A, hashed word and character patterns (features.ts); B, MiniLM sentence embeddings
// (embed.ts), the default since it cross-validated far better (mean F1 0.81 vs 0.44 on the
// training messages). Trained by `npm run model:train` on data/train-messages.jsonl, never on the
// test chats. Runs in-process: no chat text leaves the server, no API key, no cost.

import type { SparseVector } from './features';

export type FeatureSet = 'hashed-ngrams' | 'minilm-l6-q8';
export type Weights = { bias: number; w: Float32Array };
export type SignalModel = Record<string, Weights>;

/** File format: int16-quantised weights per signal (own scale each), base64. */
export type ModelFile = {
  name: string;
  features: FeatureSet;
  dims: number;
  trainedOn: { messages: number; sha256: string };
  /** Warning threshold per signal, from cross-validation on the training messages. */
  thresholds: Record<string, number>;
  /** Out-of-fold message-level results behind those thresholds. */
  cv: Record<string, { f1: number; precision: number; recall: number }>;
  signals: Record<string, { bias: number; scale: number; weights: string }>;
};

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function scoreVector(m: Weights, x: SparseVector): number {
  let z = m.bias;
  for (let i = 0; i < x.idx.length; i++) z += m.w[x.idx[i]] * x.val[i];
  return sigmoid(z);
}

export function encodeModel(
  meta: Pick<ModelFile, 'name' | 'features' | 'dims' | 'trainedOn' | 'thresholds' | 'cv'>,
  model: SignalModel,
): ModelFile {
  const signals: ModelFile['signals'] = {};
  for (const [id, m] of Object.entries(model)) {
    const max = m.w.reduce((a, v) => Math.max(a, Math.abs(v)), 1e-9);
    const scale = Math.floor(32767 / max);
    const q = Int16Array.from(m.w, (v) => Math.round(v * scale));
    signals[id] = { bias: Math.round(m.bias * 1e4) / 1e4, scale, weights: Buffer.from(q.buffer).toString('base64') };
  }
  return { ...meta, signals };
}

export function decodeModel(file: ModelFile): SignalModel {
  const out: SignalModel = {};
  for (const [id, s] of Object.entries(file.signals)) {
    const buf = Buffer.from(s.weights, 'base64');
    const q = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    if (q.length !== file.dims) throw new Error(`${id}: ${q.length} weights, expected ${file.dims}`);
    out[id] = { bias: s.bias, w: Float32Array.from(q, (v) => v / s.scale) };
  }
  return out;
}

/** A message with no words ("?", an emoji) carries no evidence for any signal. */
export const hasWords = (text: string) => /[a-z0-9]/i.test(text);

/** Probability per signal for one already-featurised message. */
export function scoreFeatures(model: SignalModel, x: SparseVector): Record<string, number> {
  return Object.fromEntries(Object.entries(model).map(([id, m]) => [id, scoreVector(m, x)]));
}
