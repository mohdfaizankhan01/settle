import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// /verify, start to finish: a judge-mode seller downloads the signed record (and the evidence pack
// it covers), the /verify page checks both in the browser, and a record changed by one receipt
// does not check out. Judge mode never reaches PayPal.

async function openDispute(page: Page) {
  await page.goto('/demo');
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: /A dispute with its evidence pack/ }).click();
  await expect(page.getByRole('region', { name: 'A dispute with its evidence pack' })).toBeVisible();
  // Below 1024 px judge mode shows one side at a time; the seller's pane has the dispute.
  const seller = page.locator('div').filter({ has: page.getByRole('heading', { name: "Seller's view", exact: true }) }).last();
  await expect(seller.getByRole('region', { name: 'Dispute' }).getByRole('button', { name: 'Download signed record' })).toBeVisible();
  return seller;
}

test('a signed record and its evidence pack verify on /verify, and a changed record does not', async ({ page }, info) => {
  const seller = await openDispute(page);

  const dispute = seller.getByRole('region', { name: 'Dispute' });
  const history = seller.locator('details').filter({ hasText: 'History of this deal' });

  // From the history: the whole receipt chain, no PDF.
  await history.getByText(/History of this deal/).click();
  const [recordDownload] = await Promise.all([page.waitForEvent('download'), history.getByRole('button', { name: 'Download signed record' }).click()]);
  const recordPath = info.outputPath('record.json');
  await recordDownload.saveAs(recordPath);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  expect(record.format).toBe('settle-link-record/1');
  expect(record.body.demo).toBe(true);
  expect(record.body.pdf).toBeNull();

  // From the dispute panel: the same chain, plus the hash of the evidence PDF.
  const [packDownload] = await Promise.all([page.waitForEvent('download'), dispute.getByRole('button', { name: 'Download evidence pack' }).click()]);
  const pdfPath = info.outputPath('evidence.pdf');
  await packDownload.saveAs(pdfPath);
  const [coversDispute] = await Promise.all([page.waitForEvent('download'), dispute.getByRole('button', { name: 'Download signed record' }).click()]);
  const coversPath = info.outputPath('record-with-pdf.json');
  await coversDispute.saveAs(coversPath);
  const covers = JSON.parse(readFileSync(coversPath, 'utf8'));
  expect(covers.body.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);

  await page.goto('/verify');
  await expect(page.getByRole('heading', { name: 'Verify a record' })).toBeVisible();
  await page.getByLabel('Signed record (.json)').setInputFiles(coversPath);
  await page.getByLabel(/Evidence PDF/).setInputFiles(pdfPath);
  await page.getByRole('button', { name: 'Check the record' }).click();
  await expect(page.getByRole('heading', { name: 'This record checks out: unchanged since it was signed' })).toBeVisible();
  await expect(page.getByText('The signature matches this exact record.')).toBeVisible();
  await expect(page.getByText(/This PDF is the one the record covers/)).toBeVisible();
  await expect(page.getByText(/Judge-mode demo record/)).toBeVisible();

  // One receipt changed: the signature and the chain both fail.
  covers.body.receipts[1].data = { ...covers.body.receipts[1].data, changed: true };
  const badPath = info.outputPath('record-changed.json');
  writeFileSync(badPath, JSON.stringify(covers));
  await page.getByLabel('Signed record (.json)').setInputFiles(badPath);
  await page.getByRole('button', { name: 'Check the record' }).click();
  await expect(page.getByRole('heading', { name: 'This record does not check out' })).toBeVisible();
  await expect(page.getByText(/The receipt chain is broken at receipt 1/)).toBeVisible();
  await expect(page.getByText(/The signature does not match this record/)).toBeVisible();

  // A different PDF than the one the record names is refused.
  writeFileSync(info.outputPath('other.pdf'), '%PDF-1.4 not the evidence pack');
  await page.getByLabel('Signed record (.json)').setInputFiles(coversPath);
  await page.getByLabel(/Evidence PDF/).setInputFiles(info.outputPath('other.pdf'));
  await page.getByRole('button', { name: 'Check the record' }).click();
  await expect(page.getByRole('heading', { name: 'This record does not check out' })).toBeVisible();
  await expect(page.getByText(/This PDF is not the one the record covers/)).toBeVisible();

  // Not a record at all.
  writeFileSync(info.outputPath('nonsense.json'), '{"hello":"world"}');
  await page.getByLabel('Signed record (.json)').setInputFiles(info.outputPath('nonsense.json'));
  await page.getByLabel(/Evidence PDF/).setInputFiles([]);
  await page.getByRole('button', { name: 'Check the record' }).click();
  await expect(page.getByText('Not a settle-link-record/1 record.')).toBeVisible();

  // The public key list is served at the conventional path.
  const keys = await (await page.request.get('/.well-known/settle-link-key.json')).json();
  expect(keys.keys.some((k: { kind: string }) => k.kind === 'demo')).toBe(true);
  expect(JSON.stringify(keys)).not.toMatch(/privateKey|seed|SETTLE_SIGNING_KEY/i);
});

test('only the seller is offered the signed record, and the link without a key is refused', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: /Start judge mode|Start over with fresh deals/ }).click();
  await expect(page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button')).toHaveCount(8, { timeout: 90_000 });
  await page.getByRole('navigation', { name: 'Demo deals' }).getByRole('button', { name: /A dispute with its evidence pack/ }).click();
  const buyer = page.locator('div').filter({ has: page.getByRole('heading', { name: "Buyer's view", exact: true }) }).last();
  await expect(buyer.getByText(/History of this deal/)).toBeVisible();
  await expect(buyer.getByRole('button', { name: 'Download signed record' })).toHaveCount(0);
  const res = await page.request.get('/api/deals/00000000-0000-0000-0000-000000000000/record');
  expect(res.status()).toBe(404);
});
