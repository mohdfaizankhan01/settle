// The local engine: Settle Link's own model scores every redacted message for every signal; a
// chat's score for a signal is the highest score among messages from the side the signal is
// about, and that message is the evidence. Terms come from code (terms.ts). Same result shape as
// Jev's dealCheck and the same fail-closed rule. SETTLE_MODEL=a picks the hashed-pattern model;
// the default is b (MiniLM embeddings).

import modelA from '../../data/model/settle-model-a.json';
import modelB from '../../data/model/settle-model-b.json';
import { warningsFrom, type DealCheckResult } from '../jev/deal-check';
import type { Redacted } from '../settle/redact';
import { SIGNALS } from '../settle/signals';
import { embedTexts } from './embed';
import { featurise, type SparseVector } from './features';
import { decodeModel, hasWords, scoreFeatures, type ModelFile, type SignalModel } from './model';
import { localTermPicks } from './terms';

const FILES = { a: modelA as unknown as ModelFile, b: modelB as unknown as ModelFile };
const decoded: Partial<Record<keyof typeof FILES, SignalModel>> = {};

export const activeModel = (): keyof typeof FILES => (process.env.SETTLE_MODEL === 'a' ? 'a' : 'b');
export const localModelFile = () => FILES[activeModel()];
/** Thresholds chosen by cross-validation on the training messages (never the test chats). */
export const localThresholds = () => localModelFile().thresholds;

async function vectors(texts: string[]): Promise<SparseVector[]> {
  return activeModel() === 'a' ? texts.map(featurise) : embedTexts(texts);
}

/**
 * Model B embeds whole sentences, and averaging dilutes a risky clause inside an ordinary message
 * ("yes £350 posted, pay me as a present so no fees"). So each message is also scored clause by
 * clause, and the message gets the highest score. Clauses split on sentence punctuation, commas
 * and joining words; very short pieces are dropped.
 */
// Bounds on model work per chat, so one pasted chat can't make the server embed thousands of pieces.
export const MAX_CLAUSES_PER_MESSAGE = 8;
export const MAX_PIECES_PER_CHAT = 400;
export const MAX_PIECE_CHARS = 1000;
export const TOO_LONG = 'chat too long for the warning check';
export class ChatTooLongError extends Error {
  name = 'ChatTooLongError';
}

export function clauses(text: string): string[] {
  const parts = text
    .split(/[.!?;\n]+|,|\s(?:and|but|so|then|also|plus)\s/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 3);
  return [...new Set([text, ...parts])].slice(0, MAX_CLAUSES_PER_MESSAGE + 1).map((p) => p.slice(0, MAX_PIECE_CHARS));
}

export async function localScores(redacted: Redacted) {
  const key = activeModel();
  const model = (decoded[key] ??= decodeModel(FILES[key]));
  // Fail closed: a chat that needs more pieces than the budget is not checked at all, rather
  // than checked only partly and shown as "no warning signs found".
  const pieces = redacted.messages.map((m) => (!hasWords(m.text) ? [] : key === 'b' ? clauses(m.text) : [m.text.slice(0, MAX_PIECE_CHARS)]));
  const total = pieces.reduce((n, p) => n + p.length, 0);
  if (total > MAX_PIECES_PER_CHAT) throw new ChatTooLongError(`${TOO_LONG}: ${total} pieces, the check reads at most ${MAX_PIECES_PER_CHAT}`);
  const xs = await vectors(pieces.flat());
  let at = 0;
  const perMessage = redacted.messages.map((m, i) => {
    const s: Record<string, number> = {};
    for (let n = 0; n < pieces[i].length; n++) {
      const piece = scoreFeatures(model, xs[at++]);
      for (const [id, p] of Object.entries(piece)) s[id] = Math.max(s[id] ?? 0, p);
    }
    return { m, s };
  });
  const scores: Record<string, number> = {};
  const evidence: Record<string, string | undefined> = {};
  for (const signal of SIGNALS) {
    let best = 0;
    let at: string | undefined;
    for (const { m, s } of perMessage) {
      if (signal.from !== 'either' && m.role !== signal.from) continue;
      if ((s[signal.id] ?? 0) > best) {
        best = s[signal.id];
        at = m.id;
      }
    }
    scores[signal.id] = best;
    evidence[signal.id] = at;
  }
  return { scores, evidence };
}

export async function localCheck(redacted: Redacted, now = () => new Date()): Promise<DealCheckResult> {
  try {
    const { scores, evidence } = await localScores(redacted);
    return {
      run: { status: 'ran', at: now().toISOString(), model: localModelFile().name },
      warnings: warningsFrom(scores, evidence, redacted, 'model', localThresholds()),
      picks: localTermPicks(redacted),
      scores,
    };
  } catch (error) {
    return {
      run: { status: 'failed', at: now().toISOString(), reason: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : 'unknown error' },
      warnings: [],
      picks: {},
      scores: {},
    };
  }
}
