import { isIPv4, isIPv6 } from 'node:net';
// Server wiring shared by the deal API routes: the store, the public host, the caller's link
// key, a simple rate limit, and error mapping. Fail closed: production without DATABASE_URL
// refuses to run instead of falling back to memory.

import { PayPalApiError } from '../paypal';
import { ChatError, type Role } from './chat';
import { actingRole, DealError, withDevice } from './deals';
import { PgDealStore } from './pg-store';
import { skippedReader, type DealReader } from '../reader/deal-reader';
import { MemoryDealStore, type DealStore } from './store';
import { readBodyLimited } from './webhook';

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
  sweep(hits);
  hits.set(`${bucket}:${ip}`, [...mine, Date.now()]);
  hits.set(`${bucket}:*`, [...all, Date.now()]);
  return false;
}

/** The longest window any bucket uses. The sweep keeps everything younger than this. */
const LONGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Drops keys with no hit inside the longest window, now and then, so one-off addresses don't stay
 * in memory. Never by the caller's own window: a 60-second bucket must not clear hourly or daily
 * caps (code review, Nov 11).
 */
function sweep(hits: Map<string, number[]>) {
  if (Date.now() - (g.settleSwept ?? 0) <= 60_000) return;
  g.settleSwept = Date.now();
  const cutoff = Date.now() - LONGEST_WINDOW_MS;
  for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
}

/**
 * The caller's network, for counting scam reporters: the IPv4 /24 or IPv6 /48 of the address the
 * proxy saw. Coarse on purpose, so one person hopping between addresses on one network counts once.
 */
export function clientNetwork(request: Request): string {
  return networkOf(request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local');
}

/** Canonical network of one address: parsed first (`::` expanded, IPv4-mapped IPv6 as IPv4), then masked. */
export function networkOf(raw: string): string {
  let ip = raw.replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (isIPv4(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (!isIPv6(ip)) return 'other';
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(':')}::/48`;
}

/** At most `limit` hits per `windowMs` for one key (e.g. one deal), across all addresses. */
export function limitedKey(key: string, limit: number, windowMs = 60 * 60 * 1000): boolean {
  const hits = (g.settleHits ??= new Map<string, number[]>());
  const cutoff = Date.now() - windowMs;
  const recent = (hits.get(`key:${key}`) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) return true;
  hits.set(`key:${key}`, [...recent, Date.now()]);
  return false;
}

/**
 * The caller's role, checked before a shared rate-limit bucket is charged: strangers without a
 * working link for this deal can't use up everyone's allowance (security audit).
 */
export async function requireLink(dealId: string, request: Request): Promise<Role> {
  const stored = await getStore().getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  const role = actingRole(stored.value, linkKey(request));
  if (!role) throw new DealError('this link is not valid for the deal', 403);
  return role;
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

/** Largest JSON body a deal route accepts. Reading stops at the cap, so a huge body is never buffered. */
export const MAX_JSON_BYTES = 64 * 1024;

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBodyLimited(request, MAX_JSON_BYTES);
  if (text === undefined) throw new DealError('request too large');
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

/** The AI reader's caps (PLAN M8), sized to Groq's free tier: 8,000 tokens a minute, 200,000 a day. */
export const READER_LIMITS = { perAddressHour: 10, totalMinute: 3, totalDay: 80 } as const;

/**
 * The reader for a request that would read a chat: undefined (the normal live reader) while under
 * every cap, else one that skips with the reason, so the deal is still made and labelled. Without a
 * key nothing is counted: the reader skips on its own.
 */
export function readerForRequest(request: Request): DealReader | undefined {
  if (!process.env.GROQ_API_KEY || process.env.SETTLE_READER === 'off') return undefined;
  const ip = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local';
  const over = readerCapReached(ip);
  if (over) return skippedReader(over);
  recordReaderUse(ip);
  return undefined;
}

const READER_BUCKETS = (ip?: string) => {
  const L = READER_LIMITS;
  return [
    ...(ip ? [{ key: `reader:${ip}`, limit: L.perAddressHour, windowMs: 60 * 60 * 1000, reason: `the AI reader's limit for this address was reached (${L.perAddressHour} an hour)` }] : []),
    { key: 'reader-minute:*', limit: L.totalMinute, windowMs: 60 * 1000, reason: `the AI reader is busy (${L.totalMinute} reads a minute in total)` },
    { key: 'reader-day:*', limit: L.totalDay, windowMs: LONGEST_WINDOW_MS, reason: `the AI reader's daily limit was reached (${L.totalDay} a day in total)` },
  ];
};

/** The first reader cap that is full, checked without counting anything (a skipped read costs nothing). */
export function readerCapReached(ip?: string): string | undefined {
  const hits = (g.settleHits ??= new Map<string, number[]>());
  for (const b of READER_BUCKETS(ip)) if ((hits.get(b.key) ?? []).filter((t) => t > Date.now() - b.windowMs).length >= b.limit) return b.reason;
  return undefined;
}

/** Counts one read against the caps. The server-start warm-up counts too (no address). */
export function recordReaderUse(ip?: string) {
  const hits = (g.settleHits ??= new Map<string, number[]>());
  sweep(hits);
  for (const b of READER_BUCKETS(ip)) hits.set(b.key, [...(hits.get(b.key) ?? []).filter((t) => t > Date.now() - b.windowMs), Date.now()]);
}
