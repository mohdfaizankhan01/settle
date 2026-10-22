import { handleWebhook, readBodyLimited } from '@/lib/settle/webhook';

// PayPal webhook endpoint, registered in the sandbox app as <SETTLE_PUBLIC_HOST>/api/paypal/webhook.
// It only verifies and logs for now (M1). Logs carry the event ID, type and outcome, never the
// body, which holds buyer names and addresses.

export async function POST(request: Request) {
  const body = await readBodyLimited(request);
  if (body === undefined) {
    console.log('[webhook] {"status":413,"outcome":"rejected","reason":"body too large"}');
    return Response.json({ outcome: 'rejected' }, { status: 413 });
  }
  const result = await handleWebhook(body, request.headers);
  console.log(`[webhook] ${JSON.stringify(result)}`);
  return Response.json({ outcome: result.outcome }, { status: result.status });
}
