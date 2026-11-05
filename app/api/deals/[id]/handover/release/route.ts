import { DealError } from '@/lib/settle/deals';
import { releaseHandover } from '@/lib/settle/handover';
import { api, getStore, jsonBody, linkKey, rateLimited, str } from '@/lib/settle/runtime';

// Meet-up mode: the buyer's link key plus the seller's current code release the held money.
// Payment is confirmed afterwards only by a verified webhook plus a fresh GET, as for any deal.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/handover/release'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'handover-release', 20)) throw new DealError('too many tries; wait a few minutes', 400);
    const body = await jsonBody(request);
    // The payer secret: only the device that started the hold checkout has it.
    return releaseHandover(id, linkKey(request), str(body.token, 'token'), request.headers.get('x-settle-payer'), { store: getStore() });
  });
}
