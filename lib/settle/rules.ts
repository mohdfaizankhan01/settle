// Keyword rules that run beside the model. A rule can only add a warning, never remove one, and
// it shows the word it matched because a keyword is a hint. The two payment-method rules skip a
// match that is refused in the same clause ("not friends and family", "I won't pay by Zelle"),
// so an honest seller who refuses Friends and Family isn't flagged for it; the model still reads
// every message. Rules read the redacted text, so bank details, wallets and links appear as
// [IBAN], [SORTCODE], [WALLET] and [LINK_n (not PayPal)].

import type { RedactedMessage } from './redact';
import { SIGNALS, type SignalId } from './signals';
import type { Warning } from './types';

type Rule = { id: string; signal: SignalId; re: RegExp; refusable?: boolean };

const RULES: Rule[] = [
  { id: 'ff-words', signal: 'ff_payment', refusable: true, re: /\b(?:friends?\s*(?:and|&|\+|n)\s*family|family\s*(?:and|&)\s*friends?|f\s?[&+n]\s?f|as\s+a\s+gift|personal\s+payment)\b/i },
  { id: 'off-paypal-words', signal: 'off_paypal', refusable: true, re: /\b(?:zelle|cash\s?app|venmo|bank\s+transfer|wire\s+transfer|western\s+union|moneygram|bitcoin|btc|usdt|crypto|ethereum|gift\s?cards?|steam\s+card|apple\s+card|google\s+play\s+card|revolut|wise\s+transfer)\b/i },
  { id: 'off-paypal-details', signal: 'off_paypal', re: /\[(?:IBAN|SORTCODE|WALLET)\]|\[LINK_\d+ \(not PayPal\)\]/ },
  { id: 'code-words', signal: 'code_request', re: /\b(?:send|give|tell|share|forward)\b[^.?!]{0,40}\b(?:code|pin|otp)\b/i },
  { id: 'ai-words', signal: 'ai_instructions', re: /\bsystem\s*:|\b(?:ignore\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous\s+|prior\s+)?instructions|system\s*prompt|as\s+an\s+ai|mark\s+(?:this|the)\s+(?:deal\s+)?(?:as\s+)?safe|you\s+are\s+(?:an?\s+)?(?:ai|assistant|bot))\b/i },
];

// A refusal word counts only within the same clause and at most two words before the match.
// "no" counts only right before it ("no friends and family"), so "no fees if you send it as a
// gift" still warns. Words like "worry" or "fees" in between mean it isn't a refusal of the
// method ("don't worry, send as a gift" warns). A question is never a refusal ("why not F&F?",
// "won't you do F&F", "not friends and family?"). Unsure always means warn.
const CLAUSE_BREAK = /[.,;:!?()\n]|\b(?:but|just|only|so|then|or)\b/gi;
const REFUSAL = /\b(?:not|never|no\s+need\s+for|don'?t|do\s+not|won'?t|will\s+not|can'?t|cannot|instead\s+of|rather\s+than)\s+((?:[\w'&+-]+\s+){0,2})$/i;
const NO_RIGHT_BEFORE = /\bno\s+$/i;
const NOT_A_REFUSAL_OF_THE_METHOD = /\b(?:worr(?:y|ies)|problem|fees?|charges?|scam|bother|hesitate)\b/i;
const ASKING = /^(?:you|u|ya|we)\b/i;
const WHY = /\bwhy\b/i;
const AFTER_CLAUSE_END = /[.,;:!\n]|\b(?:but|so|then)\b/i;

// A list of refused methods shares one refusal: "I don't take Zelle or Venmo". Joiners are
// grouped so the end anchor applies to every branch.
const LIST_JOIN = String.raw`(?:\s*\b(?:or|nor|and)\b\s*|\s*\/\s*)`;

/**
 * Where the refusal of the match at `index` starts (the "not" or "don't"), or undefined when the
 * match isn't refused. `end` is where the match ends, to rule out questions.
 */
export function refusalStart(text: string, index: number, end: number, re?: RegExp): number | undefined {
  const from = Math.max(0, index - 80);
  let before = text.slice(from, index);
  if (re) {
    // Blank out earlier listed methods right before this one, keeping every index in place.
    const listed = new RegExp(`(?:${re.source})${LIST_JOIN}$`, 'i');
    for (let n = 0; n < 5; n++) {
      const next = before.replace(listed, (m) => ' '.repeat(m.length));
      if (next === before) break;
      before = next;
    }
  }
  let clauseAt = 0;
  for (const b of before.matchAll(CLAUSE_BREAK)) clauseAt = b.index + b[0].length;
  const clause = before.slice(clauseAt);
  const after = text.slice(end).split(AFTER_CLAUSE_END)[0];
  if (after.includes('?')) return undefined;
  const no = NO_RIGHT_BEFORE.exec(clause);
  if (no) return from + clauseAt + no.index;
  const m = REFUSAL.exec(clause);
  if (!m || NOT_A_REFUSAL_OF_THE_METHOD.test(m[1]) || ASKING.test(m[1]) || WHY.test(clause.slice(0, m.index))) return undefined;
  return from + clauseAt + m.index;
}

export const refusedAt = (text: string, index: number, end: number, re?: RegExp) => refusalStart(text, index, end, re) !== undefined;

const globalOf = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');

/** The first match in the text that isn't refused, or undefined. */
function firstHit(rule: Rule, text: string): string | undefined {
  if (!rule.refusable) return rule.re.exec(text)?.[0];
  for (const m of text.matchAll(globalOf(rule.re))) if (!refusedAt(text, m.index, m.index + m[0].length, rule.re)) return m[0];
  return undefined;
}

/**
 * When the text names a payment method for this signal and every mention is refused ("not
 * friends and family", "I don't take Zelle or Venmo"), returns the text with each refusal cut
 * out, for the model to score instead: embeddings barely see "not", but the rest of the text
 * still counts ("not friends and family, send it personal so no fees" is scored on "send it
 * personal so no fees"). Otherwise undefined, and the model scores the text as written.
 */
export function withoutRefusals(signal: SignalId, text: string): string | undefined {
  const rules = RULES.filter((r) => r.signal === signal);
  if (!rules.some((r) => r.refusable)) return undefined;
  // Bank details or a non-PayPal link always count as written.
  if (rules.some((r) => !r.refusable && r.re.test(text))) return undefined;
  const cuts: [number, number][] = [];
  for (const rule of rules.filter((r) => r.refusable)) {
    for (const m of text.matchAll(globalOf(rule.re))) {
      const end = m.index + m[0].length;
      const start = refusalStart(text, m.index, end, rule.re);
      if (start === undefined) return undefined;
      cuts.push([start, end]);
    }
  }
  if (cuts.length === 0) return undefined;
  let out = '';
  let at = 0;
  for (const [a, b] of cuts.sort((x, y) => x[0] - y[0])) {
    if (a > at) out += text.slice(at, a);
    at = Math.max(at, b);
  }
  return (out + text.slice(at)).replace(/\s+/g, ' ').trim();
}

export function ruleWarnings(messages: readonly RedactedMessage[]): Warning[] {
  const warnings: Warning[] = [];
  for (const rule of RULES) {
    const signal = SIGNALS.find((s) => s.id === rule.signal)!;
    let hit: RedactedMessage | undefined;
    let matched: string | undefined;
    for (const m of messages) {
      if (signal.from !== 'either' && m.role !== signal.from) continue;
      matched = firstHit(rule, m.text);
      if (matched !== undefined) {
        hit = m;
        break;
      }
    }
    if (!hit || matched === undefined) continue;
    warnings.push({
      signalId: signal.id,
      audience: signal.audience,
      messageId: hit.id,
      by: `rule:${rule.id}`,
      matched,
      cites: signal.cites,
    });
  }
  return warnings;
}
