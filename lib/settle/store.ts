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

export class StaleWriteError extends Error {
  constructor() {
    super('the deal changed since it was read');
  }
}

export interface DealStore {
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
}
