import { DealError } from '@/lib/settle/deals';
import { api, rateLimited, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';
import { markDelivered } from '@/lib/settle/shipping';

// The seller records the delivery date the carrier shows (Settle can't see carriers).
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/delivered'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const body = await jsonBody(request);
    await markDelivered(id, linkKey(request), str(body.date, 'date'), { store: getStore() });
    return { ok: true };
  });
}
