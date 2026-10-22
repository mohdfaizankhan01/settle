import { DealError, enterTerm } from '@/lib/settle/deals';
import { api, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/term'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    if (body.term !== 'item' && body.term !== 'price') throw new DealError('term must be item or price');
    await enterTerm(id, linkKey(request), body.term, str(body.value, 'value'), { store: getStore() });
    return { ok: true };
  });
}
