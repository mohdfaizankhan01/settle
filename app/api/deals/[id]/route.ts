import { claimLink, DealError, roleFor } from '@/lib/settle/deals';
import { maybeRefreshDisputes } from '@/lib/settle/disputes';
import { releaseExpiredHold, resolveInFlight } from '@/lib/settle/handover';
import { refreshMemory } from '@/lib/settle/memory';
import { maybeRefreshOnLoad } from '@/lib/settle/payment';
import { api, getStore, linkKey } from '@/lib/settle/runtime';
import { dealView } from '@/lib/settle/view';

export async function GET(request: Request, ctx: RouteContext<'/api/deals/[id]'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const stored = await getStore().getDeal(id);
    if (!stored) throw new DealError('no such deal', 404);
    const role = roleFor(stored.value, linkKey(request));
    if (!role) throw new DealError('this link is not valid for the deal', 403);
    // First open on a device: the link is claimed by it and only works there from now on.
    const claim = await claimLink(id, linkKey(request), { store: getStore() });
    // Missed-webhook fallback: re-reads PayPal (at most once a minute per deal) while payment
    // isn't confirmed. Only for a valid link, so strangers can't make us call PayPal.
    let deal = await maybeRefreshOnLoad(stored.value, { store: getStore() });
    deal = await maybeRefreshDisputes(deal, { store: getStore() });
    // Meet-up deals: settle a capture or void whose answer was lost, from PayPal's own state.
    deal = await resolveInFlight(deal, { store: getStore() });
    // Meet-up deals: a hold past PayPal's 3-day guarantee without a handover is released.
    deal = await releaseExpiredHold(deal, { store: getStore() });
    // Scam memory: has another deal reported this deal's PayPal account, postcode or script?
    deal = await refreshMemory(deal, { store: getStore() });
    const view = dealView(deal, role, await getStore().listReceipts(id));
    // Sent once, to the device that claimed the link; the browser keeps it and sends it back.
    return claim ? { ...view, claim } : view;
  });
}
