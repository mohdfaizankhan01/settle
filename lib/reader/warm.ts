// At server start (instrumentation.ts), when a key is set: read each judge-mode chat once into the
// store's cache, so judge sessions show a live reading without calling the provider per session.
// Chats already cached or recorded cost nothing. Paced for Groq's 8,000 tokens a minute. Never throws.

import { SCENARIOS } from '../settle/demo';
import { parseChat } from '../settle/chat';
import { redactChat } from '../settle/redact';
import type { DealStore } from '../settle/store';
import { readerCapReached, recordReaderUse } from '../settle/runtime';
import { cachedReader, cacheKey } from './deal-reader';

export async function warmReaderCache(store: DealStore, pauseMs = 20_000): Promise<number> {
  if (!process.env.GROQ_API_KEY || process.env.SETTLE_READER === 'off') return 0;
  let live = 0;
  const seen = new Set<string>();
  for (const s of SCENARIOS) {
    if (seen.has(s.chat)) continue;
    seen.add(s.chat);
    try {
      const r = redactChat(parseChat(s.chat, s.seller));
      // Warm-up reads count against the same caps as live deals, and stop when one is full.
      const cached = await store.getReading(cacheKey(r)).catch(() => undefined);
      if (!cached && readerCapReached()) break;
      const out = await cachedReader(store, { live: true })(r);
      if (out.source === 'live') recordReaderUse();
      if (out.source === 'live') {
        live++;
        await new Promise((f) => setTimeout(f, pauseMs));
      }
    } catch (error) {
      console.error('reader warm-up failed:', error instanceof Error ? error.name : 'unknown error');
    }
  }
  return live;
}
