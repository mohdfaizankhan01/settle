import { DealError } from '@/lib/settle/deals';
import { readBytesLimited } from '@/lib/label/body';
import { readLabelPhoto } from '@/lib/label/photo';
import { MAX_IMAGE_BYTES } from '@/lib/label/read-label';
import { api, getStore, linkKey, rateLimited } from '@/lib/settle/runtime';
import { sellerDeal } from '@/lib/settle/shipping';

// Reads the postcode off a photo of the shipping label and returns it for the seller to confirm.
// The body is the photo itself (JPEG, PNG or WebP). It is read, sent to the vision model and
// dropped: nothing about it is stored (lib/label/photo.ts). "Couldn't read it" is an answer, not an
// error: the page then asks the seller to type the postcode.
export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/label/photo'>) {
  const { id } = await ctx.params;
  return api(async () => {
    // Authenticate and check the deal first, so strangers can't make us read or send anything.
    await sellerDeal(getStore(), id, linkKey(request));
    // Each read is one call to a metered provider: per address, and in total per minute.
    if (rateLimited(request, 'label-photo', 10)) throw new DealError('too many photos from this address; try again later, or type the postcode', 400);
    if (rateLimited(request, 'label-photo-minute', 1000, 3, 60_000)) throw new DealError('the photo reader is busy; try again in a minute, or type the postcode', 400);
    const photo = await readBytesLimited(request, MAX_IMAGE_BYTES);
    if (!photo) throw new DealError('that photo is too large (3 MB at most)', 400);
    return readLabelPhoto(id, linkKey(request), photo, { store: getStore() });
  });
}
