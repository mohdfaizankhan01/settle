import { DealError } from '@/lib/settle/deals';
import { evidencePack } from '@/lib/settle/dispute-submit';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';

// The evidence pack PDF, for the seller to download (Resolution Center fallback).
export async function GET(request: Request, ctx: RouteContext<'/api/deals/[id]/disputes/pack'>) {
  const { id } = await ctx.params;
  const disputeId = new URL(request.url).searchParams.get('d') ?? '';
  if (rateLimited(request, 'dispute-pack', 60)) return Response.json({ error: 'too many downloads; try again later' }, { status: 400 });
  try {
    const pdf = await evidencePack(id, linkKey(request), disputeId, { store: getStore() });
    return new Response(new Uint8Array(pdf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="settle-evidence-${disputeId.replace(/[^A-Z0-9-]/gi, '')}.pdf"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof DealError) return api(async () => { throw error; });
    throw error;
  }
}
