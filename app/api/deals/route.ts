import { createDeal } from '@/lib/settle/deals';
import { api, getStore, jsonBody, rateLimited, str } from '@/lib/settle/runtime';
import { DealError } from '@/lib/settle/deals';

// Creates a deal from a pasted chat. Each call runs one Jev check, so it is rate-limited.
// The response holds both link keys; it is the only time they exist in plain form.
export async function POST(request: Request) {
  return api(async () => {
    if (rateLimited(request, 'create', 20, 300)) throw new DealError('too many deals from this address; try again later', 400);
    const body = await jsonBody(request);
    const country = body.country === 'US' || body.country === 'UK' ? body.country : undefined;
    if (!country) throw new DealError('country must be US or UK');
    const { deal, keys } = await createDeal({ chat: str(body.chat, 'chat'), sellerName: str(body.sellerName, 'sellerName'), country }, { store: getStore() });
    return { dealId: deal.id, keys };
  });
}
