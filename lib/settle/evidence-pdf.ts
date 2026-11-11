// The evidence pack PDF (PLAN M4 MUST), built only from the record: summary, the confirmed card
// with both confirmations and its hash, the redacted chat with the source quotes marked, the
// PayPal order and capture, tracking, the ship check as it stood at shipping, the case file, and
// the receipts with the chain check. Every section says where it came from. No model writes any
// of it. Deterministic: the same record gives the same bytes, so the seller can approve a hash.

import { termTitle } from './term-titles';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { cardHash, formatMoney, moneyOf } from './card';
import { caseFile, gateAtShipping, type CaseFile } from './case-file';
import { carrierLabel } from './carriers';
import { claimText } from './quote';
import { redactChat } from './redact';
import { verifyChain, type Receipt } from './receipts';
import type { Deal, DisputeRecord } from './types';

const PAGE = { w: 595.28, h: 841.89, margin: 50 };
const NAVY = rgb(0, 0.11, 0.39);
const MUTED = rgb(0.33, 0.36, 0.41);

const STATUS_WORD = { on_file: 'On file', missing: 'Missing', contradicts: 'Contradicts' } as const;

/** The standard fonts only encode WinAnsi; anything else becomes '?' rather than failing. */
function safe(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/\r/g, '')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === '\n' ? '\n' : '?';
    }
  }
  return out;
}

class Writer {
  private page!: PDFPage;
  private y = 0;
  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.newPage();
  }
  private newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - PAGE.margin;
  }
  private need(h: number) {
    if (this.y - h < PAGE.margin) this.newPage();
  }
  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const para of safe(font, text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          if (line) lines.push(line);
          // A single word wider than the line is cut.
          let w = word;
          while (font.widthOfTextAtSize(w, size) > width) {
            let cut = w.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
            lines.push(w.slice(0, cut));
            w = w.slice(cut);
          }
          line = w;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const x = PAGE.margin + (opts.indent ?? 0);
    for (const line of this.wrap(text, font, size, PAGE.w - PAGE.margin - x)) {
      this.need(size * 1.4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? rgb(0, 0.08, 0.21) });
      this.y -= size * 1.4;
    }
    this.y -= opts.gap ?? 2;
  }
  heading(text: string, source: string) {
    this.y -= 10;
    this.need(40);
    this.text(text, { size: 13, bold: true, color: NAVY, gap: 0 });
    this.text(`Source: ${source}`, { size: 8, color: MUTED, gap: 6 });
  }
}

const day = (iso: string) => iso.slice(0, 10);

/** Builds the PDF. `asOf` fixes the document dates, so the bytes depend only on the record. */
export async function evidencePdf(deal: Deal, dispute: DisputeRecord, receipts: readonly Receipt[]): Promise<Uint8Array> {
  const cf: CaseFile = caseFile(deal, dispute, receipts);
  const asOf = new Date(receipts.at(-1)?.at ?? dispute.readAt);
  const doc = await PDFDocument.create();
  doc.setTitle(`Settle Link evidence pack, dispute ${dispute.id}`);
  doc.setAuthor('Settle Link');
  doc.setCreator('Settle Link');
  doc.setProducer('Settle Link (pdf-lib)');
  doc.setCreationDate(asOf);
  doc.setModificationDate(asOf);
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const money = moneyOf(deal);
  const currency = deal.card.price?.value.currency;
  const read = deal.payment?.read?.ok ? deal.payment.read : undefined;
  const t = deal.shipping?.tracking;

  w.text('Evidence pack', { size: 20, bold: true, color: NAVY, gap: 4 });
  w.text(`PayPal dispute ${dispute.id}: ${cf.reasonLabel}${cf.amount ? `, ${cf.amount}` : ''}. Stage ${dispute.stage}, status ${dispute.status}${dispute.dueDate ? `, seller response due ${day(dispute.dueDate)}` : ''}.`);
  w.text(`Settle Link deal ${deal.id}. Built from the deal's records as of ${asOf.toISOString()}. PayPal sandbox: no real money moved.`, { size: 9, color: MUTED });
  w.text('Each section names where it came from: the PayPal API (read by Settle Link with the seller\'s permission), the Settle Link record (written when each step happened, chained by hash), or entered by the seller.', { size: 9, color: MUTED });

  w.heading('1. The deal card both sides confirmed', 'Settle Link record');
  for (const [label, term] of [['Item', deal.card.item], ['Price', deal.card.price], ['Delivery', deal.card.delivery], ['Ship by', deal.card.shipBy], ["PayPal's fee paid by", deal.card.feePayer]] as const) {
    w.text(`${label}: ${term?.display ?? 'not agreed'}`, { indent: 8, gap: 0 });
  }
  if (deal.card.claims?.length) {
    w.text('What the seller said about the item (exact words from the chat, part of the confirmed card):', { indent: 8, gap: 0 });
    for (const c of deal.card.claims) w.text(`- ${c.kind}: ${claimText(deal, c)}, the seller's message ${c.messageId.slice(1)}`, { indent: 16, gap: 0 });
  }
  for (const c of deal.removedClaims ?? []) w.text(`Marked "not part of the deal" by the ${c.by} at ${c.at}: ${claimText(deal, c)}`, { indent: 8, size: 9, gap: 0, color: MUTED });
  if (money && currency) w.text(`Buyer paid: ${formatMoney(money.total, currency)}`, { indent: 8 });
  for (const c of deal.confirmations) w.text(`Confirmed by the ${c.role} at ${c.at}, card fingerprint ${c.cardHash}`, { indent: 8, size: 9, gap: 0 });
  w.text(`Card fingerprint now: ${cardHash(deal)}. The PayPal order carries ${deal.id}:<fingerprint> in its custom_id, so the payment is tied to this exact card.`, { indent: 8, size: 9 });

  w.heading('2. The chat the card came from (redacted)', 'Settle Link record; names, contact details and account numbers removed');
  const { item, price, delivery, shipBy, feePayer } = deal.card;
  const sources = new Set([
    ...[item, price, delivery, shipBy, feePayer].flatMap((term) => (term?.source.kind === 'message' ? [term.source.messageId] : [])),
    ...(deal.card.claims ?? []).map((c) => c.messageId),
  ]);
  const redacted = redactChat(deal.messages);
  for (const m of redacted.messages) {
    const orig = deal.messages.find((x) => x.id === m.id);
    const tags = [sources.has(m.id) ? 'source of a card term' : '', orig?.added ? `added after payment by the ${orig.added.by}` : ''].filter(Boolean).join('; ');
    w.text(`${m.role}, message ${m.id.slice(1)}${tags ? ` (${tags})` : ''}:`, { size: 8, color: MUTED, gap: 0, indent: 8 });
    w.text(m.text, { indent: 16 });
  }
  const values = redacted.tokens.filter((x) => x.kind === 'PRICE' || x.kind === 'DATE');
  if (values.length > 0) w.text(`Values in the chat: ${values.map((x) => `${x.id} = ${x.raw}`).join(', ')}`, { size: 9, color: MUTED, indent: 8 });

  w.heading('3. The PayPal order and payment', 'PayPal API');
  w.text(`Order ${deal.order?.id ?? 'none'}, status ${read?.orderStatus ?? deal.order?.status ?? 'unknown'}.`, { indent: 8, gap: 0 });
  if (deal.payment?.webhook) w.text(`Capture ${deal.payment.webhook.captureId}, confirmed by a verified PayPal webhook (${deal.payment.webhook.eventId}) at ${deal.payment.webhook.at}.`, { indent: 8, gap: 0 });
  if (read?.fee && currency) w.text(`PayPal's fee ${formatMoney(read.fee, currency)}; the seller received ${read.net ? formatMoney(read.net, currency) : 'n/a'}.`, { indent: 8, gap: 0 });
  if (read?.items?.length) w.text(`Items on the order: ${read.items.join('; ')}`, { indent: 8, gap: 0 });
  if (read?.shipTo) w.text(`Ship-to on the payment: postcode ${read.shipTo.postalCode ?? 'n/a'}, ${read.shipTo.countryCode ?? ''} (the full address is on the PayPal transaction).`, { indent: 8 });

  w.heading('4. Shipping and tracking', 'PayPal API, Settle Link record and entered by the seller');
  if (deal.shipping?.labelPostcode) w.text(`Label postcode typed by the seller on ${day(deal.shipping.labelPostcode.at)}: ${deal.shipping.labelPostcode.value}.`, { indent: 8, gap: 0 });
  if (t) w.text(`Tracking ${t.number} (${carrierLabel(deal, t.carrier)}) sent to PayPal on ${day(t.at)}, state ${t.state}${t.debugId ? `, PayPal debug ID ${t.debugId}` : ''}.`, { indent: 8, gap: 0 });
  else w.text('No tracking was added.', { indent: 8, gap: 0 });
  if (deal.shipping?.delivered) w.text(`Entered by the seller: the carrier shows delivered on ${deal.shipping.delivered.date}.`, { indent: 8, gap: 0 });
  const gate = gateAtShipping(receipts);
  w.text(gate ? `Settle Link's ship check when tracking was added: ${gate.decision} (recorded ${gate.at}).` : 'No ship check was recorded before tracking.', { indent: 8 });

  w.heading('5. Case file for this dispute', 'Settle Link record, from the sections above');
  for (const p of cf.proofs) {
    w.text(`${STATUS_WORD[p.status]}: ${p.label}`, { bold: true, indent: 8, gap: 0 });
    w.text(`${p.detail} (source: ${p.source}; PayPal terms: ${p.cites.map((id) => `${termTitle(id)}, ${id}`).join('; ')})`, { indent: 16, size: 9 });
  }
  for (const n of cf.notes) w.text(n, { indent: 8, size: 9 });

  w.heading('6. Receipts', 'Settle Link record');
  const chain = verifyChain(receipts);
  w.text(chain.ok ? `The receipt chain verifies: ${chain.count} receipts, each holding the hash of the one before.` : `The receipt chain does NOT verify: broken at receipt ${chain.brokenAt} (${chain.reason}).`, { indent: 8, bold: true });
  for (const r of receipts) w.text(`#${r.seq} ${r.at} ${r.kind} ${r.hash.slice(0, 16)}…`, { indent: 8, size: 8, gap: 0 });

  w.text(' ');
  w.text('Settle Link reports what the record shows. It does not decide disputes; PayPal does.', { size: 9, color: MUTED });
  return doc.save({ useObjectStreams: false });
}
