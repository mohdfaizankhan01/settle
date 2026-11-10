import { DealError } from '@/lib/settle/deals';
import { confirmCard } from '@/lib/settle/deals';
import { api, rateLimited, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

// The body carries the hash of the card the person was shown; a changed card is refused.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/confirm'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const body = await jsonBody(request);
    await confirmCard(id, linkKey(request), str(body.cardHash, 'cardHash'), { store: getStore() });
    return { ok: true };
  });
}
