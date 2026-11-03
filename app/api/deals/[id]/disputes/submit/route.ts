import { choiceFrom } from '@/lib/settle/choice';
import { DealError } from '@/lib/settle/deals';
import { submitApproved } from '@/lib/settle/dispute-submit';
import { sellerDeal } from '@/lib/settle/shipping';
import { api, getStore, jsonBody, linkKey, rateLimited, str } from '@/lib/settle/runtime';

// Sends the request the seller approved, only if it is still exactly that request.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/disputes/submit'>) {
  const { id } = await ctx.params;
  return api(async () => {
    // Authenticate first, so strangers can't spend the shared budget.
    await sellerDeal(getStore(), id, linkKey(request));
    if (rateLimited(request, 'dispute-submit', 20)) throw new DealError('too many tries; wait a few minutes', 400);
    const body = await jsonBody(request);
    const { disputeId, choice } = choiceFrom(body);
    const out = await submitApproved(id, linkKey(request), disputeId, choice, str(body.hash, 'hash'), { store: getStore() });
    return { state: out.state, debugId: out.debugId ?? null };
  });
}
