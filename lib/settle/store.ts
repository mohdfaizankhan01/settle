// Storage for deals, receipts and seller onboarding. One interface, two versions: in-memory for
// tests and local runs without a database, Postgres for the app. Deal updates are optimistic:
// a write based on a stale version fails, so two confirmations can't overwrite each other.

import { makeReceipt, type Receipt, type ReceiptInput } from './receipts';
import type { Deal } from './types';

export type Stored<T> = { version: number; value: T };

/** A seller's Partner Referrals onboarding, keyed by our own random tracking ID. */
export type SellerLink = { trackingId: string; dealId: string; createdAt: string; merchantId?: string };

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
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryDealStore implements DealStore {
  private deals = new Map<string, Stored<Deal>>();
  private receipts = new Map<string, Receipt[]>();
  private sellers = new Map<string, SellerLink>();

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
}
