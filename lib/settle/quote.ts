// Chat text as it may leave the page: in receipts, the evidence PDF, and requests to PayPal.
// Always redacted (names, contact details, addresses and account numbers removed), with prices
// and dates put back since they are deal terms, not personal details.

import { redactChat } from './redact';
import type { Deal } from './types';

export function redactedQuote(deal: Deal, messageId: string): string | undefined {
  const { messages, tokens } = redactChat(deal.messages);
  let text = messages.find((m) => m.id === messageId)?.text;
  if (text === undefined) return undefined;
  for (const t of tokens.filter((x) => x.messageId === messageId && (x.kind === 'PRICE' || x.kind === 'DATE'))) text = text.replace(`[${t.id}]`, t.raw);
  return text;
}

/** "The buyer's message “send it to my cousin…”": who said it and what, redacted, never a bare ID. */
export function said(deal: Deal, id: string) {
  const m = deal.messages.find((x) => x.id === id);
  const text = m && redactedQuote(deal, id);
  if (!m || text === undefined) return 'A message';
  const t = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  return `The ${m.role}'s message “${t}”`;
}
