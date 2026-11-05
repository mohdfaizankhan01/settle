import { DealError } from '@/lib/settle/deals';
import { answerWarning } from '@/lib/settle/feedback';
import { api, getStore, jsonBody, linkKey, rateLimited, str } from '@/lib/settle/runtime';

// "Was this a scam?" on a warning: kept as a receipt; "scam" also reports the other side to scam memory.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/warning'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'warning-answer', 30)) throw new DealError('too many answers; wait a few minutes', 400);
    const body = await jsonBody(request);
    return answerWarning(id, linkKey(request), str(body.signalId, 'signalId'), str(body.verdict, 'verdict'), { store: getStore() });
  });
}
