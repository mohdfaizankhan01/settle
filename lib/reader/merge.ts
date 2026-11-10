// Two readers, one card (PLAN M8). Code's picks (the warning engine's term picks, terms.ts) and
// the AI reader's picks are read independently. For price, ship-by date and delivery:
//
//   same pick, reader sure or code >= TERM_MIN_CONFIDENCE  -> filled: "Code and the AI reader agree"
//   same pick, both unsure                                 -> a question, as before
//   different picks                                        -> a question, both readings shown first
//   reader didn't run                                      -> code alone, as before: "Read by code only"
//
// The reader can confirm code's reading or turn it into a question. It can never change a term
// on its own: a merged pick always keeps code's ID, and only its confidence moves.

import type { Pick, TermPicks } from '../jev/deal-check';
import { TERM_MIN_CONFIDENCE } from '../settle/policy';
import type { Reading } from './read';

export const MERGED_TERMS = ['price', 'shipBy', 'delivery'] as const;
export type MergedTerm = (typeof MERGED_TERMS)[number];
export type TermCase = 'agree' | 'both_unsure' | 'disagree' | 'code_only';

/** Below the bar, so buildCard asks instead of filling. */
const ASK = TERM_MIN_CONFIDENCE - 0.01;
/** A sure reader that agrees lifts code's pick to this, so buildCard fills it. */
const AGREED = 0.9;

export type Merged = {
  picks: TermPicks;
  cases: Partial<Record<MergedTerm, TermCase>>;
  /** The reader's pick for each term, to show beside code's when they differ. */
  readerIds: Partial<Record<MergedTerm, string>>;
};

/** Puts `first` and `second` at the top of a question's options, keeping the rest in code's order. */
function ranked(p: Pick, first: string, second?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(p.probabilities)) out[id] = Math.min(v, 0.5);
  out[first] = 1;
  if (second) out[second] = 0.99;
  return out;
}

export function mergePicks(code: TermPicks, reading: Reading | undefined): Merged {
  const picks: TermPicks = { ...code };
  const cases: Merged['cases'] = {};
  const readerIds: Merged['readerIds'] = {};
  for (const term of MERGED_TERMS) {
    const c = code[term];
    if (!c) continue;
    const r = reading?.picks[term];
    if (!r) {
      cases[term] = 'code_only';
      continue;
    }
    readerIds[term] = r.id;
    if (r.id === c.id) {
      const sure = r.sure || c.confidence >= TERM_MIN_CONFIDENCE;
      cases[term] = sure ? 'agree' : 'both_unsure';
      picks[term] = { ...c, confidence: sure ? Math.max(c.confidence, r.sure ? AGREED : c.confidence) : Math.min(c.confidence, ASK) };
    } else {
      cases[term] = 'disagree';
      picks[term] = { ...c, confidence: Math.min(c.confidence, ASK), probabilities: ranked(c, c.id, r.id) };
    }
  }
  return { picks, cases, readerIds };
}
