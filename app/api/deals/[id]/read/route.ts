import { cachedReader } from '@/lib/reader/deal-reader';
import { DealError, readAgain } from '@/lib/settle/deals';
import { api, getStore, linkKey, rateLimited, readerForRequest, requireLink } from '@/lib/settle/runtime';

// Asks the AI reader to read the card again after it didn't run (PLAN M8). Same caps as making a
// deal; judge-mode deals read from the recorded readings, never the provider.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/read'>) {
  const { id } = await ctx.params;
  return api(async () => {
    await requireLink(id, request);
    if (rateLimited(request, 'deal-action', 240)) throw new DealError('too many requests from this address; try again later', 400);
    const store = getStore();
    const demo = !!(await store.getDeal(id))?.value.demo;
    await readAgain(id, linkKey(request), { store, reader: demo ? cachedReader(store) : readerForRequest(request) });
    return { ok: true };
  });
}
