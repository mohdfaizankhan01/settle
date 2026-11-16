// The live-update stream behind one deal page (Part B, live updates). A server-sent-events body
// that says "changed" whenever the deal is written (lib/settle/changes.ts), plus a heartbeat so
// proxies keep the connection open. It carries no deal data: the page reads the deal again through
// the normal authorised route. It closes itself after a few minutes and the page reconnects, and
// how many can be open is capped per deal, per address and in total, so it can't be used to hold
// the server's memory.

import { watch } from './changes';
import { DealError } from './deals';

export const HEARTBEAT_MS = 25_000;
export const MAX_AGE_MS = 4 * 60_000;
export const LIMITS = { perDeal: 8, perAddress: 12, total: 300 };

type Counts = { deal: Map<string, number>; address: Map<string, number>; total: number };
const g = globalThis as unknown as { settleStreams?: Counts };
const counts = (): Counts => (g.settleStreams ??= { deal: new Map(), address: new Map(), total: 0 });
const bump = (m: Map<string, number>, key: string, by: number) => {
  const n = (m.get(key) ?? 0) + by;
  if (n <= 0) m.delete(key);
  else m.set(key, n);
};

/** How many streams are open (for tests and the health of the cap). */
export const openStreams = () => counts().total;

export type WatchOptions = { signal?: AbortSignal; heartbeatMs?: number; maxAgeMs?: number };

/** Opens a stream for one deal. Throws when a cap is reached. The caller has already checked the link. */
export function watchStream(dealId: string, address: string, opts: WatchOptions = {}): ReadableStream<Uint8Array> {
  const c = counts();
  if (c.total >= LIMITS.total || (c.deal.get(dealId) ?? 0) >= LIMITS.perDeal || (c.address.get(address) ?? 0) >= LIMITS.perAddress) {
    throw new DealError('too many live connections are open; the page will keep checking every few seconds instead', 400);
  }
  c.total++;
  bump(c.deal, dealId, 1);
  bump(c.address, address, 1);

  const enc = new TextEncoder();
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          end();
        }
      };
      const stop = watch(dealId, () => send('data: {"changed":true}\n\n'));
      const heartbeat = setInterval(() => send(': ping\n\n'), opts.heartbeatMs ?? HEARTBEAT_MS);
      const expire = setTimeout(() => {
        send('event: bye\ndata: {}\n\n');
        end();
      }, opts.maxAgeMs ?? MAX_AGE_MS);
      heartbeat.unref?.();
      expire.unref?.();
      function end() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(expire);
        stop();
        const k = counts();
        k.total = Math.max(0, k.total - 1);
        bump(k.deal, dealId, -1);
        bump(k.address, address, -1);
        try {
          controller.close();
        } catch {
          // Already closed by the other side.
        }
      }
      cleanup = end;
      opts.signal?.addEventListener('abort', end, { once: true });
      if (opts.signal?.aborted) end();
      // Tell the browser how long to wait before it reconnects, and that the stream is open.
      send('retry: 3000\n: open\n\n');
    },
    cancel() {
      cleanup();
    },
  });
}
