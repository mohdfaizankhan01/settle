// PayPal's seller fee, estimated in code from docs/fees.md (FEE-US, FEE-UK). All amounts are in
// minor units (cents, pence) so there's no floating-point money. The card calls this an estimate:
// PayPal's own fee on the capture is the real figure (M3).

import type { Country } from './types';

export type FeePayer = 'seller' | 'buyer';

/** Basis points (1/100 of a percent) and fixed fee in minor units. */
export const FEE_RATES: Record<Country, { bp: number; fixedMinor: number; cite: string }> = {
  US: { bp: 349, fixedMinor: 49, cite: 'FEE-US' },
  UK: { bp: 290, fixedMinor: 30, cite: 'FEE-UK' },
};

export const toMinor = (amount: string) => {
  if (!/^\d{1,7}\.\d{2}$/.test(amount)) throw new Error(`bad amount ${amount}`);
  return Number(amount.replace('.', ''));
};
export const fromMinor = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** Estimated fee PayPal takes from a payment of `totalMinor`. */
export function feeOf(totalMinor: number, country: Country): number {
  const { bp, fixedMinor } = FEE_RATES[country];
  return Math.round((totalMinor * bp) / 10_000) + fixedMinor;
}

export type Money = { total: string; fee: string; sellerGets: string };

/**
 * What the buyer pays, the estimated fee and what the seller receives, for an agreed price.
 * When the buyer covers the fee, the total is the smallest amount whose estimated fee leaves the
 * seller at least the agreed price.
 */
export function moneyFor(price: string, payer: FeePayer, country: Country): Money {
  const p = toMinor(price);
  if (payer === 'seller') {
    const fee = feeOf(p, country);
    return { total: fromMinor(p), fee: fromMinor(fee), sellerGets: fromMinor(Math.max(p - fee, 0)) };
  }
  const { bp, fixedMinor } = FEE_RATES[country];
  // What the seller gets (total − fee) never drops as the total rises, so counting up from just
  // below the closed-form estimate finds the smallest total that works.
  let total = Math.max(p, Math.floor(((p + fixedMinor) * 10_000) / (10_000 - bp)) - 2);
  while (total - feeOf(total, country) < p) total++;
  return { total: fromMinor(total), fee: fromMinor(total - p), sellerGets: fromMinor(total - feeOf(total, country)) };
}
