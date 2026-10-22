import { startCheckout } from '@/lib/settle/checkout';
import { api, getStore, linkKey, publicHost } from '@/lib/settle/runtime';

// Creates the PayPal order from the locked card. The browser sends nothing about the amount.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/order'>) {
  const { id } = await ctx.params;
  return api(() => startCheckout(id, linkKey(request), { store: getStore(), publicHost: publicHost(request) }));
}
