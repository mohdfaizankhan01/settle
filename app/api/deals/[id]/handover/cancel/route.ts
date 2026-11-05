import { DealError } from '@/lib/settle/deals';
import { cancelHandover } from '@/lib/settle/handover';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';

// Meet-up mode: either side calls it off and PayPal releases the hold. The buyer is never charged.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/handover/cancel'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'handover-cancel', 20)) throw new DealError('too many tries; wait a few minutes', 400);
    return cancelHandover(id, linkKey(request), { store: getStore() });
  });
}
