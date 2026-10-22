import { answerQuestion } from '@/lib/settle/deals';
import { api, getStore, jsonBody, linkKey, str } from '@/lib/settle/runtime';

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/answer'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const body = await jsonBody(request);
    await answerQuestion(id, linkKey(request), str(body.questionId, 'questionId'), str(body.optionId, 'optionId'), { store: getStore() });
    return { ok: true };
  });
}
