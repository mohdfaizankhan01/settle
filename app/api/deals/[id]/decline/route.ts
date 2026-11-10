import { DealError } from '@/lib/settle/deals';
import { declineDeal, withdrawDecline } from '@/lib/settle/deals';
import { api, limitedKey, requireLink, rateLimited, clientNetwork, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

// Declines the deal link with a reason (shown to the other side), or withdraws your own decline.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/decline'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    await requireLink(id, request); // per-deal limit only for holders of a working link
    if (limitedKey(`decline:${id}`, 30)) throw new DealError('this deal was changed too often; try again later', 400);
    const body = await jsonBody(request);
    if (body.withdraw === true) await withdrawDecline(id, linkKey(request), { store: getStore() });
    else await declineDeal(id, linkKey(request), str(body.reason, 'reason'), { store: getStore(), origin: clientNetwork(request) });
    return { ok: true };
  });
}
