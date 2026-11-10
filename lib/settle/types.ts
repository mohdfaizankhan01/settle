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

/** intent: AUTHORIZE for a meet-up hold (DECISIONS #20). Orders from before Nov 5 have none: CAPTURE. */
export type PaymentOrder = {
  id: string;
  cardHash: string;
  createdAt: string;
  status: string;
  debugId?: string;
  intent?: 'CAPTURE' | 'AUTHORIZE';
  /** Set while the buyer's capture or hold call is at PayPal: the card and payee are frozen from then on. */
  paying?: string;
};

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
      /** Tracker IDs PayPal shows on the order (`<captureId>-<tracking number>`). */
      trackers?: string[];
      /** Item names on the PayPal order, for not-as-described disputes. */
      items?: string[];
      /** Meet-up deals (intent AUTHORIZE): the hold PayPal shows on the order. */
      authorizationId?: string;
      authorizationStatus?: string;
      authorizationExpires?: string;
      /** When PayPal placed the hold (the authorization's create_time). */
      authorizationCreated?: string;
      /** The buyer's PayPal payer ID on the order, for scam memory (stored only as a keyed hash there). */
      payerId?: string;
      /** Why the order doesn't match the card. Empty when it matches. */
      mismatches: string[];
      debugId?: string;
    }
  // Couldn't reach PayPal: "can't check", never "not paid" and never "paid".
  | { ok: false; at: string; reason: string; debugId?: string };

export type Payment = {
  /** The verified PAYMENT.CAPTURE.COMPLETED event for this deal's capture (CLAUDE.md: the only confirmation). */
  webhook?: { eventId: string; captureId: string; at: string };
  /** Meet-up deals: the verified PAYMENT.AUTHORIZATION.CREATED event for this deal's hold. */
  holdWebhook?: { eventId: string; authorizationId: string; at: string };
  /** The latest successful read, or the failure if no read has succeeded yet. */
  read?: OrderRead;
  /** A read that failed after a good one. Newer than `read` means "can't check" right now. */
  failed?: { at: string; debugId?: string };
};

/** What the seller did to ship: the postcode typed from the label, and tracking sent to PayPal. */
export type Shipping = {
  labelPostcode?: { value: string; at: string };
  /** The seller says the carrier shows the parcel delivered on `date`. Settle can't see carriers. */
  delivered?: { date: string; at: string };
  tracking?: {
    carrier: string;
    /** Carrier name when carrier is OTHER. */
    carrierName?: string;
    number: string;
    /** sending: claimed, call in flight. sent: PayPal accepted it. unknown: no answer; re-read decides. */
    state: 'sending' | 'sent' | 'unknown';
    at: string;
    debugId?: string;
  };
};

/**
 * A scam memory match: one identifier of the `about` side that at least two other deals reported in
 * the last 90 days. A caution shown to the other side; it never blocks, approves or decides.
 */
export type MemoryHit = { kind: 'payee' | 'payer' | 'postcode' | 'message'; about: 'buyer' | 'seller'; count: number; signalId?: string; messageId?: string };

/**
 * Meet-up deals (DECISIONS #20): the handover. The seller shows a one-time code; the buyer scans it
 * on their own deal link and confirms, and only then is the held money taken. Walking away, or the
 * meet-by date passing, releases the hold. Only the token's hash is stored.
 */
export type Handover = {
  /**
   * The device that started the PayPal checkout for the hold (security review, Nov 5). Whoever
   * makes a deal link holds both links, so the buyer link alone doesn't prove who pays. Placing the
   * hold and releasing it need this device's secret; only its hash is kept.
   */
  payer?: { hash: string; at: string };
  token?: { hash: string; createdAt: string; expiresAt: string };
  /** A capture or void sent to PayPal whose answer isn't recorded yet. A re-read decides. */
  inFlight?: { kind: 'release' | 'void'; at: string; by?: 'buyer' | 'seller' | 'meet_by_passed' };
  /** captureStatus: PayPal's status for the capture; only COMPLETED means the money moved. */
  outcome?: { kind: 'released' | 'voided'; at: string; by: 'buyer' | 'seller' | 'meet_by_passed'; debugId?: string; captureId?: string; captureStatus?: string };
  /** The last capture or void PayPal refused, shown to both sides. */
  failed?: { kind: 'release' | 'void'; at: string; reason: string; debugId?: string };
};

/** A PayPal dispute on this deal's payment, as last read from PayPal (M4). */
export type DisputeRecord = {
  id: string;
  /** PayPal's reason, e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED. */
  reason: string;
  status: string;
  stage: string;
  amount?: { value: string; currency: string };
  createdAt?: string;
  /** When the seller must respond by (seller_response_due_date). */
  dueDate?: string;
  outcome?: string;
  /** The actions PayPal offers right now: the rels and API paths from the dispute's own links. */
  actions: { rel: string; path: string }[];
  readAt: string;
  debugId?: string;
  /** A read that failed after a good one. */
  failed?: { at: string; debugId?: string };
};

/** Judge mode (M5): this deal belongs to one judge session and replays recorded PayPal data. */
export type DemoTag = { session: string; scenario: string; seededAt: string; disputeOpenedAt?: string };

export type Deal = {
  id: string;
  /** Set only on judge-mode deals. Live code paths never call PayPal for a demo deal. */
  demo?: DemoTag;
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
  /**
   * Claim on open (DECISIONS #22): each link works only on the first device that opened it. The
   * maker of a deal gets both links, so this stops them quietly holding a working copy of the
   * other side's link. Only each device secret's hash is kept. Judge-mode deals aren't claimed.
   */
  claims?: Partial<Record<Role, { hash: string; at: string }>>;
  /** The seller's PayPal merchant ID once they connect (D1, DECISIONS #12). Part of the locked card. */
  payeeMerchantId?: string;
  /** The seller's latest Partner Referrals attempt for this deal. */
  connect?: { trackingId: string; startedAt: string };
  order?: PaymentOrder;
  /** The warning check on the latest messages pasted in after payment. */
  addedCheck?: CheckRun;
  /** Filled in after capture by verified webhooks and fresh GETs of the order (M3). */
  payment?: Payment;
  shipping?: Shipping;
  handover?: Handover;
  /** Scam memory matches (DECISIONS #20): identifiers of one side that other deals reported. */
  memory?: { hits: MemoryHit[]; checkedAt: string };
  disputes?: DisputeRecord[];
  /** Dispute responses sent (or being sent) with the seller's approval, by request hash. */
  submissions?: { disputeId: string; rel: string; hash: string; state: 'sending' | 'sent' | 'failed' | 'unknown'; at: string; debugId?: string; status?: number }[];
  /** The last ship gate decision written to a receipt, so only changes are recorded. */
  gate?: { decision: string; key: string; at: string };
};
