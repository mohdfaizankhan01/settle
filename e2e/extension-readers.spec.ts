import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertReply, readChat } from '../extension/lib/readers.js';

// The extension's chat readers, run in a real browser against sample chat pages (e2e/fixtures).
// Offline: no server and no PayPal. `npx playwright test e2e/extension-readers.spec.ts`.
// The pages are served from each site's own hostname, since the WhatsApp reader keys on it.

type Read = { reader: string; title?: string; text?: string; messages?: { side: string; text: string; pre?: string }[] };

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

async function open(page: import('@playwright/test').Page, url: string, html: string) {
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(url);
}

test('WhatsApp Web: exact sides and senders, media skipped', async ({ page }) => {
  await open(page, 'https://web.whatsapp.com/', fixture('whatsapp.html'));
  const out = (await page.evaluate(readChat)) as Read;
  expect(out.reader).toBe('whatsapp');
  expect(out.title).toBe('Sam Buyer');
  expect(out.messages!.map((m) => [m.side, m.text])).toEqual([
    ['them', 'is the bike still for sale?'],
    ['me', 'yes, £120 and I can post it tracked'],
    ['them', 'deal, can I pay friends and family?'],
  ]);
  expect(out.messages![1].pre).toBe('[10:16, 22/10/2026] Alex Seller: ');
});

test('layout reader: right-hand bubbles are yours; dates, times and "Seen" dropped', async ({ page }) => {
  await open(page, 'https://www.messenger.com/t/1', fixture('messenger.html'));
  const out = (await page.evaluate(readChat)) as Read;
  expect(out.reader).toBe('layout');
  expect(out.title).toBe('Sam Buyer');
  expect(out.messages).toEqual([
    { side: 'them', text: 'Is the lamp available?' },
    { side: 'me', text: 'Yes, $40, pick up or I post it' },
    { side: 'them', text: 'Post please\nto my cousin in Leeds' },
    { side: 'me', text: 'Ok' },
  ]);
});

test('selected text wins over the page reader', async ({ page }) => {
  await open(page, 'https://www.messenger.com/t/1', fixture('messenger.html'));
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelectorAll('.bubble')[0]);
    getSelection()!.addRange(range);
  });
  const out = (await page.evaluate(readChat)) as Read;
  expect(out).toMatchObject({ reader: 'selection', text: 'Is the lamp available?' });
});

test('a page with no chat says so', async ({ page }) => {
  await open(page, 'https://example.com/', '<p>hello</p>');
  expect(await page.evaluate(readChat)).toMatchObject({ reader: 'none' });
});

test('the reply goes into the reply box and is not sent', async ({ page }) => {
  await open(page, 'https://web.whatsapp.com/', fixture('whatsapp.html'));
  let submitted = false;
  await page.exposeFunction('sent', () => (submitted = true));
  await page.evaluate(() => document.addEventListener('keydown', (e) => e.key === 'Enter' && (window as unknown as { sent: () => void }).sent()));
  const text = 'Pay only through PayPal checkout on this link: https://example.test/d/1#k=B';
  expect(await page.evaluate(insertReply, text)).toEqual({ ok: true });
  await expect(page.locator('#main footer [contenteditable]')).toHaveText(text);
  expect(submitted).toBe(false);
});

test('no reply box: the popup is told to copy instead', async ({ page }) => {
  await open(page, 'https://example.com/', '<p>hello</p>');
  expect(await page.evaluate(insertReply, 'x')).toEqual({ ok: false });
});
