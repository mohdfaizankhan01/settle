// Postgres version of DealStore (driver: `postgres`, DECISIONS #11). Each deal is one JSONB
// document with a version column for optimistic updates. Receipts get their own rows; adding
// one locks the deal row so two writers can't fork the chain, and (deal_id, seq) is the backstop.

import postgres, { type JSONValue, type Sql } from 'postgres';
import { makeReceipt, type Receipt, type ReceiptInput } from './receipts';
import { StaleWriteError, type DealStore, type SellerLink, type Stored, type WebhookEventRecord } from './store';
import type { Deal } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  id text PRIMARY KEY,
  version integer NOT NULL,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receipts (
  deal_id text NOT NULL REFERENCES deals(id),
  seq integer NOT NULL,
  hash text NOT NULL,
  doc jsonb NOT NULL,
  PRIMARY KEY (deal_id, seq)
);
CREATE TABLE IF NOT EXISTS seller_links (
  tracking_id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES deals(id),
  doc jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id text PRIMARY KEY,
  doc jsonb NOT NULL
);`;

const json = (sql: Sql, value: unknown) => sql.json(value as JSONValue);

export class PgDealStore implements DealStore {
  private ready: Promise<unknown> | undefined;

  constructor(private sql: Sql) {}

  static fromUrl(url: string) {
    // Render's external URL needs TLS; its internal URL works with or without.
    return new PgDealStore(postgres(url, { max: 5, ssl: url.includes('render.com') ? 'require' : undefined }));
  }

  private schema() {
    this.ready ??= this.sql.unsafe(SCHEMA).catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async createDeal(deal: Deal) {
    await this.schema();
    await this.sql`INSERT INTO deals (id, version, doc) VALUES (${deal.id}, 1, ${json(this.sql, deal)})`;
  }

  async getDeal(id: string): Promise<Stored<Deal> | undefined> {
    await this.schema();
    const [row] = await this.sql<{ version: number; doc: Deal }[]>`SELECT version, doc FROM deals WHERE id = ${id}`;
    return row && { version: row.version, value: row.doc };
  }

  async updateDeal(id: string, version: number, deal: Deal) {
    await this.schema();
    const rows = await this.sql`
      UPDATE deals SET version = version + 1, doc = ${json(this.sql, deal)}
      WHERE id = ${id} AND version = ${version} RETURNING version`;
    if (rows.length !== 1) throw new StaleWriteError();
    return { version: version + 1, value: deal };
  }

  async addReceipt(input: ReceiptInput): Promise<Receipt> {
    await this.schema();
    return this.sql.begin(async (tx) => {
      const locked = await tx`SELECT id FROM deals WHERE id = ${input.dealId} FOR UPDATE`;
      if (locked.length !== 1) throw new Error('no such deal');
      const [last] = await tx<{ doc: Receipt }[]>`
        SELECT doc FROM receipts WHERE deal_id = ${input.dealId} ORDER BY seq DESC LIMIT 1`;
      const receipt = makeReceipt(last?.doc, input);
      await tx`
        INSERT INTO receipts (deal_id, seq, hash, doc)
        VALUES (${receipt.dealId}, ${receipt.seq}, ${receipt.hash}, ${tx.json(receipt as unknown as JSONValue)})`;
      return receipt;
    }) as Promise<Receipt>;
  }

  async listReceipts(dealId: string) {
    await this.schema();
    const rows = await this.sql<{ doc: Receipt }[]>`SELECT doc FROM receipts WHERE deal_id = ${dealId} ORDER BY seq`;
    return rows.map((r) => r.doc);
  }

  async saveSellerLink(link: SellerLink) {
    await this.schema();
    await this.sql`
      INSERT INTO seller_links (tracking_id, deal_id, doc) VALUES (${link.trackingId}, ${link.dealId}, ${json(this.sql, link)})
      ON CONFLICT (tracking_id) DO UPDATE SET doc = EXCLUDED.doc`;
  }

  async getSellerLink(trackingId: string) {
    await this.schema();
    const [row] = await this.sql<{ doc: SellerLink }[]>`SELECT doc FROM seller_links WHERE tracking_id = ${trackingId}`;
    return row?.doc;
  }

  async hasEvent(id: string) {
    await this.schema();
    const rows = await this.sql`SELECT 1 FROM webhook_events WHERE id = ${id} AND doc->>'dealId' IS NOT NULL`;
    return rows.length > 0;
  }

  async recordEvent(event: WebhookEventRecord) {
    await this.schema();
    await this.sql`
      INSERT INTO webhook_events (id, doc) VALUES (${event.id}, ${json(this.sql, event)})
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc WHERE webhook_events.doc->>'dealId' IS NULL`;
  }
}
