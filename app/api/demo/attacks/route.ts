import { runAttacks } from '@/lib/settle/attacks';
import { DealError } from '@/lib/settle/deals';
import { api, rateLimited } from '@/lib/settle/runtime';

// Runs the seven attacks through the real code in a throwaway store; nothing reaches PayPal.
export async function POST(request: Request) {
  return api(async () => {
    if (rateLimited(request, 'attacks', 6, 300)) throw new DealError('the attacks were run a lot from here; try again in an hour', 400);
    return { ranAt: new Date().toISOString(), results: await runAttacks() };
  });
}
