// The preview a chat app shows for a deal link (PLAN M6, chat-app entry). Chat apps fetch it from
// their own servers without the link key, so it holds only what's safe for anyone with the link:
// the item, the price, how it's delivered, and where the deal stands. Never names, chat text,
// contact details, addresses or warnings (warnings are for one side only). Pure, so it's easy to
// test that nothing else leaks.

import { formatMoney, isLocked, moneyOf, paysByHold } from './card';
import { isHeld } from './handover';
import { redactChat } from './redact';
import { isPaid } from './ship-gate';
import { CURRENCY_OF, type Deal } from './types';

export type Preview = {
  /** Page title and the card's first line. */
  title: string;
  item: string | null;
  /** "$380.00 · Meet up in person". */
  terms: string | null;
  status: string;
  /** The same short line on every card: the habit that keeps both sides inside PayPal. */
  nudge: string;
  /** What's real: every screen says it's the PayPal sandbox (CLAUDE.md). */
  realness: string;
};

export const PREVIEW_NUDGE = 'Pay only through PayPal on this link. Never Friends and Family.';
const REALNESS = 'PayPal sandbox demo: no real money moves.';
const ITEM_MAX = 60;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Any placeholder redaction leaves: a removed detail ([PHONE]) or a token ([POSTCODE_1], [ZIP_2]). */
const PLACEHOLDER = /\[[A-Z]+(?:_\d+)?[^\]]*\]/;

/**
 * The item for a public preview. The card's item can fall back to a whole chat message, so it goes
 * through the same redaction the AI sees; if anything personal was removed, the preview leaves the
 * item out rather than show a cleaned-up guess.
 */
export function previewItem(deal: Deal): string | null {
  const raw = deal.card.item?.value;
  if (!raw) return null;
  const speakers = [...new Set(deal.messages.map((m) => m.speaker))];
  const [m] = redactChat([{ id: 'item', role: 'seller', speaker: speakers[0] ?? '', text: raw }], speakers).messages;
  // Only a price may be tokenized; any other change (a name, contact detail, postcode, ZIP, date,
  // link) drops the item from the public preview.
  // Also 5+ digits in a row (a ZIP or reference the redactor had no context for); model numbers
  // like "RTX 4090" or "256GB" stay.
  const changed = PLACEHOLDER.test(m.text.replace(/\[PRICE_\d+\]/g, ''));
  return changed || /\d{5,}/.test(raw) ? null : clip(raw.trim(), ITEM_MAX);
}

/** Where the deal stands, in a few words both sides can read. */
export function previewStatus(deal: Deal): string {
  const h = deal.handover;
  if (h?.outcome?.kind === 'voided') return 'Called off: PayPal released the hold';
  if (isPaid(deal)) return paysByHold(deal) ? 'Handed over and paid through PayPal' : 'Paid through PayPal';
  if (isHeld(deal)) return 'Held by PayPal for the meet-up';
  if (deal.order && deal.order.status !== 'CREATED') return 'Waiting for PayPal to confirm';
  if ((deal.declines ?? []).length > 0) return 'Declined by one side';
  if (isLocked(deal)) return 'Terms locked by both';
  const confirmed = new Set(deal.confirmations.map((c) => c.role)).size;
  return confirmed === 1 ? 'Waiting for the other side to confirm' : 'Waiting for both to confirm';
}

/** The preview for a deal link, or the plain Settle Link card for an unknown deal. */
export function previewFor(deal: Deal | undefined): Preview {
  if (!deal) {
    return { title: 'Settle Link deal', item: null, terms: null, status: 'One link to settle a deal made in a DM', nudge: PREVIEW_NUDGE, realness: REALNESS };
  }
  // The item is the seller's own words from the card, never the chat around it.
  const item = previewItem(deal);
  const money = moneyOf(deal);
  const price = money ? formatMoney(money.total, CURRENCY_OF[deal.country]) : deal.card.price?.display;
  const terms = [price, deal.card.delivery?.display].filter(Boolean).join(' · ') || null;
  return {
    title: item ? `Settle Link deal: ${item}` : 'Settle Link deal',
    item,
    terms,
    status: previewStatus(deal),
    nudge: PREVIEW_NUDGE,
    realness: deal.demo ? 'Judge mode demo deal: PayPal is replayed, no money moves.' : REALNESS,
  };
}
