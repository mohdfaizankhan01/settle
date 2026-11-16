import { DealError } from '@/lib/settle/deals';
import { readBytesLimited } from '@/lib/label/body';
import { readLabelPhoto } from '@/lib/label/photo';
import { askGroqVision, VisionSkip, type AskVision } from '@/lib/label/provider';
import { MAX_IMAGE_BYTES } from '@/lib/label/read-label';
import { addressOf, api, getStore, limitedKey, linkKey, readerCapReached, recordReaderUse } from '@/lib/settle/runtime';
import { sellerDeal } from '@/lib/settle/shipping';

// Reads the postcode off a photo of the shipping label and returns it for the seller to confirm.
// The body is the photo itself (JPEG, PNG or WebP). It is read, sent to the vision model and
// dropped: nothing about it is stored (lib/label/photo.ts). "Couldn't read it" is an answer, not an
// error: the page then asks the seller to type the postcode.

/** Reads a deal can ask for in an hour, so one deal can't use up everyone's budget. */
export const PER_DEAL_HOUR = 6;

export async function POST(request: Request, ctx: RouteContext<'/api/deals/[id]/label/photo'>) {
  const { id } = await ctx.params;
  return api(async () => {
    // Authenticate and check the deal first, so strangers can't make us read or send anything.
    await sellerDeal(getStore(), id, linkKey(request));
    if (limitedKey(`label-photo:${id}`, PER_DEAL_HOUR)) throw new DealError('too many photos for this deal this hour; type the postcode instead', 400);
    // Judge mode's sample label: its recorded reading is replayed, no body is read and nothing is sent.
    if (new URL(request.url).searchParams.get('sample') === '1') return readLabelPhoto(id, linkKey(request), 'sample', { store: getStore() });
    const photo = await readBytesLimited(request, MAX_IMAGE_BYTES);
    if (!photo) throw new DealError('that photo is too large (3 MB at most)', 400);
    // A label read is a call to the same metered provider as the AI reader, so it counts against
    // the same caps (per address per hour, in total per minute and per day). Counted only when a
    // call is about to go out: a refused photo, judge mode or a missing key costs nothing.
    const address = addressOf(request);
    const ask: AskVision = async (req, model) => {
      if (!process.env.GROQ_API_KEY) throw new VisionSkip('no AI reader key is set');
      const over = readerCapReached(address);
      if (over) throw new VisionSkip(over);
      recordReaderUse(address);
      return askGroqVision(req, model);
    };
    return readLabelPhoto(id, linkKey(request), photo, { store: getStore(), ask });
  });
}
