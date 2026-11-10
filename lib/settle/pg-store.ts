// Postgres version of DealStore (driver: `postgres`, DECISIONS #11). Each deal is one JSONB
// document with a version column for optimistic updates. Receipts get their own rows; adding
// one locks the deal row so two writers can't fork the chain, and (deal_id, seq) is the backstop.

import postgres, { type JSONValue, type Sql } from 'postgres';
import { makeReceipt, type Receipt, type ReceiptInput } from './receipts';
import { StaleWriteError, type DealStore, type DemoSession, type MemoryEntry, type SellerLink, type Stored, type WebhookEventRecord } from './store';
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
CREATE TABLE IF NOT EXISTS demo_sessions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  doc jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id text PRIMARY KEY,
  doc jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS scam_memory (
  namespace text NOT NULL,
  kind text NOT NULL,
  hash text NOT NULL,
  deal_id text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (namespace, kind, hash, deal_id)
);
CREATE INDEX IF NOT EXISTS scam_memory_lookup ON scam_memory (namespace, hash, at);
ALTER TABLE scam_memory ADD COLUMN IF NOT EXISTS reporter text;
ALTER TABLE scam_memory ADD COLUMN IF NOT EXISTS by_role text;
ALTER TABLE scam_memory ADD COLUMN IF NOT EXISTS reason text;`;

const json = (sql: Sql, value: unknown) => sql.json(value as JSONValue);

export class PgDealStore implements DealStore {
  private ready: Promise<unknown> | undefined;

  constructor(private sql: Sql) {}

  static fromUrl(url: string) {
    // Render's external URL and Neon (DECISIONS #21) need TLS; Render's internal URL works with or without.
    const tls = url.includes('render.com') || url.includes('neon.tech') || url.includes('sslmode=require');
    return new PgDealStore(postgres(url, { max: 5, ssl: tls ? 'require' : undefined }));
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

  async addMemory(entries: MemoryEntry[]) {
    if (entries.length === 0) return;
    await this.schema();
    for (const e of entries) {
      await this.sql`
        INSERT INTO scam_memory (namespace, kind, hash, deal_id, at, reporter, by_role, reason) VALUES (${e.namespace}, ${e.kind}, ${e.hash}, ${e.dealId}, ${e.at}, ${e.reporter ?? null}, ${e.by ?? null}, ${e.reason ?? null})
        ON CONFLICT DO NOTHING`;
    }
  }

  async findMemory(namespace: string, hashes: string[], since: string) {
    if (hashes.length === 0) return [];
    await this.schema();
    const rows = await this.sql<{ namespace: string; kind: string; hash: string; deal_id: string; at: Date; reporter: string | null }[]>`
      SELECT namespace, kind, hash, deal_id, at, reporter FROM scam_memory
      WHERE namespace = ${namespace} AND hash IN ${this.sql(hashes)} AND at >= ${since}`;
    return rows.map((r) => ({ namespace: r.namespace, kind: r.kind, hash: r.hash, dealId: r.deal_id, at: new Date(r.at).toISOString(), ...(r.reporter ? { reporter: r.reporter } : {}) }));
  }

  async removeMemory(namespace: string, dealId: string, by: string, reason: string) {
    await this.schema();
    await this.sql`DELETE FROM scam_memory WHERE namespace = ${namespace} AND deal_id = ${dealId} AND by_role = ${by} AND reason = ${reason}`;
  }

  async saveDemoSession(session: DemoSession) {
    await this.schema();
    await this.sql`
      INSERT INTO demo_sessions (id, created_at, doc) VALUES (${session.id}, ${session.createdAt}, ${json(this.sql, session)})
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`;
  }

  async getDemoSession(id: string) {
    await this.schema();
    const [row] = await this.sql<{ doc: DemoSession }[]>`SELECT doc FROM demo_sessions WHERE id = ${id}`;
    return row?.doc;
  }

  async purgeDemo(before: string) {
    await this.schema();
    return this.sql.begin(async (tx) => {
      // Only deals carrying a demo tag and listed in an expired session; real deals can't match.
      const ids = await tx<{ id: string }[]>`
        SELECT d.id FROM deals d
        JOIN demo_sessions s ON s.doc->'deals' @> jsonb_build_array(jsonb_build_object('dealId', d.id))
        WHERE s.created_at < ${before} AND d.doc ? 'demo'`;
      const list = ids.map((r) => r.id);
      if (list.length > 0) {
        await tx`DELETE FROM receipts WHERE deal_id IN ${tx(list)}`;
        await tx`DELETE FROM seller_links WHERE deal_id IN ${tx(list)}`;
        await tx`DELETE FROM webhook_events WHERE doc->>'dealId' IN ${tx(list)}`;
        await tx`DELETE FROM deals WHERE id IN ${tx(list)} AND doc ? 'demo'`;
      }
      // A judge session's own scam memory goes with it.
      await tx`DELETE FROM scam_memory WHERE namespace IN (SELECT 'demo:' || id FROM demo_sessions WHERE created_at < ${before})`;
      await tx`DELETE FROM demo_sessions WHERE created_at < ${before}`;
      return list.length;
    }) as Promise<number>;
  }
}
