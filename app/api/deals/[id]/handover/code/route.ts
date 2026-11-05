import { DealError } from '@/lib/settle/deals';
import { showHandoverCode } from '@/lib/settle/handover';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';

// Meet-up mode: the seller shows a one-time code (valid 10 minutes) for the buyer to scan.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/handover/code'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'handover-code', 30)) throw new DealError('too many codes; wait a few minutes', 400);
    return showHandoverCode(id, linkKey(request), { store: getStore() });
  });
}
