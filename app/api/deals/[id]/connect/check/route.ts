import { checkConnect } from '@/lib/settle/connect';
import { api, getStore, linkKey, publicHost, rateLimited } from '@/lib/settle/runtime';
import { DealError } from '@/lib/settle/deals';

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/connect/check'>) {
  const { id } = await ctx.params;
  return api(async () => {
    if (rateLimited(request, 'connect-check', 60)) throw new DealError('too many checks; wait a minute', 400);
    return checkConnect(id, linkKey(request), { store: getStore(), publicHost: publicHost(request) });
  });
}
