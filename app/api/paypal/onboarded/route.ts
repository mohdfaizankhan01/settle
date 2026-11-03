import { finishConnect } from '@/lib/settle/connect';
import { DealError, PAYEE_LOCKED } from '@/lib/settle/deals';
import { getStore, publicHost } from '@/lib/settle/runtime';

// PayPal sends the seller back here after onboarding. Only our own tracking ID (`t`) is used:
// the merchant ID is read back from PayPal, never taken from the query string.
export async function GET(request: Request) {
  const host = publicHost(request);
  const t = new URL(request.url).searchParams.get('t');
  let outcome = 'error';
  try {
    if (t) outcome = (await finishConnect(t, { store: getStore(), publicHost: host })).connected ? 'connected' : 'pending';
  } catch (error) {
    // The payee is fixed once payment starts; a stale write is worth retrying; anything else
    // we know of means the tracking link is stale.
    outcome = !(error instanceof DealError) ? 'error' : error.message === PAYEE_LOCKED ? 'locked' : error.status === 409 ? 'error' : 'unknown';
  }
  return Response.redirect(`${host}/connected?status=${outcome}`, 303);
}
