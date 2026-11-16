import { DealError } from '@/lib/settle/deals';
import { api, addressOf, rateLimited, requireLink } from '@/lib/settle/runtime';
import { watchStream } from '@/lib/settle/watch';

// A live "this deal changed" stream for one deal page. Same link and device check as reading the
// deal; it never claims a link, and it carries no deal data (lib/settle/watch.ts).
export async function GET(request: Request, ctx: RouteContext<'/api/deals/[id]/watch'>) {
  const { id } = await ctx.params;
  try {
    await requireLink(id, request);
    // Opening is cheap but not free: a page opens one every few minutes, so this is generous.
    if (rateLimited(request, 'watch', 40, undefined, 5 * 60 * 1000)) throw new DealError('too many live connections from this address; try again in a few minutes', 400);
    const stream = watchStream(id, addressOf(request), { signal: request.signal });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        // Some proxies buffer a streamed body unless told not to.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    if (error instanceof DealError) return api(async () => { throw error; });
    throw error;
  }
}
