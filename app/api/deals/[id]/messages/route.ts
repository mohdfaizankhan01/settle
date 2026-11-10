import { addMessages, DealError } from '@/lib/settle/deals';
import { api, requireLink, getStore, jsonBody, linkKey, rateLimited, str } from '@/lib/settle/runtime';

// Messages from the DM after payment. Each call runs the warning check, so it is rate-limited.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/messages'>) {
  const { id } = await ctx.params;
  return api(async () => {
    await requireLink(id, request);
    if (rateLimited(request, 'messages', 20, 300)) throw new DealError('too many messages added; try again later', 400);
    const body = await jsonBody(request);
    await addMessages(id, linkKey(request), str(body.text, 'text'), { store: getStore() });
    return { ok: true };
  });
}
