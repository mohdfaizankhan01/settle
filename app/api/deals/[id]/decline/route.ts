import { declineDeal, withdrawDecline } from '@/lib/settle/deals';
import { api, clientNetwork, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

// Declines the deal link with a reason (shown to the other side), or withdraws your own decline.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/decline'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    if (body.withdraw === true) await withdrawDecline(id, linkKey(request), { store: getStore() });
    else await declineDeal(id, linkKey(request), str(body.reason, 'reason'), { store: getStore(), origin: clientNetwork(request) });
    return { ok: true };
  });
}
