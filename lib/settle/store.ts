// Storage for deals, receipts and seller onboarding. One interface, two versions: in-memory for
// tests and local runs without a database, Postgres for the app. Deal updates are optimistic:
// a write based on a stale version fails, so two confirmations can't overwrite each other.

import { makeReceipt, type Receipt, type ReceiptInput } from './receipts';
import type { Deal } from './types';

export type Stored<T> = { version: number; value: T };

/** A seller's Partner Referrals onboarding, keyed by our own random tracking ID. */
export type SellerLink = { trackingId: string; dealId: string; createdAt: string; merchantId?: string };

/** A verified webhook event Settle has processed. Replays of the same ID are ignored. */
export type WebhookEventRecord = { id: string; type: string; dealId: string | null; at: string };

/** A judge session: its demo deals and their link keys (demo deals only; real keys are never stored). */
/** payer: meet-up demo deals only, the payer-device secret the judge's browser uses for the handover. */
export type DemoKeys = { seller: string; buyer: string; payer?: string };
export type DemoSession = { id: string; createdAt: string; deals: { dealId: string; scenario: string; keys: DemoKeys }[] };

export class StaleWriteError extends Error {
  constructor() {
    super('the deal changed since it was read');
  }
}

/**
 * One report in scam memory (DECISIONS #20): a keyed hash of one identifier, never the value.
 * namespace: 'live', or 'demo:<session>' for a judge session (never shared with real deals).
 * dealId: the deal that reported it, so each deal counts once and never matches itself.
 */
/** `reporter`: keyed hash of the reporting network; reports are counted per reporter, not per deal. */
export type MemoryEntry = { namespace: string; kind: string; hash: string; dealId: string; at: string; reporter?: string; by?: string; reason?: string };

export interface DealStore {
  /** Adds reports; a deal reporting the same identifier again changes nothing. */
  addMemory(entries: MemoryEntry[]): Promise<void>;
  /** Reports in a namespace for any of these hashes since `since`. */
  findMemory(namespace: string, hashes: string[], since: string): Promise<MemoryEntry[]>;
  /** Removes one side's decline reports from a deal (that side withdrew its decline). */
  removeMemory(namespace: string, dealId: string, by: string, reason: string): Promise<void>;
  createDeal(deal: Deal): Promise<void>;
  getDeal(id: string): Promise<Stored<Deal> | undefined>;
  /** Replaces the deal if it is still at `version`; otherwise throws StaleWriteError. */
  updateDeal(id: string, version: number, deal: Deal): Promise<Stored<Deal>>;
  /** Appends to the deal's receipt chain atomically and returns the new receipt. */
  addReceipt(input: ReceiptInput): Promise<Receipt>;
  listReceipts(dealId: string): Promise<Receipt[]>;
  saveSellerLink(link: SellerLink): Promise<void>;
  getSellerLink(trackingId: string): Promise<SellerLink | undefined>;
  /** True once the event was applied to a deal. An event no deal took can be applied again. */
  hasEvent(id: string): Promise<boolean>;
  /** Records a processed event. A record that already names a deal is never replaced. */
  recordEvent(event: WebhookEventRecord): Promise<void>;
  saveDemoSession(session: DemoSession): Promise<void>;
  getDemoSession(id: string): Promise<DemoSession | undefined>;
  /** Deletes judge sessions created before `before`, with their demo deals and receipts. Never touches a deal without a demo tag. */
  purgeDemo(before: string): Promise<number>;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Read-modify-write on one deal, retried when another write got there first. `change` gets the
 * latest deal and returns the next one.
 */
export async function updateWithRetry(store: DealStore, id: string, change: (deal: Deal) => Deal, attempts = 3): Promise<{ before: Deal; after: Deal }> {
  for (let attempt = 1; ; attempt++) {
    const stored = await store.getDeal(id);
    if (!stored) throw new Error('no such deal');
    const after = change(structuredClone(stored.value));
    try {
      await store.updateDeal(id, stored.version, after);
      return { before: stored.value, after };
    } catch (error) {
      if (!(error instanceof StaleWriteError) || attempt >= attempts) throw error;
    }
  }
}

export class MemoryDealStore implements DealStore {
  private deals = new Map<string, Stored<Deal>>();
  private receipts = new Map<string, Receipt[]>();
  private sellers = new Map<string, SellerLink>();
  private events = new Map<string, WebhookEventRecord>();
  private demo = new Map<string, DemoSession>();
  private memory = new Map<string, MemoryEntry>();

  async addMemory(entries: MemoryEntry[]) {
    for (const e of entries) {
      const k = `${e.namespace}|${e.kind}|${e.hash}|${e.dealId}`;
      if (!this.memory.has(k)) this.memory.set(k, clone(e));
    }
  }

  async removeMemory(namespace: string, dealId: string, by: string, reason: string) {
    for (const [k, e] of this.memory) if (e.namespace === namespace && e.dealId === dealId && e.by === by && e.reason === reason) this.memory.delete(k);
  }

  async findMemory(namespace: string, hashes: string[], since: string) {
    const want = new Set(hashes);
    return [...this.memory.values()].filter((e) => e.namespace === namespace && want.has(e.hash) && e.at >= since).map(clone);
  }

  async createDeal(deal: Deal) {
    if (this.deals.has(deal.id)) throw new Error('deal already exists');
    this.deals.set(deal.id, { version: 1, value: clone(deal) });
  }

  async getDeal(id: string) {
    const stored = this.deals.get(id);
    return stored && clone(stored);
  }

  async updateDeal(id: string, version: number, deal: Deal) {
    const stored = this.deals.get(id);
    if (!stored || stored.version !== version) throw new StaleWriteError();
    const next = { version: version + 1, value: clone(deal) };
    this.deals.set(id, next);
    return clone(next);
  }

  async addReceipt(input: ReceiptInput) {
    const chain = this.receipts.get(input.dealId) ?? [];
    const receipt = makeReceipt(chain.at(-1), clone(input));
    this.receipts.set(input.dealId, [...chain, receipt]);
    return clone(receipt);
  }

  async listReceipts(dealId: string) {
    return clone(this.receipts.get(dealId) ?? []);
  }

  async saveSellerLink(link: SellerLink) {
    this.sellers.set(link.trackingId, clone(link));
  }

  async getSellerLink(trackingId: string) {
    const link = this.sellers.get(trackingId);
    return link && clone(link);
  }

  async hasEvent(id: string) {
    return !!this.events.get(id)?.dealId;
  }

  async recordEvent(event: WebhookEventRecord) {
    if (!this.events.get(event.id)?.dealId) this.events.set(event.id, clone(event));
  }

  async saveDemoSession(session: DemoSession) {
    this.demo.set(session.id, clone(session));
  }

  async getDemoSession(id: string) {
    const s = this.demo.get(id);
    return s && clone(s);
  }

  async purgeDemo(before: string) {
    let n = 0;
    for (const [id, s] of this.demo) {
      if (s.createdAt >= before) continue;
      for (const d of s.deals) {
        if (!this.deals.get(d.dealId)?.value.demo) continue;
        this.deals.delete(d.dealId);
        this.receipts.delete(d.dealId);
        for (const [eid, e] of this.events) if (e.dealId === d.dealId) this.events.delete(eid);
        n++;
      }
      this.demo.delete(id);
      for (const [k, e] of this.memory) if (e.namespace === `demo:${id}`) this.memory.delete(k);
    }
    return n;
  }
}
