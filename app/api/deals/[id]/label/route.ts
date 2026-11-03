import { api, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';
import { setLabelPostcode } from '@/lib/settle/shipping';

// The seller types the postcode from the shipping label; code compares it with PayPal's address.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/label'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    await setLabelPostcode(id, linkKey(request), str(body.postcode, 'postcode'), { store: getStore() });
    return { ok: true };
  });
}
