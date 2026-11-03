// The deal record: one document per deal that follows it from chat to dispute (DECISIONS #4).

import type { ChatMessage, Role } from './chat';
import type { FeePayer } from './fees';
import type { Token } from './redact';

export type Country = 'US' | 'UK';
export type Currency = 'USD' | 'GBP';
export const CURRENCY_OF: Record<Country, Currency> = { US: 'USD', UK: 'GBP' };

export type Delivery = 'post' | 'courier' | 'collect' | 'meetup' | 'digital';

export type TermKey = 'item' | 'price' | 'delivery' | 'shipBy' | 'feePayer';

/** Where a term came from: the message it was read from, or a question both sides answered. */
export type TermSource =
  | { kind: 'message'; messageId: string }
  | { kind: 'answer'; questionId: string }
  // Typed in by the seller when the chat didn't settle it; the buyer still has to confirm.
  | { kind: 'entered'; by: Role };

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
  /** Who pays PayPal's fee (docs/fees.md). Always settled by both sides answering. */
  feePayer?: Term<FeePayer>;
};

/** A term Settle couldn't settle on: both sides pick an option before confirming. */
export type Question = {
  id: string;
  term: TermKey;
  prompt: string;
  options: { id: string; label: string }[];
  answers: Partial<Record<Role, string>>;
  /** The option both sides picked. Resolved questions stay on the record. */
  resolved?: string;
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

export type DeclineReason = 'wants_ff' | 'wants_other_payment' | 'terms_wrong' | 'other';

/** One side said no to the deal link. Shown to the other side as the top warning. */
export type Decline = { role: Role; at: string; reason: DeclineReason };

export type Confirmation = { role: Role; at: string; cardHash: string };

export type PaymentOrder = { id: string; cardHash: string; createdAt: string; status: string; debugId?: string };

/** The shipping address PayPal holds for the payment (SP-ADDR). Shown to the seller only. */
export type ShipTo = { name?: string; lines: string[]; postalCode?: string; countryCode?: string };

/** The latest fresh GET of the order, compared with the locked card. */
export type OrderRead =
  | {
      ok: true;
      at: string;
      orderStatus: string;
      captureId?: string;
      captureStatus?: string;
      /** PayPal's actual fee and the seller's net, from the capture. */
      fee?: string;
      net?: string;
      shipTo?: ShipTo;
      /** Why the order doesn't match the card. Empty when it matches. */
      mismatches: string[];
      debugId?: string;
    }
  // Couldn't reach PayPal: "can't check", never "not paid" and never "paid".
  | { ok: false; at: string; reason: string; debugId?: string };

export type Payment = {
  /** The verified PAYMENT.CAPTURE.COMPLETED event for this deal's capture. */
  webhook?: { eventId: string; captureId: string; at: string; via: 'webhook' | 'event-log' };
  read?: OrderRead;
};

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
  /** Declines still standing. Missing on deals created before Oct 30. */
  declines?: Decline[];
  /** SHA-256 of each side's link key. The keys themselves are never stored. */
  keyHashes: Record<Role, string>;
  /** The seller's PayPal merchant ID once they connect (D1, DECISIONS #12). Part of the locked card. */
  payeeMerchantId?: string;
  /** The seller's latest Partner Referrals attempt for this deal. */
  connect?: { trackingId: string; startedAt: string };
  order?: PaymentOrder;
  /** Filled in after capture by verified webhooks and fresh GETs of the order (M3). */
  payment?: Payment;
};
