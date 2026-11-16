import { expect, test, type Page } from '@playwright/test';

// Live updates (Part B): when one side acts, the other side's page changes within seconds, not on
// the next poll. Judge mode puts both sides on one page, each with its own stream. Nothing here
// reaches PayPal.

const pane = (page: Page, who: 'Buyer' | 'Seller') => page.locator('div').filter({ has: page.getByRole('heading', { name: `${who}'s view`, exact: true }) }).last();
const FEE = /The seller \(taken from what they receive\)/;

async function openFeeDeal(page: Page) {
  await page.goto('/demo');
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: /Buyer warned about Friends and Family/ }).click();
  await expect(pane(page, 'Seller').getByRole('button', { name: FEE })).toBeVisible();
}

test('the other side sees a change within seconds, with the stream open', async ({ page }) => {
  await openFeeDeal(page);
  // Each pane opens its own stream and says so.
  await expect(pane(page, 'Seller').getByText(/Updates: live/)).toBeVisible({ timeout: 15_000 });
  await expect(pane(page, 'Buyer').getByText(/Updates: live/)).toBeVisible({ timeout: 15_000 });

  await pane(page, 'Seller').getByRole('button', { name: FEE }).click();
  await expect(pane(page, 'Seller').getByText(/Waiting for the buyer to answer too/)).toBeVisible();
  // The buyer answers on their own page. While the stream is open the page only polls every 30 s,
  // so seeing the seller's pane change within 5 s can only come from the stream.
  await pane(page, 'Buyer').getByRole('button', { name: FEE }).click();
  await expect(pane(page, 'Seller').getByText(/You both answered/)).toBeVisible({ timeout: 5_000 });
  await expect(pane(page, 'Seller').getByText(/PayPal's fee paid by/)).toBeVisible();
});

test('without the stream the page says so and still catches up on its 10 s poll', async ({ page }) => {
  await page.route('**/api/deals/*/watch', (route) => route.abort());
  await openFeeDeal(page);
  await expect(pane(page, 'Seller').getByText(/Updates: checking every 10 seconds/)).toBeVisible({ timeout: 15_000 });
  await expect(pane(page, 'Seller').getByText(/Updates: live/)).toHaveCount(0);

  await pane(page, 'Seller').getByRole('button', { name: FEE }).click();
  await pane(page, 'Buyer').getByRole('button', { name: FEE }).click();
  await expect(pane(page, 'Seller').getByText(/You both answered/)).toBeVisible({ timeout: 14_000 });
});
