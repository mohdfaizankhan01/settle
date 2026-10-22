// Seller connect (D1, DECISIONS #12): the seller onboards through Partner Referrals with a
// tracking ID we generate, and the payee is the merchant ID PayPal reports for that tracking ID.
// Nothing PayPal appends to the return URL is trusted. The payee is set only once PayPal says
// the seller granted our app access and can receive payments.

import { randomBytes } from 'node:crypto';
import * as paypal from '../paypal';
import { DealError, roleFor, setPayee } from './deals';
import { StaleWriteError, type DealStore } from './store';

export type ConnectPayPal = Pick<typeof paypal, 'createPartnerReferral' | 'sellerByTrackingId'>;
export type ConnectDeps = { store: DealStore; paypal?: ConnectPayPal; publicHost: string; now?: () => Date };

const now = (deps: ConnectDeps) => (deps.now ?? (() => new Date()))().toISOString();

export async function startConnect(dealId: string, key: string | null, deps: ConnectDeps) {
  const pp = deps.paypal ?? paypal;
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (roleFor(stored.value, key) !== 'seller') throw new DealError('only the seller connects a PayPal account', 403);

  const trackingId = randomBytes(18).toString('base64url');
  const startedAt = now(deps);
  await deps.store.saveSellerLink({ trackingId, dealId, createdAt: startedAt });
  const referral = await pp.createPartnerReferral(trackingId, `${deps.publicHost}/api/paypal/onboarded?t=${trackingId}`);
  try {
    await deps.store.updateDeal(dealId, stored.version, { ...stored.value, connect: { trackingId, startedAt } });
  } catch (error) {
    if (error instanceof StaleWriteError) throw new DealError('the deal changed; try again', 409);
    throw error;
  }
  await deps.store.addReceipt({ dealId, kind: 'payee.connect_started', at: startedAt, data: { debugId: referral.debugId ?? null } });
  return { actionUrl: referral.data.actionUrl };
}

export type ConnectResult = { dealId: string; connected: boolean; reason?: string };

/** Checks with PayPal whether the seller finished onboarding for `trackingId`. Safe to repeat. */
export async function finishConnect(trackingId: string, deps: ConnectDeps): Promise<ConnectResult> {
  const pp = deps.paypal ?? paypal;
  const link = await deps.store.getSellerLink(trackingId);
  if (!link) throw new DealError('unknown onboarding link', 404);
  // Only the seller's latest attempt counts; links from earlier attempts are dead.
  const deal = await deps.store.getDeal(link.dealId);
  if (!deal || deal.value.connect?.trackingId !== trackingId) throw new DealError('this onboarding link was replaced by a newer one', 404);
  const seller = await pp.sellerByTrackingId(trackingId);
  if (!seller) return { dealId: link.dealId, connected: false, reason: 'PayPal has not finished connecting this account yet.' };
  const missing = [
    !seller.granted && 'access for Settle was not granted',
    !seller.paymentsReceivable && 'the account cannot receive payments yet',
    !seller.primaryEmailConfirmed && 'the account email is not confirmed',
  ].filter(Boolean);
  if (missing.length > 0) return { dealId: link.dealId, connected: false, reason: `PayPal says ${missing.join(', ')}.` };

  await deps.store.saveSellerLink({ ...link, merchantId: seller.merchantId });
  await setPayee(link.dealId, seller.merchantId, { store: deps.store, now: deps.now });
  return { dealId: link.dealId, connected: true };
}

/** The deal page's "check again" button: finishes the seller's latest attempt, if any. */
export async function checkConnect(dealId: string, key: string | null, deps: ConnectDeps): Promise<ConnectResult> {
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  if (roleFor(stored.value, key) !== 'seller') throw new DealError('only the seller connects a PayPal account', 403);
  if (!stored.value.connect) return { dealId, connected: !!stored.value.payeeMerchantId };
  return finishConnect(stored.value.connect.trackingId, deps);
}
