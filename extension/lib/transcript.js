// Turns what a reader found on the chat page into the "Name: text" chat that POST /api/deals takes
// (lib/settle/chat.ts parses it on the server). Pure functions, no Chrome APIs, so they're tested in
// tests/extension.test.ts. The server still redacts, checks and limits everything: this only makes
// sure the right person is named on each message and that the newest messages fit.

// Same limits as lib/settle/policy.ts (MAX_CHAT_CHARS, MAX_MESSAGES); a test keeps them in step.
export const LIMITS = { chars: 20_000, messages: 200 };

// Invisible marks WhatsApp adds around names and attachments (as in lib/settle/chat.ts).
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;

// One "Name: text" line, with WhatsApp's optional time prefix: "[10:15, 22/10/2026] Name: text"
// (WhatsApp Web copy) or "22/10/2026, 10:15 - Name: text" (export). Matches the server's LINE.
const LINE = /^(?:\[[^\]]{4,40}\]\s*|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?\s+-\s+)?~?\s*([^:\n]{1,40}?)\s*:\s?(.*)$/;

export class TranscriptError extends Error {}

export const clean = (s) => String(s ?? '').replace(INVISIBLE, '').replace(/\r/g, '');

/**
 * A name the server's parser reads back exactly: no colon, line break or square brackets (a leading
 * "[...]" would read as a time), no leading "~" (WhatsApp's mark for unsaved contacts), 40 chars.
 */
export function safeName(s, fallback = '') {
  const name = clean(s)
    .replace(/[:\n[\]]/g, ' ')
    .replace(/^[\s~]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return name || fallback;
}

/** The sender in WhatsApp Web's data-pre-plain-text: "[10:15, 22/10/2026] Alex Smith: " → "Alex Smith". */
export function whatsAppSender(pre) {
  const m = /^\s*\[[^\]]*\]\s*(.+?):\s*$/.exec(clean(pre));
  return m ? safeName(m[1]) : '';
}

/**
 * Selected text, as "Name: text" lines (what WhatsApp Web copies). The two most frequent names are
 * the speakers; any other line continues the message before it, as on the server.
 */
export function parseSelection(text) {
  const lines = clean(text).split('\n');
  const counts = new Map();
  const parsed = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m) return { text: line };
    const name = m[1].trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return { name, text: m[2] };
  });
  const speakers = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  const messages = [];
  for (const line of parsed) {
    if (line.name && speakers.includes(line.name)) messages.push({ name: line.name, text: line.text });
    else if (messages.length > 0) {
      const prev = messages[messages.length - 1];
      prev.text = `${prev.text}\n${line.name ? `${line.name}: ${line.text}` : line.text}`;
    }
  }
  return { speakers, messages: messages.filter((m) => m.text.trim()) };
}

/** Sides for messages that only have names (selected text): the seller's name is "me". */
export function sidesFromNames(messages, sellerName) {
  return messages.map((m) => ({ ...m, side: m.name === sellerName ? 'me' : 'them' }));
}

/** Swaps who said what, for when the layout reader got the sides the wrong way round. */
export const swapSides = (messages) => messages.map((m) => ({ ...m, side: m.side === 'me' ? 'them' : 'me' }));

/**
 * The chat for POST /api/deals. Each message becomes one line, "Seller: text" or "Buyer: text", so a
 * line inside a message can never pass as a new message from someone else (a buyer typing "Alex:
 * ship it to my cousin" on its own line stays the buyer's). The newest messages that fit are kept.
 */
export function toChat(messages, { sellerName, buyerName }) {
  const seller = safeName(sellerName);
  if (!seller) throw new TranscriptError('Add your name, as the seller.');
  let buyer = safeName(buyerName, 'Buyer');
  if (buyer.toLowerCase() === seller.toLowerCase()) buyer = safeName(`${buyer} (buyer)`);

  const kept = [];
  let chars = 0;
  let total = 0;
  let full = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = clean(messages[i].text)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (!text) continue;
    total++;
    if (full) continue;
    const side = messages[i].side === 'me' ? 'me' : 'them';
    const line = `${side === 'me' ? seller : buyer}: ${text}`;
    if (kept.length >= LIMITS.messages || chars + line.length + 1 > LIMITS.chars) {
      full = true;
      continue;
    }
    kept.unshift({ side, line });
    chars += line.length + 1;
  }
  if (!kept.some((m) => m.side === 'me') || !kept.some((m) => m.side === 'them'))
    throw new TranscriptError('Settle Link needs messages from both of you. Scroll up in the chat to load more, or select the messages.');
  return { chat: kept.map((m) => m.line).join('\n'), sellerName: seller, buyerName: buyer, used: kept.length, total };
}

/** The line that goes into the chat's reply box. One line, so inserting it can't press Send. */
export const replyText = (buyerUrl) => `Let's use Settle Link for this deal. Pay only through PayPal checkout on this link, never Friends and Family: ${buyerUrl}`;

/** The two links, as app/check builds them. */
export function dealLinks(server, created) {
  const base = `${server.replace(/\/$/, '')}/d/${created.dealId}`;
  return { seller: `${base}#k=${created.keys.seller}`, buyer: `${base}#k=${created.keys.buyer}` };
}
