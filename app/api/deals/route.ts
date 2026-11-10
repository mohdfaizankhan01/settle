import { createDeal } from '@/lib/settle/deals';
import { api, getStore, jsonBody, rateLimited, readerForRequest, str } from '@/lib/settle/runtime';
import { DealError } from '@/lib/settle/deals';

// Creates a deal from a pasted chat. Each call runs the warning check and the AI reader, so it is
// rate-limited; over the reader's own caps the deal is still made, read by code only.
// The response holds both link keys; it is the only time they exist in plain form.
export async function POST(request: Request) {
  return api(async () => {
    const body = await jsonBody(request);
    const country = body.country === 'US' || body.country === 'UK' ? body.country : undefined;
    if (!country) throw new DealError('country must be US or UK');
    // Charged only for a well-formed request, so cheap junk can't use up the shared hourly cap.
    if (rateLimited(request, 'create', 20, 1000)) throw new DealError('too many deals from this address; try again later', 400);
    const { deal, keys } = await createDeal({ chat: str(body.chat, 'chat'), sellerName: str(body.sellerName, 'sellerName'), country }, { store: getStore(), reader: readerForRequest(request) });
    return { dealId: deal.id, keys };
  });
}
