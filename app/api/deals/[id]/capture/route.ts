import { captureCheckout } from '@/lib/settle/checkout';
import { api, getStore, jsonBody, linkKey, publicHost, str } from '@/lib/settle/runtime';

// Captures after a fresh GET of the order matches the card. Payment is confirmed later, only by a
// verified webhook plus another fresh GET (M3), never by this call's result.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/capture'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    return captureCheckout(id, linkKey(request), str(body.orderId, 'orderId'), { store: getStore(), publicHost: publicHost(request) }, request.headers.get('x-settle-payer'));
  });
}
