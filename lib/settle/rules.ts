// Keyword rules that run beside Jev. A rule can only add a warning, never remove one, and it
// shows the word it matched because a keyword is a hint (it can't tell "pay by Zelle" from
// "I won't pay by Zelle"). Rules read the redacted text, so bank details, wallets and links
// appear as [IBAN], [SORTCODE], [WALLET] and [LINK_n (not PayPal)].

import type { RedactedMessage } from './redact';
import { SIGNALS, type SignalId } from './signals';
import type { Warning } from './types';

type Rule = { id: string; signal: SignalId; re: RegExp };

const RULES: Rule[] = [
  { id: 'ff-words', signal: 'ff_payment', re: /\b(?:friends?\s*(?:and|&|\+|n)\s*family|family\s*(?:and|&)\s*friends?|f\s?[&+n]\s?f|as\s+a\s+gift|personal\s+payment)\b/i },
  { id: 'off-paypal-words', signal: 'off_paypal', re: /\b(?:zelle|cash\s?app|venmo|bank\s+transfer|wire\s+transfer|western\s+union|moneygram|bitcoin|btc|usdt|crypto|ethereum|gift\s?cards?|steam\s+card|apple\s+card|google\s+play\s+card|revolut|wise\s+transfer)\b/i },
  { id: 'off-paypal-details', signal: 'off_paypal', re: /\[(?:IBAN|SORTCODE|WALLET)\]|\[LINK_\d+ \(not PayPal\)\]/ },
  { id: 'code-words', signal: 'code_request', re: /\b(?:send|give|tell|share|forward)\b[^.?!]{0,40}\b(?:code|pin|otp)\b/i },
  { id: 'ai-words', signal: 'ai_instructions', re: /\bsystem\s*:|\b(?:ignore\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous\s+|prior\s+)?instructions|system\s*prompt|as\s+an\s+ai|mark\s+(?:this|the)\s+(?:deal\s+)?(?:as\s+)?safe|you\s+are\s+(?:an?\s+)?(?:ai|assistant|bot))\b/i },
];

export function ruleWarnings(messages: readonly RedactedMessage[]): Warning[] {
  const warnings: Warning[] = [];
  for (const rule of RULES) {
    const signal = SIGNALS.find((s) => s.id === rule.signal)!;
    const hit = messages.find((m) => (signal.from === 'either' || m.role === signal.from) && rule.re.test(m.text));
    if (!hit) continue;
    warnings.push({
      signalId: signal.id,
      audience: signal.audience,
      messageId: hit.id,
      by: `rule:${rule.id}`,
      matched: rule.re.exec(hit.text)![0],
      cites: signal.cites,
    });
  }
  return warnings;
}
