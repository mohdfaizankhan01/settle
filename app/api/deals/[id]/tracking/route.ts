import { DealError } from '@/lib/settle/deals';
import { api, getStore, jsonBody, linkKey, rateLimited, str } from '@/lib/settle/runtime';
import { addTracking } from '@/lib/settle/shipping';

// Adds tracking to the PayPal order (through PayPal's TypeScript SDK), then re-reads the order.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/tracking'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'tracking', 20)) throw new DealError('too many tries; wait a few minutes', 400);
    const body = await jsonBody(request);
    const carrierName = typeof body.carrierName === 'string' ? body.carrierName : undefined;
    await addTracking(id, linkKey(request), { carrier: str(body.carrier, 'carrier'), number: str(body.number, 'number'), carrierName }, { store: getStore() });
    return { ok: true };
  });
}
