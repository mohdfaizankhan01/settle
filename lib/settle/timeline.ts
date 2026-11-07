// The seller timeline (PLAN M5, Bryntum Scheduler): one row per deal, with when both sides
// agreed, when PayPal confirmed payment, the ship-by window (the card's date, or PayPal's
// recommended 7 days after payment, SP-SHIP-TIME), delivery, and the dispute's response window.
// Each row is coloured by the ship check. Pure: built from the deals, nothing is invented.

import { paysByHold } from './card';
import { REASON_LABELS } from './case-file';
import { holdDeadline, HOLD_DAYS, isHeld } from './handover';
import { isPaid, shipGate } from './ship-gate';
import { signalById, shownTo, TERM_SIGNALS } from './signals';
import { termTitle } from './term-titles';
import type { Deal } from './types';

export type TimelineRow = { id: string; name: string; scenario: string; title: string; status: string; colour: string };
export type TimelineEvent = { id: string; resourceId: string; name: string; startDate: string; endDate: string; eventColor: string; detail: string };

const DAY = 24 * 3600_000;
export const SHIP_WITHIN_DAYS = 7;
const iso = (ms: number) => new Date(ms).toISOString();
/** "Nov 10": short enough to fit a three-day bar on the timeline. */
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Row colour from the ship check: green ready, red hold, amber review, blue before payment. */
export function rowStatus(deal: Deal): { status: string; colour: string } {
  if (!deal.order || deal.order.status === 'CREATED') {
    const warned = deal.warnings.some((w) => shownTo(w.audience, 'seller') || shownTo(w.audience, 'buyer'));
    return warned ? { status: 'Warning before payment', colour: 'orange' } : { status: 'Before payment', colour: 'blue' };
  }
  if (paysByHold(deal)) {
    const o = deal.handover?.outcome?.kind;
    if (o === 'released') return { status: 'Handed over', colour: 'green' };
    if (o === 'voided') return { status: 'Called off: hold released', colour: 'blue' };
    return isHeld(deal) ? { status: 'Held by PayPal: meet to hand over', colour: 'green' } : { status: 'Waiting for the hold', colour: 'orange' };
  }
  const d = shipGate(deal).decision;
  return d === 'SHIP' ? { status: 'Ready to ship', colour: 'green' } : d === 'HOLD' ? { status: 'Hold', colour: 'red' } : { status: 'Review', colour: 'orange' };
}

export function timeline(deals: { deal: Deal; title: string; scenario: string }[], now: Date) {
  const rows: TimelineRow[] = [];
  const events: TimelineEvent[] = [];
  for (const { deal, title, scenario } of deals) {
    const { status, colour } = rowStatus(deal);
    rows.push({ id: deal.id, name: deal.card.item?.value ?? title, scenario, title, status, colour });
    const add = (key: string, name: string, start: number, end: number, color: string, detail: string) =>
      events.push({ id: `${deal.id}:${key}`, resourceId: deal.id, name, startDate: iso(start), endDate: iso(Math.max(end, start)), eventColor: color, detail });

    // Warnings found before anyone paid.
    const seen = new Set<string>();
    for (const w of deal.warnings.filter((x) => !deal.messages.find((m) => m.id === x.messageId)?.added)) {
      if (deal.check.status !== 'ran') break;
      // One event per signal, even when the model and a keyword rule both found it.
      if (seen.has(w.signalId)) continue;
      seen.add(w.signalId);
      const title = signalById(w.signalId)?.title ?? (w.signalId === 'in_person' ? TERM_SIGNALS.in_person.title : 'Warning');
      const found = w.by.startsWith('rule') ? 'a keyword rule' : w.by.startsWith('term') ? 'the card' : w.by === 'memory' ? 'scam memory' : "Settle's model";
      add(`warn-${w.signalId}`, title, Date.parse(deal.check.at), Date.parse(deal.check.at), 'orange', `Warning: ${title}. Found by ${found}.${w.cites.length ? ` PayPal terms: ${w.cites.map(termTitle).join('; ')}.` : ''}`);
    }
    const both = deal.confirmations.length === 2 ? Math.max(...deal.confirmations.map((c) => Date.parse(c.at))) : undefined;
    if (both) add('agreed', 'Both confirmed the card', both, both, 'blue', 'Buyer and seller confirmed the same card, locked by its fingerprint.');

    const paidAt = deal.payment?.webhook?.at;
    if (paidAt && isPaid(deal)) {
      const paid = Date.parse(paidAt);
      add('paid', 'Paid (PayPal confirmed)', paid, paid, 'green', 'A verified PayPal webhook plus a fresh read of the order that matched the card.');
      const t = deal.shipping?.tracking;
      const due = deal.card.shipBy?.value ? Date.parse(deal.card.shipBy.value) : paid + SHIP_WITHIN_DAYS * DAY;
      // A completed shipment is green; an open window takes the row's current colour.
      if (t && t.state === 'sent') add('ship', 'Shipped', paid, Date.parse(t.at), 'green', `Tracking ${t.number} added to PayPal on ${day(Date.parse(t.at))}.`);
      else add('ship', `Ship by ${day(due)}`, paid, due, colour, deal.card.shipBy ? 'The ship-by date on the card.' : `PayPal recommends shipping within ${SHIP_WITHIN_DAYS} days of payment (${termTitle('SP-SHIP-TIME')}).`);
    }
    // Meet-up deals: the hold, the window PayPal guarantees it for, and the handover.
    const heldAt = deal.payment?.holdWebhook?.at;
    if (heldAt) {
      const held = Date.parse(heldAt);
      add('held', 'Held by PayPal', held, held, 'green', 'A verified PayPal hold notification plus a fresh read of the order that matched the card. Nothing taken yet.');
      const o = deal.handover?.outcome;
      const deadline = holdDeadline(deal)?.getTime() ?? held + HOLD_DAYS * DAY;
      if (o) add('handover', o.kind === 'released' ? 'Handed over: PayPal took the money' : 'Called off: hold released', Date.parse(o.at), Date.parse(o.at), o.kind === 'released' ? 'green' : 'blue', o.kind === 'released' ? 'The buyer scanned the seller\'s code and confirmed.' : 'PayPal released the hold; the buyer was not charged.');
      else add('meet', `Meet by ${day(deadline)}`, held, deadline, colour, `Hand over by ${iso(deadline).slice(0, 10)}. PayPal guarantees a hold for ${HOLD_DAYS} days; after that Settle releases it.`);
    }
    const delivered = deal.shipping?.delivered?.date;
    if (delivered) add('delivered', 'Delivered', Date.parse(`${delivered}T12:00:00Z`), Date.parse(`${delivered}T12:00:00Z`), 'teal', 'Entered by the seller from the carrier.');
    for (const d of deal.disputes ?? []) {
      const opened = Date.parse(d.createdAt ?? d.readAt);
      const label = REASON_LABELS[d.reason] ?? d.reason;
      if (d.dueDate) add(`dispute-${d.id}`, `Respond by ${day(Date.parse(d.dueDate))}`, opened, Date.parse(d.dueDate), 'red', `${label}, PayPal case ${d.id}.`);
      else add(`dispute-${d.id}`, `Dispute opened: ${label.toLowerCase()}`, opened, opened, 'red', `PayPal case ${d.id}, ${d.stage.toLowerCase()}; PayPal sets the deadline.`);
    }
  }
  const times = events.flatMap((e) => [Date.parse(e.startDate), Date.parse(e.endDate)]).concat(now.getTime());
  return { start: iso(Math.min(...times) - DAY), end: iso(Math.max(...times) + 6 * DAY), rows, events };
}
