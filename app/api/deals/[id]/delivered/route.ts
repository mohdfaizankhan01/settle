import { api, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';
import { markDelivered } from '@/lib/settle/shipping';

// The seller records the delivery date the carrier shows (Settle can't see carriers).
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/delivered'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    await markDelivered(id, linkKey(request), str(body.date, 'date'), { store: getStore() });
    return { ok: true };
  });
}
