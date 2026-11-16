// "This deal changed" signals for the live deal page (Part B, live updates). Anything that writes a
// deal or a receipt announces its ID; a page that is watching the deal gets one signal and reads
// the deal again through the normal, authorised route. A signal carries no deal data: it can only
// say "look again", so it can't leak anything.
//
// In-process only (one server instance, as on Render's free plan). If the process restarts or a
// second instance made the change, a page doesn't get the signal and its slower poll catches up.
// Bursts of writes (a webhook updates a deal and adds receipts) are merged into one signal.

type Listener = () => void;
type State = { watchers?: Map<string, Set<Listener>>; timers?: Map<string, ReturnType<typeof setTimeout>> };
const g = globalThis as unknown as { settleChanges?: State };
const state = (): Required<State> => {
  const s = (g.settleChanges ??= {});
  s.watchers ??= new Map();
  s.timers ??= new Map();
  return s as Required<State>;
};

/** Writes this close together make one signal. */
export const COALESCE_MS = 150;

/** Something about this deal changed. Costs nothing when nobody is watching. */
export function announce(dealId: string): void {
  const { watchers, timers } = state();
  if (!watchers.has(dealId) || timers.has(dealId)) return;
  const timer = setTimeout(() => {
    timers.delete(dealId);
    for (const listener of [...(watchers.get(dealId) ?? [])]) {
      try {
        listener();
      } catch {
        // One broken listener never stops the others.
      }
    }
  }, COALESCE_MS);
  timer.unref?.();
  timers.set(dealId, timer);
}

/** Calls `listener` after each change to the deal. Returns the function that stops watching. */
export function watch(dealId: string, listener: Listener): () => void {
  const { watchers } = state();
  const set = watchers.get(dealId) ?? new Set<Listener>();
  set.add(listener);
  watchers.set(dealId, set);
  return () => {
    const now = state();
    const current = now.watchers.get(dealId);
    current?.delete(listener);
    if (current && current.size === 0) {
      now.watchers.delete(dealId);
      const timer = now.timers.get(dealId);
      if (timer) clearTimeout(timer);
      now.timers.delete(dealId);
    }
  };
}

/** How many pages are watching one deal, or all deals. */
export function watcherCount(dealId?: string): number {
  const { watchers } = state();
  if (dealId) return watchers.get(dealId)?.size ?? 0;
  let n = 0;
  for (const set of watchers.values()) n += set.size;
  return n;
}
