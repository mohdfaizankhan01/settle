// Receives a PayPal webhook and decides whether it can be trusted. Fail closed: only a
// SUCCESS from verify-webhook-signature makes an event "verified", and a verified event is
// still only a hint. Payment is confirmed later by a fresh GET of the order (M3).

import { PayPalApiError, verifyWebhookSignature, type WebhookEvent } from '../paypal';

export type WebhookOutcome =
  // Signature checked by PayPal and good.
  | 'verified'
  // Bad, missing or forged signature, or a body that isn't a PayPal event. Nothing changes.
  | 'rejected'
  // We couldn't check (no webhook ID configured, PayPal down). PayPal retries on a 5xx.
  | 'unverifiable';

export type WebhookResult = {
  /** HTTP status to answer PayPal with: 200, 400 or 503. */
  status: 200 | 400 | 503;
  outcome: WebhookOutcome;
  eventId?: string;
  eventType?: string;
  debugId?: string;
  reason?: string;
};

type Deps = {
  verify: typeof verifyWebhookSignature;
  webhookId: string | undefined;
};

const defaultDeps = (): Deps => ({ verify: verifyWebhookSignature, webhookId: process.env.PAYPAL_WEBHOOK_ID });

function parseEvent(rawBody: string): WebhookEvent | undefined {
  try {
    const event = JSON.parse(rawBody) as Partial<WebhookEvent> | null;
    return typeof event?.id === 'string' && typeof event.event_type === 'string' ? (event as WebhookEvent) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleWebhook(rawBody: string, headers: Headers, deps: Deps = defaultDeps()): Promise<WebhookResult> {
  const event = parseEvent(rawBody);
  if (!event) return { status: 400, outcome: 'rejected', reason: 'body is not a PayPal webhook event' };

  const ids = { eventId: event.id, eventType: event.event_type };
  if (!deps.webhookId) return { status: 503, outcome: 'unverifiable', ...ids, reason: 'PAYPAL_WEBHOOK_ID is not set' };

  try {
    const status = await deps.verify(headers, rawBody, deps.webhookId);
    return status === 'SUCCESS'
      ? { status: 200, outcome: 'verified', ...ids }
      : { status: 400, outcome: 'rejected', ...ids, reason: 'signature verification failed' };
  } catch (error) {
    return {
      status: 503,
      outcome: 'unverifiable',
      ...ids,
      debugId: error instanceof PayPalApiError ? error.debugId : undefined,
      reason: 'could not reach verify-webhook-signature',
    };
  }
}

// PayPal events are a few KB; anything far larger is not from PayPal. Reading stops at the cap, so
// an oversized body is never buffered in full.
export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** The body as text, or undefined if it is larger than `maxBytes`. */
export async function readBodyLimited(request: Request, maxBytes = MAX_WEBHOOK_BYTES): Promise<string | undefined> {
  if (Number(request.headers.get('content-length')) > maxBytes) return undefined;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
