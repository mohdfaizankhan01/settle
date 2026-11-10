import { DealError, recheckDeal } from '@/lib/settle/deals';
import { api, requireLink, getStore, linkKey, rateLimited, readerForRequest } from '@/lib/settle/runtime';

// Re-runs a failed warning check. Each call runs Jev once, so it is rate-limited.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/recheck'>) {
  const { id } = await ctx.params;
  return api(async () => {
    await requireLink(id, request);
    if (rateLimited(request, 'recheck', 20, 300)) throw new DealError('too many checks; try again later', 400);
    await recheckDeal(id, linkKey(request), { store: getStore(), reader: readerForRequest(request) });
    return { ok: true };
  });
}
