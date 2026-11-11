// npm run shots — six README screenshots from judge mode (demo data only, nothing reaches PayPal),
// 1280 px wide, JPEG, each under 400 KB, into docs/screenshots/. Runs against the deployed app;
// SETTLE_SHOTS_URL=http://localhost:3000 uses a local dev server instead.

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Locator, type Page } from '@playwright/test';

const BASE = process.env.SETTLE_SHOTS_URL ?? 'https://settle-ulya.onrender.com';
const OUT = 'docs/screenshots';
const WIDTH = 1280;
/** Tallest image, in output pixels. */
const MAX_HEIGHT = 1400;
const MAX_BYTES = 400 * 1024;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
// Captured at 2x, then scaled to 1280 px wide in a second page, so a narrow area stays sharp.
// Reduced motion and finished animations: nothing caught mid-entrance.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
const scaler = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1 });

/**
 * Saves part of the page: across `area` (its full width), from `above` px above `focus` (or the
 * area's top), `height` px tall. Scaled to 1280 px wide; JPEG quality drops until it fits 400 KB.
 */
async function save(name: string, area: Locator, opts: { focus?: Locator; above?: number; height?: number } = {}) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const a = (await area.boundingBox())!;
  const f = opts.focus ? (await opts.focus.boundingBox())! : a;
  const y = Math.max(a.y, f.y - (opts.above ?? 0));
  const clip = { x: a.x - 12, y, width: a.width + 24, height: Math.min(opts.height ?? a.y + a.height - y, MAX_HEIGHT * (a.width / WIDTH)) };
  const png = await page.screenshot({ type: 'png', clip, fullPage: true, animations: 'disabled' });
  const height = Math.round((clip.height * WIDTH) / clip.width);
  await scaler.setViewportSize({ width: WIDTH, height });
  await scaler.setContent(`<body style="margin:0"><img style="display:block;width:${WIDTH}px" src="data:image/png;base64,${png.toString('base64')}"></body>`);
  await scaler.locator('img').evaluate((img: HTMLImageElement) => img.decode());
  for (let quality = 85; quality >= 40; quality -= 5) {
    const buf = await scaler.screenshot({ type: 'jpeg', quality });
    if (buf.length <= MAX_BYTES) {
      writeFileSync(`${OUT}/${name}.jpg`, buf);
      console.log(`${name}.jpg  ${WIDTH}x${height}  ${Math.round(buf.length / 1024)} KB  quality ${quality}`);
      return;
    }
  }
  throw new Error(`${name}: over 400 KB even at quality 40`);
}

const pane = (p: Page, who: 'Buyer' | 'Seller') => p.locator('div').filter({ has: p.getByRole('heading', { name: `${who}'s view`, exact: true }) }).last();

/** Opens a demo deal and waits until both sides have loaded. */
async function openDeal(p: Page, title: string) {
  await p.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: new RegExp(title) }).click();
  const region = p.getByRole('region', { name: title });
  await region.waitFor();
  await region.getByText('Loading the deal').first().waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
  await p.waitForTimeout(500);
  return region;
}


try {
  await page.goto(`${BASE}/demo`);
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button').nth(7).waitFor({ timeout: 120_000 });

  const deals = (await openDeal(page, 'Seller warned about a fake payment email')).locator('div.grid').first();
  const fake = pane(page, 'Seller').getByText('"PayPal is holding your money" story');
  await fake.waitFor();
  await save('1-deal-card-warning', deals, { focus: pane(page, 'Seller').getByText(/^\d+ warnings? for you$/), above: 120, height: 900 });

  // One side at full width: below 1024 px judge mode shows a tab per side.
  await page.setViewportSize({ width: 1000, height: 900 });
  const sellerTab = async () => page.getByRole('tab', { name: "Seller's view" }).click();
  await openDeal(page, 'Paid, then HOLD after an address change');
  await sellerTab();
  const hold = pane(page, 'Seller').getByRole('heading', { name: "Hold: don't ship yet" });
  await hold.waitFor();
  await save('2-ship-gate-hold', pane(page, 'Seller'), { focus: hold, above: 40, height: 1000 });

  await openDeal(page, 'A dispute with its evidence pack');
  await sellerTab();
  const dispute = pane(page, 'Seller').getByText(/Settle's advice: answer with your evidence/);
  await dispute.waitFor();
  await save('3-dispute-case-file', pane(page, 'Seller'), { focus: dispute, above: 560, height: 1000 });

  await openDeal(page, 'Meet-up: PayPal holds the money until the handover');
  await sellerTab();
  await pane(page, 'Seller').getByRole('button', { name: 'Show handover code' }).click();
  const qr = pane(page, 'Seller').getByRole('img', { name: 'Handover code for the buyer to scan' });
  await qr.waitFor();
  await save('4-meetup-handover-qr', pane(page, 'Seller'), { focus: qr, above: 420, height: 1000 });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/proof`);
  await page.getByRole('heading', { name: 'How often the warning check is right' }).waitFor();
  await save('5-proof', page.locator('main'), { height: 1100 });

  await page.goto(`${BASE}/demo/attacks`);
  await page.getByRole('button', { name: 'Run the attacks' }).click();
  await page.getByRole('status').filter({ hasText: /of 10 stopped/ }).waitFor({ timeout: 120_000 });
  await save('6-attacks-after-run', page.locator('main'), { height: 1100 });
} finally {
  await browser.close();
}
