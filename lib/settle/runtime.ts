// Server wiring shared by the deal API routes: the store, the public host, the caller's link
// key, a simple rate limit, and error mapping. Fail closed: production without DATABASE_URL
// refuses to run instead of falling back to memory.

import { PayPalApiError } from '../paypal';
import { ChatError } from './chat';
import { DealError, withDevice } from './deals';
import { PgDealStore } from './pg-store';
import { MemoryDealStore, type DealStore } from './store';

const g = globalThis as unknown as { settleStore?: DealStore; settleHits?: Map<string, number[]>; settleSwept?: number };

export function getStore(): DealStore {
  if (g.settleStore) return g.settleStore;
  const url = process.env.DATABASE_URL;
  if (url) g.settleStore = PgDealStore.fromUrl(url);
  else if (process.env.NODE_ENV !== 'production') g.settleStore = new MemoryDealStore();
  else throw new Error('DATABASE_URL must be set in production');
  return g.settleStore;
}

export function publicHost(request: Request): string {
  return (process.env.SETTLE_PUBLIC_HOST || new URL(request.url).origin).replace(/\/$/, '');
}

/**
 * The caller's link key, plus this device's secret once the link was claimed (DECISIONS #22). The
 * key lives in the page's URL fragment and the secret in the browser, so neither reaches server logs.
 */
export const linkKey = (request: Request) => withDevice(request.headers.get('x-settle-key'), request.headers.get('x-settle-device'));

/**
 * At most `limit` calls per `windowMs` per client address and bucket, in memory per instance.
 * `globalLimit` also caps all clients together; it's only for routes that spend money (Jev
 * calls), as a cost bound, since one busy client can then refuse service to others. The address is the rightmost X-Forwarded-For entry: the one Render's
 * proxy appends. Entries to its left come from the client and can be forged.
 */
export function rateLimited(request: Request, bucket: string, limit: number, globalLimit?: number, windowMs = 60 * 60 * 1000): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local';
  const hits = (g.settleHits ??= new Map<string, number[]>());
  const cutoff = Date.now() - windowMs;
  const recent = (key: string) => (hits.get(key) ?? []).filter((t) => t > cutoff);
  const mine = recent(`${bucket}:${ip}`);
  const all = recent(`${bucket}:*`);
  if (mine.length >= limit) return true;
  if (globalLimit !== undefined && all.length >= globalLimit) return true;
  // Drop keys with no recent hits now and then, so one-off addresses don't stay in memory.
  if (Date.now() - (g.settleSwept ?? 0) > 60_000) {
    g.settleSwept = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
  }
  hits.set(`${bucket}:${ip}`, [...mine, Date.now()]);
  hits.set(`${bucket}:*`, [...all, Date.now()]);
  return false;
}

/**
 * The caller's network, for counting scam reporters: the IPv4 /24 or IPv6 /48 of the address the
 * proxy saw. Coarse on purpose, so one person hopping between addresses on one network counts once.
 */
export function clientNetwork(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48';
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : ip;
}

/** Runs a route body and maps known errors to JSON responses. Unknown errors log their name only. */
export async function api(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (error) {
    if (error instanceof DealError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ChatError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof PayPalApiError) {
      console.log(`[deal] PayPal ${error.status} on ${error.path} debug=${error.debugId ?? '-'}`);
      // Our quota or our credentials, never the caller's fault: 503 for busy, 502 otherwise.
      if (error.status === 429) return Response.json({ error: 'PayPal is busy; try again in a minute', debugId: error.debugId ?? null }, { status: 503 });
      return Response.json({ error: 'PayPal returned an error', debugId: error.debugId ?? null }, { status: 502 });
    }
    console.log(`[deal] unexpected ${error instanceof Error ? error.name : 'error'}`);
    return Response.json({ error: 'Something went wrong. Reload the page to see the deal as it is now.' }, { status: 500 });
  }
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new DealError('request too large');
  try {
    const v = JSON.parse(text || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new DealError('body must be a JSON object');
  }
}

export const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || v.length === 0) throw new DealError(`${name} is required`);
  return v;
};
