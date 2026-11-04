import { defineConfig } from '@playwright/test';

// End-to-end check of the judge path (PLAN M5 done-when). Runs against the deployed app by
// default; SETTLE_E2E_URL=http://localhost:3000 runs it locally. Judge mode never reaches PayPal.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.SETTLE_E2E_URL ?? 'https://settle-ulya.onrender.com',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
});
