import { DealError } from '@/lib/settle/deals';
import { startConnect } from '@/lib/settle/connect';
import { api, limitedKey, requireLink, rateLimited, getStore, linkKey, publicHost } from '@/lib/settle/runtime';

// Starts PayPal seller onboarding (Partner Referrals) and returns PayPal's URL.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/connect'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const role = await requireLink(id, request);
    if (role !== 'seller') throw new DealError('only the seller connects a PayPal account', 403); // per-deal limits only for holders of a working link, per side
    if (limitedKey(`connect:${id}:${role}`, 6)) throw new DealError('too many onboarding attempts for this deal; try again in an hour', 400);
    return startConnect(id, linkKey(request), { store: getStore(), publicHost: publicHost(request) });
  });
}
