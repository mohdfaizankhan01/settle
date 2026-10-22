import { DealError, roleFor } from '@/lib/settle/deals';
import { api, getStore, linkKey } from '@/lib/settle/runtime';
import { dealView } from '@/lib/settle/view';

export async function GET(request: Request, ctx: RouteContext<'/api/deals/[id]'>) {
  const { id } = await ctx.params;
  return api(async () => {
    const stored = await getStore().getDeal(id);
    if (!stored) throw new DealError('no such deal', 404);
    const role = roleFor(stored.value, linkKey(request));
    if (!role) throw new DealError('this link is not valid for the deal', 403);
    return dealView(stored.value, role);
  });
}
