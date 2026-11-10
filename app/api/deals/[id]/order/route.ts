import { DealError } from '@/lib/settle/deals';
import { startCheckout } from '@/lib/settle/checkout';
import { api, rateLimited, getStore, linkKey, publicHost } from '@/lib/settle/runtime';

// Creates the PayPal order from the locked card. The browser sends nothing about the amount.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/order'>) {
  const { id } = await ctx.params;
  // x-settle-payer: meet-up deals only, the secret this device got when it first started checkout.
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    return startCheckout(id, linkKey(request), { store: getStore(), publicHost: publicHost(request) }, request.headers.get('x-settle-payer'));
  });
}
