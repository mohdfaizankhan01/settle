import { startConnect } from '@/lib/settle/connect';
import { api, getStore, linkKey, publicHost } from '@/lib/settle/runtime';

// Starts PayPal seller onboarding (Partner Referrals) and returns PayPal's URL.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/connect'>) {
  const { id } = await ctx.params;
  return api(() => startConnect(id, linkKey(request), { store: getStore(), publicHost: publicHost(request) }));
}
