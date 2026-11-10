// Scam memory across deals (PLAN M6, DECISIONS #20). A scammer reuses the same PayPal account, the
// same pickup postcode and the same script from one victim to the next; each deal on its own can't
// see that. When a deal is declined for a scam reason, or someone marks a warning "this was a
// scam", Settle remembers the other side's identifiers, as keyed hashes only. A later deal whose
// identifiers were reported by at least two other deals in the last 90 days gets a caution.
//
// Rules: no chat text and no raw values are stored, only HMAC-SHA-256 with a server secret, so a
// short value like a postcode can't be recovered by guessing. A side can only report the other
// side, with a flagged message of theirs as evidence; each reporting network counts once; a
// withdrawn decline takes its report back; and a deal never matches its own reports. Memory adds caution only:
// it never blocks, approves or decides. Judge sessions have their own memory. Without the secret
// in production, memory is off: nothing is stored or matched (fail closed, never a crash).

import { createHmac } from 'node:crypto';
import type { Role } from './chat';
import { redactChat } from './redact';
import type { DealStore, MemoryEntry } from './store';
import type { Deal, MemoryHit } from './types';

/** Reports from at least this many different deals before a caution shows. */
export const MIN_REPORTS = 2;
/** Reports older than this are forgotten. */
export const MEMORY_DAYS = 90;
const DAY_MS = 24 * 3600_000;

type Kind = MemoryHit['kind'];
type Id = { kind: Kind; about: Role; value: string; signalId?: string; messageId?: string };
export type MemoryDeps = { store: DealStore; now?: () => Date; secret?: string; origin?: string };

const nowOf = (deps: MemoryDeps) => (deps.now ?? (() => new Date()))();
const other = (role: Role): Role => (role === 'seller' ? 'buyer' : 'seller');

/** The HMAC key, or undefined when memory is off (production without SETTLE_MEMORY_KEY). */
export function memorySecret(env: Partial<Record<'NODE_ENV' | 'SETTLE_MEMORY_KEY', string>> = process.env): string | undefined {
  if (env.SETTLE_MEMORY_KEY && env.SETTLE_MEMORY_KEY.length >= 32) return env.SETTLE_MEMORY_KEY;
  return env.NODE_ENV === 'production' ? undefined : 'settle-local-development-memory-key-not-secret';
}

/** The keyed hash scam memory stores for one identifier. */
export const memoryHash = (secret: string, kind: Kind, value: string) => createHmac('sha256', secret).update(`${kind}\n${value}`).digest('hex');
const hmac = memoryHash;

/** Judge sessions remember on their own; real deals share one memory. */
export const namespaceOf = (deal: Deal) => (deal.demo ? `demo:${deal.demo.session}` : 'live');

/**
 * A flagged message, reduced to its script: redacted (names, prices, links, contact details become
 * placeholders), placeholder numbers dropped, lowercased, spaces collapsed. The same script sent to
 * the next victim gives the same fingerprint; a reworded one doesn't.
 */
export function messageFingerprint(deal: Deal, messageId: string, redactedChat = redactChat(deal.messages).messages): string | undefined {
  const redacted = redactedChat.find((m) => m.id === messageId);
  if (!redacted) return undefined;
  const text = redacted.text
    .replace(/\[([A-Z]+)_\d+[^\]]*\]/g, '[$1]')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}[\]]+/gu, ' ')
    .trim();
  return text.length >= 12 ? text : undefined;
}

/** What Settle knows about one side of a deal that could identify them in another deal. */
export function identifiersOf(deal: Deal, about: Role, signalIds?: string[]): Id[] {
  const out: Id[] = [];
  const read = deal.payment?.read?.ok ? deal.payment.read : undefined;
  if (about === 'seller' && deal.payeeMerchantId) out.push({ kind: 'payee', about, value: deal.payeeMerchantId });
  if (about === 'buyer' && read?.payerId) out.push({ kind: 'payer', about, value: read.payerId });
  if (about === 'buyer' && read?.shipTo?.postalCode) out.push({ kind: 'postcode', about, value: `${deal.country}:${read.shipTo.postalCode.toUpperCase().replace(/\s+/g, '')}` });
  // Messages this side wrote that a warning flagged (all of them, or just the reported signals).
  // The chat is redacted once per call, not once per warning (code review).
  let redacted: ReturnType<typeof redactChat>['messages'] | undefined;
  for (const w of deal.warnings) {
    if (!w.messageId || (signalIds && !signalIds.includes(w.signalId))) continue;
    const m = deal.messages.find((x) => x.id === w.messageId);
    if (m?.role !== about) continue;
    // A line the other person pasted in under this side's name is not this side's own message.
    if (m.added && m.added.by !== about) continue;
    redacted ??= redactChat(deal.messages).messages;
    const fp = messageFingerprint(deal, m.id, redacted);
    if (fp && !out.some((x) => x.kind === 'message' && x.value === fp)) out.push({ kind: 'message', about, value: fp, signalId: w.signalId, messageId: m.id });
  }
  return out;
}

export type ReportReason = 'declined' | 'marked_scam';

/**
 * `reporter` says the other side of this deal tried a scam. Stores keyed hashes of that side's
 * identifiers; returns how many. Only ever about the other side, so nobody reports themselves.
 */
export async function reportOtherSide(deal: Deal, reporter: Role, reason: ReportReason, deps: MemoryDeps, signalIds?: string[]): Promise<number> {
  const secret = deps.secret ?? memorySecret();
  if (!secret) return 0;
  const about = other(reporter);
  const ids = identifiersOf(deal, about, signalIds);
  // Evidence first: only a report backed by a flagged message the other side wrote themselves is
  // remembered. A decline reason or a "scam" click alone can't put someone's PayPal account,
  // payer or postcode on file (security audit: one person could otherwise accuse anyone).
  if (!ids.some((i) => i.kind === 'message')) return 0;
  // The chat is pasted by whoever made the deal, so "their message" may be the reporter's own words.
  // A person (PayPal account, payer, postcode) is put on file only if that side confirmed the card,
  // i.e. accepted the chat as the record; otherwise only the script is remembered (security review).
  const accepted = (await deps.store.listReceipts(deal.id)).some((r) => r.kind === 'card.confirmed' && (r.data as { by?: string }).by === about);
  const kept = accepted ? ids : ids.filter((i) => i.kind === 'message');
  const at = nowOf(deps).toISOString();
  const reporterHash = deps.origin ? hmac(secret, 'reporter' as Kind, deps.origin) : undefined;
  const entries: MemoryEntry[] = kept.map((i) => ({ namespace: namespaceOf(deal), kind: i.kind, hash: hmac(secret, i.kind, i.value), dealId: deal.id, at, by: reporter, reason, ...(reporterHash ? { reporter: reporterHash } : {}) }));
  await deps.store.addMemory(entries);
  // The receipt keeps what was reported and why, never the values or their hashes.
  await deps.store.addReceipt({ dealId: deal.id, kind: 'memory.reported', at, data: { by: reporter, about, reason, kinds: kept.map((i) => i.kind), signals: signalIds ?? null } });
  return entries.length;
}

/** Identifiers of either side that at least MIN_REPORTS other deals reported in the last 90 days. */
export async function memoryHits(deal: Deal, deps: MemoryDeps): Promise<MemoryHit[]> {
  const secret = deps.secret ?? memorySecret();
  if (!secret) return [];
  const ids = [...identifiersOf(deal, 'seller'), ...identifiersOf(deal, 'buyer')].map((i) => ({ ...i, hash: hmac(secret, i.kind, i.value) }));
  if (ids.length === 0) return [];
  const since = new Date(nowOf(deps).getTime() - MEMORY_DAYS * DAY_MS).toISOString();
  const found = await deps.store.findMemory(namespaceOf(deal), [...new Set(ids.map((i) => i.hash))], since);
  const hits: MemoryHit[] = [];
  for (const i of ids) {
    // Distinct reporters, never this deal itself. A reporter is the network a report came from, so
    // one person making several deals counts once; reports from before that was kept count per deal.
    const reporters = new Set(found.filter((e) => e.hash === i.hash && e.kind === i.kind && e.dealId !== deal.id).map((e) => e.reporter ?? `deal:${e.dealId}`));
    if (reporters.size >= MIN_REPORTS) hits.push({ kind: i.kind, about: i.about, count: reporters.size, ...(i.signalId ? { signalId: i.signalId } : {}), ...(i.messageId ? { messageId: i.messageId } : {}) });
  }
  return hits;
}

const key = (hits: MemoryHit[]) => JSON.stringify(hits.map((h) => [h.kind, h.about, h.count, h.messageId ?? null]).sort());

/** A deal is re-matched at most this often per server instance; the page polls every 10 s. */
export const MEMORY_RECHECK_MS = 60_000;
const lastMatched = new Map<string, number>();

/** On a page load: re-match the deal; records the result and a receipt only when it changed. */
export async function refreshMemory(deal: Deal, deps: MemoryDeps, force = false): Promise<Deal> {
  const t = nowOf(deps).getTime();
  if (!force && t - (lastMatched.get(deal.id) ?? 0) < MEMORY_RECHECK_MS) return deal;
  lastMatched.set(deal.id, t);
  if (lastMatched.size > 10_000) lastMatched.clear();
  let hits: MemoryHit[];
  try {
    hits = await memoryHits(deal, deps);
  } catch {
    // Memory only adds caution: if it can't be read, the deal is shown as it was.
    return deal;
  }
  if (key(hits) === key(deal.memory?.hits ?? [])) return deal;
  const at = nowOf(deps).toISOString();
  const stored = await deps.store.getDeal(deal.id);
  if (!stored) return deal;
  const next: Deal = { ...stored.value, memory: { hits, checkedAt: at } };
  try {
    await deps.store.updateDeal(deal.id, stored.version, next);
  } catch {
    return deal;
  }
  await deps.store.addReceipt({ dealId: deal.id, kind: 'memory.matched', at, data: { hits: hits.map((h) => ({ kind: h.kind, about: h.about, count: h.count })) } });
  return next;
}

/**
 * Judge mode: two earlier reports of the fake-email deal's scam message, in the session's own
 * memory, so a judge sees a match. Labelled as seeded on screen; never shared with real deals.
 */
export async function seedDemoMemory(deal: Deal, deps: MemoryDeps): Promise<Deal> {
  const secret = deps.secret ?? memorySecret();
  if (!secret || !deal.demo) return deal;
  const now = nowOf(deps).getTime();
  const messages = identifiersOf(deal, 'buyer').filter((i) => i.kind === 'message');
  const entries = messages.flatMap((i) =>
    [5, 2].map((days, n) => ({ namespace: namespaceOf(deal), kind: i.kind, hash: memoryHash(secret, i.kind, i.value), dealId: `demo-earlier-report-${n + 1}`, at: new Date(now - days * DAY_MS).toISOString() })),
  );
  await deps.store.addMemory(entries);
  return refreshMemory(deal, deps, true);
}
