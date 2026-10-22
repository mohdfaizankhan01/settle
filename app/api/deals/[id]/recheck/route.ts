import { DealError, recheckDeal } from '@/lib/settle/deals';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';

// Re-runs a failed warning check. Each call runs Jev once, so it is rate-limited.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/recheck'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'recheck', 20, 300)) throw new DealError('too many checks; try again later', 400);
    await recheckDeal(id, linkKey(request), { store: getStore() });
    return { ok: true };
  });
}
