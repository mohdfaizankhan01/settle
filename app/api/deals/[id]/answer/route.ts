import { DealError } from '@/lib/settle/deals';
import { answerQuestion } from '@/lib/settle/deals';
import { api, rateLimited, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/answer'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const body = await jsonBody(request);
    await answerQuestion(id, linkKey(request), str(body.questionId, 'questionId'), str(body.optionId, 'optionId'), { store: getStore() });
    return { ok: true };
  });
}
