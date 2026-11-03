import { choiceFrom } from '@/lib/settle/choice';
import { DealError } from '@/lib/settle/deals';
import { previewSubmission } from '@/lib/settle/dispute-submit';
import { api, getStore, jsonBody, linkKey, rateLimited } from '@/lib/settle/runtime';

// The exact request the seller is asked to approve. Re-reads the dispute, so rate-limited.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/disputes/preview'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'dispute-preview', 60, 600)) throw new DealError('too many requests; try again later', 400);
    const { disputeId, choice } = choiceFrom(await jsonBody(request));
    return previewSubmission(id, linkKey(request), disputeId, choice, { store: getStore() });
  });
}
