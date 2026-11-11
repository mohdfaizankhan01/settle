import { actingRole, DealError } from '@/lib/settle/deals';
import { exportRecord } from '@/lib/settle/records';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';

// The deal's signed record, for the seller to download and check at /verify. `?d=` adds the
// dispute whose evidence PDF the record covers.
export async function GET(request: Request, ctx: RouteContext<'/api/deals/[id]/record'>) {
  const { id } = await ctx.params;
  const disputeId = new URL(request.url).searchParams.get('d') ?? undefined;
  try {
    // Authenticate first, so strangers can't spend the budget.
    const stored = await getStore().getDeal(id);
    if (!stored) throw new DealError('no such deal', 404);
    if (actingRole(stored.value, linkKey(request)) !== 'seller') throw new DealError('only the seller can export the signed record', 403);
    if (rateLimited(request, 'record', 60)) throw new DealError('too many downloads; try again later', 400);
    const record = await exportRecord(id, linkKey(request), { store: getStore() }, disputeId);
    return new Response(`${JSON.stringify(record, null, 2)}\n`, {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="settle-link-record-${id.replace(/[^a-z0-9-]/gi, '')}.json"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof DealError) return api(async () => { throw error; });
    throw error;
  }
}
