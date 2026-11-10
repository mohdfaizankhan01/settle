// How deals get a reading (PLAN M8): live from the provider, or, for judge mode, from the store's
// cache or the readings recorded with `npm run reader:record`. Judge mode never calls the provider
// per session (Groq's free tier allows about 200,000 tokens a day), so it works with no key.

import recorded from '../../data/demo/reader-recorded.json';
import { canonicalJson, sha256Hex } from '../settle/canonical';
import type { Redacted } from '../settle/redact';
import type { DealStore } from '../settle/store';
import { PROMPT_VERSION, readDeal, readerModel, type ReaderDeps, type ReaderRun } from './read';

export type ReadingSource = 'live' | 'cache' | 'recorded';
export type Outcome = { run: ReaderRun; source: ReadingSource };
export type DealReader = (r: Redacted) => Promise<Outcome>;

/** The chat as the reader sees it, hashed: same prompt, same chat, same reading. */
export const chatHash = (r: Redacted) => sha256Hex(canonicalJson({ messages: r.messages, tokens: r.tokens.map((t) => ({ id: t.id, messageId: t.messageId })) }));
export const cacheKey = (r: Redacted, model = readerModel()) => `${PROMPT_VERSION}|${model}|${chatHash(r)}`;

export type RecordedReading = { promptVersion: string; model: string; chatHash: string; run: ReaderRun };
const RECORDED = (recorded as { readings: RecordedReading[] }).readings;

export const liveReader =
  (deps: ReaderDeps = {}): DealReader =>
  async (r) => ({ run: await readDeal(r, deps), source: 'live' });

/** Used when a cap is reached or the reader is off for this request: the deal still works. */
export const skippedReader =
  (reason: string, now: () => Date = () => new Date()): DealReader =>
  async () => ({ run: { status: 'skipped', at: now().toISOString(), reason }, source: 'live' });

/**
 * Judge mode: the cache, then a recorded reading of the same chat and prompt version, then
 * (only when `live` is set, as at server start) the provider, whose answer is cached.
 */
export function cachedReader(store: DealStore, opts: { live?: boolean; deps?: ReaderDeps; now?: () => Date } = {}): DealReader {
  const now = opts.now ?? (() => new Date());
  return async (r) => {
    const key = cacheKey(r, opts.deps?.model);
    const hit = (await store.getReading(key).catch(() => undefined)) as ReaderRun | undefined;
    if (hit?.status === 'ran') return { run: hit, source: 'cache' };
    const hash = chatHash(r);
    const rec = RECORDED.find((x) => x.promptVersion === PROMPT_VERSION && x.chatHash === hash && x.run.status === 'ran');
    if (rec) return { run: rec.run, source: 'recorded' };
    if (!opts.live) return { run: { status: 'skipped', at: now().toISOString(), reason: 'no recorded reading for this chat' }, source: 'recorded' };
    const run = await readDeal(r, opts.deps);
    if (run.status === 'ran') await store.putReading(key, run).catch(() => undefined);
    return { run, source: 'live' };
  };
}
