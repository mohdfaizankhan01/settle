import { DealError, enterTerm } from '@/lib/settle/deals';
import { api, limitedKey, requireLink, rateLimited, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/term'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    await requireLink(id, request); // per-deal limit only for holders of a working link
    if (limitedKey(`term:${id}`, 30)) throw new DealError('this deal was changed too often; try again later', 400);
    const body = await jsonBody(request);
    if (body.term !== 'item' && body.term !== 'price') throw new DealError('term must be item or price');
    await enterTerm(id, linkKey(request), body.term, str(body.value, 'value'), { store: getStore() });
    return { ok: true };
  });
}
