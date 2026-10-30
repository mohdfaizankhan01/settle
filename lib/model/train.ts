// Trains one logistic-regression classifier per signal with AdaGrad and L2, deterministic
// (seeded shuffle). Positives are weighted up so rare signals are learnt; the weighting is then
// undone in the bias (logit adjustment), so a message with no evidence scores near the training
// base rate instead of 0.5. Each signal's warning threshold is chosen by k-fold cross-validation
// on the training messages only.

import { DIMS, featurise, type SparseVector } from './features';
import type { SignalModel } from './model';
import { sigmoid } from './model';

export type TrainRow = { text: string; signals: string[] };
export type TrainOptions = { epochs?: number; lr?: number; l2?: number; seed?: number };

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function train(rows: TrainRow[], signalIds: string[], opts: TrainOptions = {}): SignalModel {
  const { epochs = 40, lr = 0.5, l2 = 1e-5, seed = 7 } = opts;
  const data: { x: SparseVector; signals: string[] }[] = rows.map((r) => ({ x: featurise(r.text), signals: r.signals }));
  const model: SignalModel = {};
  for (const id of signalIds) {
    const pos = data.filter((d) => d.signals.includes(id)).length;
    const neg = data.length - pos;
    if (pos === 0) throw new Error(`no positives for ${id}`);
    const wPos = neg / pos;
    const w = new Float32Array(DIMS);
    const g2 = new Float32Array(DIMS).fill(1e-8);
    let bias = 0;
    let bg2 = 1e-8;
    for (let e = 0; e < epochs; e++) {
      for (const d of shuffle(data, seed + e)) {
        const y = d.signals.includes(id) ? 1 : 0;
        let z = bias;
        for (let i = 0; i < d.x.idx.length; i++) z += w[d.x.idx[i]] * d.x.val[i];
        const err = (sigmoid(z) - y) * (y ? wPos : 1);
        for (let i = 0; i < d.x.idx.length; i++) {
          const k = d.x.idx[i];
          const g = err * d.x.val[i] + l2 * w[k];
          g2[k] += g * g;
          w[k] -= (lr * g) / Math.sqrt(g2[k]);
        }
        bg2 += err * err;
        bias -= (lr * err) / Math.sqrt(bg2);
      }
    }
    model[id] = { bias: bias - Math.log(wPos), w };
  }
  return model;
}

/** Per signal, the threshold with the best F1 on out-of-fold predictions (k-fold CV). */
export function crossValidatedThresholds(rows: TrainRow[], signalIds: string[], k = 5, opts: TrainOptions = {}) {
  const folds = shuffle(rows.map((_, i) => i), 99).map((idx, n) => ({ idx, fold: n % k }));
  const oof: Record<string, number>[] = new Array(rows.length);
  for (let f = 0; f < k; f++) {
    const trainRows = folds.filter((x) => x.fold !== f).map((x) => rows[x.idx]);
    const m = train(trainRows, signalIds, opts);
    for (const x of folds.filter((y) => y.fold === f)) {
      const v = featurise(rows[x.idx].text);
      oof[x.idx] = Object.fromEntries(signalIds.map((id) => {
        let z = m[id].bias;
        for (let i = 0; i < v.idx.length; i++) z += m[id].w[v.idx[i]] * v.val[i];
        return [id, sigmoid(z)];
      }));
    }
  }
  const thresholds: Record<string, number> = {};
  const cv: Record<string, { f1: number; precision: number; recall: number }> = {};
  for (const id of signalIds) {
    let best = { t: 0.5, f1: -1, precision: 0, recall: 0 };
    // Never below 0.10: lower than that sits at the base rate, where any message would warn.
    for (let t = 0.1; t <= 0.951; t += 0.05) {
      let tp = 0, fp = 0, fn = 0;
      rows.forEach((r, i) => {
        const y = r.signals.includes(id);
        const hit = oof[i][id] >= t;
        if (y && hit) tp++;
        else if (!y && hit) fp++;
        else if (y && !hit) fn++;
      });
      const precision = tp + fp ? tp / (tp + fp) : 0;
      const recall = tp + fn ? tp / (tp + fn) : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      if (f1 > best.f1) best = { t: Math.round(t * 100) / 100, f1, precision, recall };
    }
    thresholds[id] = best.t;
    cv[id] = { f1: Math.round(best.f1 * 1000) / 1000, precision: Math.round(best.precision * 1000) / 1000, recall: Math.round(best.recall * 1000) / 1000 };
  }
  return { thresholds, cv };
}
