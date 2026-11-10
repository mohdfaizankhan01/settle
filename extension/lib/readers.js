// Functions Chrome runs inside the chat tab, only after the seller clicks the toolbar button
// (chrome.scripting.executeScript with activeTab). Chrome sends each function's source on its own,
// so each must be self-contained: no imports and nothing from outside its own body.
// e2e/extension-readers.spec.ts runs them against saved chat pages.

/**
 * Reads the open chat. Returns { reader, title, messages: [{ side?, name?, text }] } or
 * { reader: 'none' }. Selected text wins, since the seller chose it; then the site's own reader.
 * Only messages already loaded on the page are read: nothing scrolls or clicks.
 */
export function readChat() {
  const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
  const clean = (s) => String(s ?? '').replace(INVISIBLE, '').replace(/\r/g, '').trim();
  const MAX_ROWS = 400;

  const selection = clean(String(window.getSelection?.() ?? ''));
  if (selection) return { reader: 'selection', title: clean(document.title), text: selection.slice(-40_000) };

  // WhatsApp Web: each message carries "[time, date] Sender: " and sits in .message-out (yours) or
  // .message-in, so who said what is exact.
  if (location.hostname === 'web.whatsapp.com') {
    const main = document.querySelector('#main');
    if (!main) return { reader: 'none', why: 'Open a chat in WhatsApp Web first.' };
    const header = main.querySelector('header');
    const title = clean(header?.querySelector('span[title]')?.getAttribute('title') ?? header?.querySelector('span[dir="auto"]')?.textContent ?? '');
    const nodes = [...main.querySelectorAll('[data-pre-plain-text]')].slice(-MAX_ROWS);
    const messages = [];
    for (const node of nodes) {
      const text = clean((node.querySelector('.selectable-text') ?? node).innerText);
      if (!text) continue; // photos, stickers and voice notes have no text
      messages.push({ side: node.closest('.message-out') ? 'me' : 'them', pre: node.getAttribute('data-pre-plain-text') ?? '', text });
    }
    return { reader: 'whatsapp', title, messages };
  }

  // Other web chats (Messenger, Facebook Marketplace, Instagram): rows of the conversation, with
  // your bubbles on the right. The popup shows the result so the seller can check and swap sides.
  const root = document.querySelector('[role="main"]') ?? document.body;
  const rows = [...root.querySelectorAll('[role="row"]')].slice(-MAX_ROWS);
  if (rows.length === 0) return { reader: 'none', why: 'No chat found on this page. Select the messages you want, then click Settle Link again.' };
  const box = root.getBoundingClientRect();
  const mid = box.left + box.width / 2;
  const margin = box.width * 0.05;
  const NOISE = /^(?:\d{1,2}[:.]\d{2}(?:\s?[AaPp][Mm])?|you sent|sent|seen|delivered|edited|enter|you replied|replied to .{0,40})$/i;
  const title = clean(root.querySelector('h1, h2')?.textContent ?? document.title);
  const messages = [];
  for (const row of rows) {
    const text = clean(row.innerText)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l))
      .join('\n');
    if (!text || text.length > 4000) continue;
    // Where the row's words sit: the left and right edges of its visible text.
    let left = Infinity;
    let right = -Infinity;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width === 0) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
    }
    if (!Number.isFinite(left)) continue;
    const centre = (left + right) / 2;
    // Centred rows are dates and notices, not messages.
    const side = centre > mid + margin ? 'me' : centre < mid - margin ? 'them' : null;
    if (side) messages.push({ side, text });
  }
  return { reader: 'layout', title, messages };
}

/**
 * Puts the text into the chat's reply box without sending it: the seller presses Send. Returns
 * { ok: true } or { ok: false } when there's no reply box (the popup copies the text instead).
 */
export function insertReply(text) {
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const editable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA');
  let box = null;
  if (location.hostname === 'web.whatsapp.com') box = document.querySelector('#main footer [contenteditable="true"]');
  if (!visible(box) && editable(document.activeElement)) box = document.activeElement;
  if (!visible(box)) {
    const boxes = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')].filter(visible);
    box = boxes[boxes.length - 1] ?? null;
  }
  if (!box) return { ok: false };
  box.focus();
  if (box.tagName === 'TEXTAREA') {
    box.setRangeText(text, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }
  // Chat editors listen for real input events; insertText is how a paste or typing arrives.
  const ok = document.execCommand('insertText', false, text);
  return { ok };
}
