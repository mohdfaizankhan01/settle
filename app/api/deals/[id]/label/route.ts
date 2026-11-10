import { DealError } from '@/lib/settle/deals';
import { api, rateLimited, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';
import { setLabelPostcode } from '@/lib/settle/shipping';

// The seller types the postcode from the shipping label; code compares it with PayPal's address.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/label'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const body = await jsonBody(request);
    await setLabelPostcode(id, linkKey(request), str(body.postcode, 'postcode'), { store: getStore() });
    return { ok: true };
  });
}
