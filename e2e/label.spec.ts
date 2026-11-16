import { expect, test, type Page } from '@playwright/test';

// The label photo (Part B): in judge mode the photo reader is never called, so the page says so
// and the seller types the postcode as before. Nothing reaches PayPal or a vision model.

const pane = (page: Page, who: 'Buyer' | 'Seller') => page.locator('div').filter({ has: page.getByRole('heading', { name: `${who}'s view`, exact: true }) }).last();
// A valid 1x1 PNG: the browser can decode and shrink it, so the request reaches the server.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('a label photo in judge mode says the reader is not used, fills nothing and submits nothing', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: /Paid and ready to ship/ }).click();
  const seller = pane(page, 'Seller');
  await expect(seller.getByText('Or read it from a photo of the label')).toBeVisible();
  await expect(seller.getByText(/not kept by Settle Link/)).toBeVisible();

  const box = seller.getByLabel(/on your shipping label/);
  const before = await box.inputValue();
  await seller.getByLabel('Or read it from a photo of the label').setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: PNG });
  await expect(seller.getByText(/Couldn't use that photo: Judge mode reads only the sample label, so nothing is sent; type the postcode instead/)).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue(before, { timeout: 1_000 });
  // The sample label replays its recorded reading into the box; the seller still presses Compare.
  await seller.getByRole('button', { name: 'Try the sample label' }).click();
  await expect(seller.getByText(/The photo says 95131\. Check it against your label, then press Compare\. Judge mode: a reading recorded on .* replayed; nothing was sent\./)).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue('95131');
  // Typing still works, as before.
  await box.fill('95131');
  await seller.getByRole('button', { name: 'Compare' }).click();
  await expect(seller.getByText(/History of this deal/)).toBeVisible();
});
