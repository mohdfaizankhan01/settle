import { DealError, roleFor } from '@/lib/settle/deals';
import { maybeRefreshDisputes } from '@/lib/settle/disputes';
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
    // Missed-webhook fallback: re-reads PayPal (at most once a minute per deal) while payment
    // isn't confirmed. Only for a valid link, so strangers can't make us call PayPal.
    let deal = await maybeRefreshOnLoad(stored.value, { store: getStore() });
    deal = await maybeRefreshDisputes(deal, { store: getStore() });
    return dealView(deal, role, role === 'seller' && deal.disputes?.length ? await getStore().listReceipts(id) : []);
  });
}
