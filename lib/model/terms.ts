// Term picks for the local engine, in code. Same shape as Jev's Choice answers, so the card logic
// doesn't change. These are deliberately cautious: when the chat doesn't make a term clear, the
// confidence stays below policy and the card asks both sides instead of guessing.

import type { Pick, TermPicks } from '../jev/deal-check';
import type { Redacted } from '../settle/redact';

const ACCEPT = /\b(deal|agreed|ok|okay|sure|fine|done|perfect|great|lovely|yes|yep|it is|sounds good|go on|accept)\b/i;
const REJECT = /\b(no|nah|too much|can't|cannot|lowest is|how about|would you take|instead)\b/i;

const pick = (id: string, confidence: number, others: string[] = []): Pick => ({
  id,
  confidence,
  probabilities: Object.fromEntries([[id, confidence], ...others.filter((o) => o !== id).map((o) => [o, (1 - confidence) / Math.max(others.length - 1, 1)])]),
});

function pickPrice(r: Redacted): Pick | undefined {
  const prices = r.tokens.filter((t) => t.kind === 'PRICE');
  if (prices.length === 0) return undefined;
  const ids = prices.map((p) => p.id);
  const order = r.messages.map((m) => m.id);
  // The last message that names a price, then: is it accepted by the other side afterwards?
  const lastMsgId = prices.at(-1)!.messageId;
  const inLast = prices.filter((p) => p.messageId === lastMsgId);
  const lastMsg = r.messages.find((m) => m.id === lastMsgId)!;
  const after = r.messages.slice(order.indexOf(lastMsgId) + 1);
  const reply = after.find((m) => m.role !== lastMsg.role);
  // Two prices in one message ("I paid £450 instead of £350"): don't guess.
  if (inLast.length > 1) return pick(inLast.at(-1)!.id, 0.4, ids);
  const candidate = inLast[0].id;
  if (reply && REJECT.test(reply.text)) return pick(candidate, 0.35, ids);
  if (reply && ACCEPT.test(reply.text)) return pick(candidate, 0.85, ids);
  // The same side accepting its own price ("ok £45") after the other side offered it.
  if (ACCEPT.test(lastMsg.text)) return pick(candidate, 0.75, ids);
  return pick(candidate, prices.length === 1 ? 0.65 : 0.5, ids);
}

const DELIVERY: [string, RegExp][] = [
  ['meetup', /\b(meet|meet up|meetup|halfway|in person|swap)\b/i],
  ['collect', /\b(collect|collection|pick it up|pick up|pickup|come round|come over|come to yours|from yours)\b/i],
  ['courier', /\b(courier|ups|dpd|dhl|fedex|evri|hermes|parcelforce)\b/i],
  ['post', /\b(post|posted|postage|posting|ship|shipped|shipping|royal mail|usps|first class|tracked|send it|send you)\b/i],
  ['digital', /\b(key|download|digital|code by email|message it to you|email it)\b/i],
];

function pickDelivery(r: Redacted): { delivery: Pick; message: Pick } {
  const options = [...DELIVERY.map(([k]) => k), 'unclear'];
  const hits = new Map<string, string[]>();
  for (const m of r.messages) for (const [k, re] of DELIVERY) if (re.test(m.text)) hits.set(k, [...(hits.get(k) ?? []), m.id]);
  // "courier" and "post" both mean it's sent; "courier" wins when named.
  if (hits.has('courier')) hits.delete('post');
  const kinds = [...hits.keys()];
  if (kinds.length !== 1) return { delivery: pick('unclear', 0.5, options), message: pick('none', 0.5) };
  const kind = kinds[0];
  return { delivery: pick(kind, 0.8, options), message: pick(hits.get(kind)!.at(-1)!, 0.8) };
}

const ITEM = /\b(still (for sale|available|there)|for sale|selling|interested in|is the|the [a-z0-9]+ (still|available))\b/i;

function pickItemMessage(r: Redacted): Pick {
  const m = r.messages.find((x) => ITEM.test(x.text));
  return m ? pick(m.id, 0.7) : pick('none', 0.6);
}

const SHIP_WORDS = /\b(ship|post|send|deliver|dispatch)\w*\b.*\b(by|on|before)\b|\b(by|before)\b/i;

function pickShipBy(r: Redacted): Pick | undefined {
  const dates = r.tokens.filter((t) => t.kind === 'DATE');
  if (dates.length === 0) return undefined;
  const withShip = dates.filter((d) => SHIP_WORDS.test(r.messages.find((m) => m.id === d.messageId)!.text));
  const ids = dates.map((d) => d.id);
  if (withShip.length === 1) return pick(withShip[0].id, 0.75, [...ids, 'none']);
  if (withShip.length === 0) return pick('none', 0.65, [...ids, 'none']);
  return pick(withShip.at(-1)!.id, 0.45, [...ids, 'none']);
}

export function localTermPicks(r: Redacted): TermPicks {
  const { delivery, message } = pickDelivery(r);
  const picks: TermPicks = { delivery, deliveryMessage: message, itemMessage: pickItemMessage(r) };
  const price = pickPrice(r);
  if (price) picks.price = price;
  const shipBy = pickShipBy(r);
  if (shipBy) picks.shipBy = shipBy;
  return picks;
}
