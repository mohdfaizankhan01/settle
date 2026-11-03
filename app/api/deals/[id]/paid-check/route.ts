import { DealError } from '@/lib/settle/deals';
import { paidCheck } from '@/lib/settle/paid-check';
import { api, getStore, jsonBody, linkKey, rateLimited } from '@/lib/settle/runtime';

// "Is this paid?": answers from this deal's PayPal order only. May read PayPal, so rate-limited.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/paid-check'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'paid-check', 30, 600)) throw new DealError('too many checks; try again later', 400);
    const body = await jsonBody(request);
    return paidCheck(id, linkKey(request), typeof body.text === 'string' ? body.text : '', { store: getStore() });
  });
}
