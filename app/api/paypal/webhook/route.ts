import { applyVerifiedEvent } from '@/lib/settle/payment';
import { getStore, rateLimited } from '@/lib/settle/runtime';
import { handleWebhook, readBodyLimited } from '@/lib/settle/webhook';

// PayPal webhook endpoint, registered in the sandbox app as <SETTLE_PUBLIC_HOST>/api/paypal/webhook.
// Only a verified event reaches the deal, and even then it only triggers a fresh GET of the order
// (lib/settle/payment.ts). Logs carry the event ID, type and outcome, never the body, which holds
// buyer names and addresses.

export async function POST(request: Request) {
  // Per address only: a global cap would let a stranger block PayPal's own events.
  if (rateLimited(request, 'webhook', 600)) {
    console.log('[webhook] {"status":429,"outcome":"rejected","reason":"rate limited"}');
    return Response.json({ outcome: 'rejected' }, { status: 429 });
  }
  const body = await readBodyLimited(request);
  if (body === undefined) {
    console.log('[webhook] {"status":413,"outcome":"rejected","reason":"body too large"}');
    return Response.json({ outcome: 'rejected' }, { status: 413 });
  }
  const { event, ...result } = await handleWebhook(body, request.headers);
  if (!event) {
    console.log(`[webhook] ${JSON.stringify(result)}`);
    return Response.json({ outcome: result.outcome }, { status: result.status });
  }
  try {
    const applied = await applyVerifiedEvent(event, { store: getStore() });
    console.log(`[webhook] ${JSON.stringify({ ...result, ...applied })}`);
    return Response.json({ outcome: result.outcome }, { status: 200 });
  } catch (error) {
    // Couldn't read PayPal or the database: answer 503 so PayPal sends the event again.
    console.log(`[webhook] ${JSON.stringify({ ...result, status: 503, reason: `apply failed: ${error instanceof Error ? error.name : 'error'}` })}`);
    return Response.json({ outcome: 'unverifiable' }, { status: 503 });
  }
}
