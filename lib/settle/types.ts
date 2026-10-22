// The deal record: one document per deal that follows it from chat to dispute (DECISIONS #4).

import type { ChatMessage, Role } from './chat';
import type { Token } from './redact';

export type Country = 'US' | 'UK';
export type Currency = 'USD' | 'GBP';
export const CURRENCY_OF: Record<Country, Currency> = { US: 'USD', UK: 'GBP' };

export type Delivery = 'post' | 'courier' | 'collect' | 'meetup' | 'digital';

export type TermKey = 'item' | 'price' | 'delivery' | 'shipBy';

/** Where a term came from: the message it was read from, or a question both sides answered. */
export type TermSource = { kind: 'message'; messageId: string } | { kind: 'answer'; questionId: string };

export type Term<V> = {
  value: V;
  /** Human-readable form shown on the card, e.g. "£120.00", "Post (tracked)". */
  display: string;
  source: TermSource;
  /** Model confidence for the pick, if a model picked it. Below policy → question. */
  confidence?: number;
};

export type DealCard = {
  item?: Term<string>;
  price?: Term<{ amount: string; currency: Currency }>;
  delivery?: Term<Delivery>;
  shipBy?: Term<string>;
};

/** A term Settle couldn't settle on: both sides pick an option before confirming. */
export type Question = {
  id: string;
  term: TermKey;
  prompt: string;
  options: { id: string; label: string }[];
  answers: Partial<Record<Role, string>>;
};

export type Warning = {
  signalId: string;
  /** Who should see it: the side being asked to do something risky. */
  audience: Role | 'both';
  /** Message the warning was found in, if known. */
  messageId?: string;
  probability?: number;
  /** 'jev', 'rule:<id>' or 'term:<key>'. */
  by: string;
  /** For keyword rules: the text that matched, shown as a hint. */
  matched?: string;
  /** Row IDs in docs/protection-terms.md. */
  cites: string[];
};

export type CheckRun =
  | { status: 'ran'; at: string; model?: string }
  // Fail closed: the card must say the check didn't run, never "no warning signs found".
  | { status: 'failed'; at: string; reason: string };

export type Confirmation = { role: Role; at: string; cardHash: string };

export type PaymentOrder = { id: string; cardHash: string; createdAt: string; status: string; debugId?: string };

export type Deal = {
  id: string;
  createdAt: string;
  country: Country;
  messages: ChatMessage[];
  tokens: Token[];
  check: CheckRun;
  warnings: Warning[];
  card: DealCard;
  questions: Question[];
  /** Bumped on every card change; confirmations for an older card no longer count. */
  cardVersion: number;
  confirmations: Confirmation[];
  /** SHA-256 of each side's link key. The keys themselves are never stored. */
  keyHashes: Record<Role, string>;
  /** The seller's PayPal merchant ID once they connect (D1, DECISIONS #12). Part of the locked card. */
  payeeMerchantId?: string;
  order?: PaymentOrder;
};
