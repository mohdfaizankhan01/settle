import { DealError, removeClaim } from '@/lib/settle/deals';
import { api, getStore, jsonBody, linkKey, rateLimited } from '@/lib/settle/runtime';

// Either side marks one thing the seller said as "not part of the deal" (PLAN M8).
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/claims'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const body = await jsonBody(request);
    if (typeof body.index !== 'number') throw new DealError('index must be a number');
    await removeClaim(id, linkKey(request), body.index, { store: getStore() });
    return { ok: true };
  });
}
