import { expect, test, type Page } from '@playwright/test';

// The judge path, start to finish, on the real app: judge mode, each deal state from both sides,
// a dispute response approved and sent (replayed, never to PayPal), the seller timeline, the
// attack lab and the proof page.

async function openDeal(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('region', { name: title })).toBeVisible();
}

const pane = (page: Page, who: 'Buyer' | 'Seller') => page.locator('div').filter({ has: page.getByRole('heading', { name: `${who}'s view`, exact: true }) }).last();

test('a judge walks from the home page through every deal state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('One link to settle a deal made in a DM');
  await page.getByRole('link', { name: 'Try it in judge mode' }).click();
  await expect(page).toHaveURL(/\/demo$/);

  // A fresh private session with eight demo deals.
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });

  // 1. The buyer is warned about Friends and Family, and every pane says what is real.
  await openDeal(page, 'Buyer warned about Friends and Family');
  const buyer = pane(page, 'Buyer');
  await expect(buyer.getByText('Judge mode (demo deal).')).toBeVisible();
  await expect(buyer.getByText(/Warning check: ran/)).toBeVisible();
  await expect(buyer.getByText('The seller suggested paying as Friends and Family')).toBeVisible();
  await expect(buyer.getByText(/If the seller insists on Friends and Family, stop the deal/)).toBeVisible();

  // 2. The seller is warned about a fake payment email.
  await openDeal(page, 'Seller warned about a fake payment email');
  await expect(pane(page, 'Seller').getByText('"PayPal is holding your money" story')).toBeVisible();
  // Scam memory: the same script was reported by two earlier (seeded) deals.
  await expect(pane(page, 'Seller').getByText('This message was reported before')).toBeVisible();
  await expect(pane(page, 'Seller').getByText(/seeded demo data/)).toBeVisible();

  // 3. Confirmed and waiting: judge mode never takes a payment.
  await openDeal(page, 'Confirmed, waiting for payment');
  await expect(pane(page, 'Buyer').getByText(/Judge mode never takes a payment/)).toBeVisible();

  // 3b. Code and the AI reader disagree on the price (recorded reading): both people answer.
  await openDeal(page, 'Code and the AI reader disagree on the price');
  await expect(pane(page, 'Seller').getByText(/Code read \$15\.00 .*the AI reader read \$900\.00/)).toBeVisible();
  await expect(pane(page, 'Seller').getByText(/Reading recorded on/)).toBeVisible();
  await expect(pane(page, 'Seller').getByText('What the seller said about it')).toBeVisible();

  // 4. Paid and ready to ship.
  await openDeal(page, 'Paid and ready to ship');
  await expect(pane(page, 'Seller').getByRole('heading', { name: 'Ready to ship to the PayPal address' })).toBeVisible();

  // 5. HOLD after the buyer asks to ship to a cousin.
  await openDeal(page, 'Paid, then HOLD after an address change');
  const holdSeller = pane(page, 'Seller');
  await expect(holdSeller.getByRole('heading', { name: "Hold: don't ship yet" })).toBeVisible();
  await expect(holdSeller.getByText(/asks to ship somewhere else/).first()).toBeVisible();

  // 6. Meet-up: PayPal holds the money; the seller shows a code; the buyer's scan releases it.
  await openDeal(page, 'Meet-up: PayPal holds the money until the handover');
  const meetSeller = pane(page, 'Seller');
  await expect(meetSeller.getByRole('heading', { name: 'PayPal holds $380.00' })).toBeVisible();
  await meetSeller.getByRole('button', { name: 'Show handover code' }).click();
  await expect(meetSeller.getByRole('img', { name: 'Handover code for the buyer to scan' })).toBeVisible();
  const scanUrl = await meetSeller.getByRole('link', { name: 'open the scan as the buyer' }).getAttribute('href');
  const scan = await page.context().newPage();
  await scan.goto(scanUrl!);
  await scan.getByRole('button', { name: /I've checked it: pay \$380\.00/ }).click();
  await expect(scan.getByText('Payment sent through PayPal')).toBeVisible();
  await scan.close();
  await page.reload();
  await openDeal(page, 'Meet-up: PayPal holds the money until the handover');
  await expect(pane(page, 'Seller').getByRole('heading', { name: 'Handed over' })).toBeVisible({ timeout: 30_000 });

  // 7. A dispute: case file, advice, the exact request, then approve and send (replayed).
  await openDeal(page, 'A dispute with its evidence pack');
  const seller = pane(page, 'Seller');
  await expect(seller.getByText(/Settle's advice: answer with your evidence/)).toBeVisible();
  await expect(seller.getByText(/Proof on file: .* = 8 of 8/)).toBeVisible();
  await seller.getByRole('button', { name: 'Review the request' }).click();
  await expect(seller.getByText('This is exactly what Settle will send to PayPal, as you:')).toBeVisible();
  await expect(seller.getByText(/POST https:\/\/api-m\.sandbox\.paypal\.com\/v1\/customer\/disputes\//)).toBeVisible();
  await seller.getByRole('button', { name: 'Approve and send to PayPal' }).click();
  await expect(seller.getByText(/provide supporting info: sent.*PayPal debug ID rec-/)).toBeVisible();

  // The deal's history verifies.
  await seller.getByText(/History of this deal/).click();
  await expect(seller.getByText('record verifies')).toBeVisible();
});

test('the seller timeline, the attack lab and the proof page', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });

  await page.getByRole('link', { name: 'Seller timeline' }).click();
  await expect(page.getByRole('heading', { name: 'Seller timeline' })).toBeVisible();
  // Bryntum draws the events; some sit outside the scrolled view, so count them rather than check one.
  await expect(page.locator('.b-sch-event-wrap')).not.toHaveCount(0);
  await expect(page.getByText('Asked to pay as Friends and Family').first()).toBeVisible();
  // The item's name is the AI reader's exact words when code and the reader agree (PLAN M8).
  await expect(page.getByText('Sony A7 III', { exact: true })).toBeVisible();

  await page.goto('/demo/attacks');
  await page.getByRole('button', { name: 'Run the attacks' }).click();
  await expect(page.getByRole('status')).toContainText('10 of 10 stopped', { timeout: 90_000 });

  await page.goto('/proof');
  await expect(page.getByRole('heading', { name: 'How often the warning check is right' })).toBeVisible();
  await expect(page.getByText(/was not run/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Against a general LLM' })).toBeVisible();
});
