// The seller timeline (PLAN M5, Bryntum Scheduler): one row per deal, with when both sides
// agreed, when PayPal confirmed payment, the ship-by window (the card's date, or PayPal's
// recommended 7 days after payment, SP-SHIP-TIME), delivery, and the dispute's response window.
// Each row is coloured by the ship check. Pure: built from the deals, nothing is invented.

import { REASON_LABELS } from './case-file';
import { isPaid, shipGate } from './ship-gate';
import { signalById, shownTo } from './signals';
import type { Deal } from './types';

export type TimelineRow = { id: string; name: string; scenario: string; title: string; status: string; colour: string };
export type TimelineEvent = { id: string; resourceId: string; name: string; startDate: string; endDate: string; eventColor: string; detail: string };

const DAY = 24 * 3600_000;
export const SHIP_WITHIN_DAYS = 7;
const iso = (ms: number) => new Date(ms).toISOString();

/** Row colour from the ship check: green ready, red hold, amber review, blue before payment. */
export function rowStatus(deal: Deal): { status: string; colour: string } {
  if (!deal.order || deal.order.status === 'CREATED') {
    const warned = deal.warnings.some((w) => shownTo(w.audience, 'seller') || shownTo(w.audience, 'buyer'));
    return warned ? { status: 'Warning before payment', colour: 'orange' } : { status: 'Before payment', colour: 'blue' };
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
      add(`warn-${w.signalId}`, `Warning: ${signalById(w.signalId)?.title ?? w.signalId}`, Date.parse(deal.check.at), Date.parse(deal.check.at), 'orange', `Found by ${w.by.startsWith('rule') ? 'a keyword rule' : "Settle's model"} in the chat; cites ${w.cites.join(', ')}.`);
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
      if (t && t.state === 'sent') add('ship', `Shipped: ${t.number}`, paid, Date.parse(t.at), 'green', `Tracking added to PayPal on ${t.at.slice(0, 10)}.`);
      else add('ship', `Ship by ${iso(due).slice(0, 10)}`, paid, due, colour, deal.card.shipBy ? 'The ship-by date on the card.' : `PayPal recommends shipping within ${SHIP_WITHIN_DAYS} days of payment (SP-SHIP-TIME).`);
    }
    const delivered = deal.shipping?.delivered?.date;
    if (delivered) add('delivered', 'Delivered', Date.parse(`${delivered}T12:00:00Z`), Date.parse(`${delivered}T12:00:00Z`), 'teal', 'Entered by the seller from the carrier.');
    for (const d of deal.disputes ?? []) {
      const opened = Date.parse(d.createdAt ?? d.readAt);
      const label = REASON_LABELS[d.reason] ?? d.reason;
      if (d.dueDate) add(`dispute-${d.id}`, `Dispute: respond by ${d.dueDate.slice(0, 10)}`, opened, Date.parse(d.dueDate), 'red', `${label}, PayPal case ${d.id}.`);
      else add(`dispute-${d.id}`, `Dispute opened: ${label.toLowerCase()}`, opened, opened, 'red', `PayPal case ${d.id}, ${d.stage.toLowerCase()}; PayPal sets the deadline.`);
    }
  }
  const times = events.flatMap((e) => [Date.parse(e.startDate), Date.parse(e.endDate)]).concat(now.getTime());
  return { start: iso(Math.min(...times) - DAY), end: iso(Math.max(...times) + 2 * DAY), rows, events };
}
