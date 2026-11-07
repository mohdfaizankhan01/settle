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
// method ("don't worry, send as a gift" warns). Unsure always means warn.
const CLAUSE_BREAK = /[.,;:!?()\n]|\b(?:but|just|only|so|then|or)\b/i;
const REFUSAL = /\b(?:not|never|no\s+need\s+for|don'?t|do\s+not|won'?t|will\s+not|can'?t|cannot|instead\s+of|rather\s+than)\s+((?:[\w'&+-]+\s+){0,2})$/i;
const NO_RIGHT_BEFORE = /\bno\s+$/i;
const NOT_A_REFUSAL_OF_THE_METHOD = /\b(?:worr(?:y|ies)|problem|fees?|charges?|scam|bother|hesitate)\b/i;

// A list of refused methods shares one refusal: "I don't take Zelle or Venmo".
const LIST_JOIN = /\s*\b(?:or|nor|and)\b\s*|\s*\/\s*/gi;

export function refusedAt(text: string, index: number, re?: RegExp): boolean {
  const before = text.slice(Math.max(0, index - 60), index);
  const listed = re ? before.replace(new RegExp(`(?:${re.source})${LIST_JOIN.source}$`, 'i'), '') : before;
  const parts = listed.replace(/\s*$/, ' ').split(CLAUSE_BREAK);
  const clause = parts[parts.length - 1] ?? '';
  if (NO_RIGHT_BEFORE.test(clause)) return true;
  const m = REFUSAL.exec(clause);
  return !!m && !NOT_A_REFUSAL_OF_THE_METHOD.test(m[1]);
}

/** The first match in the text that isn't refused, or undefined. */
function firstHit(rule: Rule, text: string): string | undefined {
  if (!rule.refusable) return rule.re.exec(text)?.[0];
  const all = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
  for (const m of text.matchAll(all)) if (!refusedAt(text, m.index, rule.re)) return m[0];
  return undefined;
}

/**
 * True when the text names a payment method for this signal and every mention is refused ("not
 * friends and family", "I don't take Zelle or Venmo"). The model's score for such a piece is
 * ignored, because embeddings barely see "not". A piece that names no method keeps its score, so
 * "pay me as a present" is still caught by the model.
 */
export function onlyRefused(signal: SignalId, text: string): boolean {
  const rules = RULES.filter((r) => r.signal === signal && r.refusable);
  if (rules.length === 0) return false;
  let mentions = 0;
  for (const rule of rules) {
    const all = new RegExp(rule.re.source, rule.re.flags + 'g');
    for (const m of text.matchAll(all)) {
      mentions++;
      if (!refusedAt(text, m.index, rule.re)) return false;
    }
  }
  if (mentions === 0) return false;
  // Anything else on the signal's other rules (bank details, non-PayPal links) still counts.
  return !RULES.some((r) => r.signal === signal && !r.refusable && r.re.test(text));
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
