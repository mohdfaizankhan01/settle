import { handleWebhook } from '@/lib/settle/webhook';

// PayPal webhook endpoint, registered in the sandbox app as <SETTLE_PUBLIC_HOST>/api/paypal/webhook.
// It only verifies and logs for now (M1). Logs carry the event ID, type and outcome, never the
// body, which holds buyer names and addresses.

export async function POST(request: Request) {
  const result = await handleWebhook(await request.text(), request.headers);
  console.log(`[webhook] ${JSON.stringify(result)}`);
  return Response.json({ outcome: result.outcome }, { status: result.status });
}
