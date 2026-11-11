// Signed records (Part B, /verify). A deal's receipt chain, its card hash and (for a dispute) the
// evidence PDF's hash are bundled into one JSON record and signed with Ed25519, so anyone can
// check later that the record is unchanged since Settle Link signed it, without trusting our
// server: the check needs only the record and the published public key.
//
// What a signature shows: this exact record was signed by the holder of the key, and its receipt
// chain still links. It does not show the events happened (PayPal decides that), and whoever holds
// the key could sign false data: with no outside anchor, this is "unchanged since signed", not
// "we couldn't have lied". Receipts hold decisions, IDs, hashes and probabilities, never chat text,
// so a record has none either.
//
// Keys: SETTLE_SIGNING_KEY is the base64 of a 32-byte Ed25519 seed (`npm run verify:keygen`). Judge
// mode (and local development without a key) signs with a fixed, public demo key: anyone can sign
// with it, so a demo record only shows the file format and says so. Production without a valid
// key signs nothing (fail closed, never a crash).

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, type Json } from './canonical';
import { GENESIS_HASH, verifyChain, type Receipt } from './receipts';

export const RECORD_FORMAT = 'settle-link-record/1';
export type KeyKind = 'live' | 'demo';

/** What the public key list publishes for one key. */
export type PublicKeyInfo = { alg: 'Ed25519'; keyId: string; publicKey: string; kind: KeyKind };
export type SigningKey = { privateKey: KeyObject; info: PublicKeyInfo };

export type RecordBody = {
  dealId: string;
  /** True for judge-mode deals: replayed data, signed with the public demo key. */
  demo: boolean;
  signedAt: string;
  /** SHA-256 of the deal card as it stood. */
  cardHash: string;
  /** Hash of the last receipt (the genesis hash when there are none). */
  chainHead: string;
  receiptCount: number;
  receipts: Receipt[];
  /** Set when the record accompanies a dispute's evidence PDF. */
  pdf: { disputeId: string; sha256: string } | null;
};

export type SignedRecord = {
  format: typeof RECORD_FORMAT;
  body: RecordBody;
  signature: { alg: 'Ed25519'; keyId: string; kind: KeyKind; value: string };
};

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const messageOf = (body: RecordBody) => Buffer.from(`${RECORD_FORMAT}\n${canonicalJson(body)}`, 'utf8');

function keyFromSeed(seed: Buffer, kind: KeyKind): SigningKey {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(String(createPublicKey(privateKey).export({ format: 'jwk' }).x), 'base64url');
  return { privateKey, info: { alg: 'Ed25519', keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16), publicKey: raw.toString('base64url'), kind } };
}

/** The public demo key's seed is not secret: it is derived from a fixed, published string. */
const DEMO_SEED = createHash('sha256').update('settle-link judge-mode demo signing key (public, not secret)').digest();
export const demoSigningKey = () => keyFromSeed(DEMO_SEED, 'demo');

/** A new seed, as the base64 `SETTLE_SIGNING_KEY` holds it. */
export const encodeSeed = (seed: Buffer) => seed.toString('base64');

type Env = Partial<Record<'NODE_ENV' | 'SETTLE_SIGNING_KEY', string>>;

/** The live key from the environment, or undefined when unset or not a 32-byte base64 seed. */
export function liveSigningKey(env: Env = process.env): SigningKey | undefined {
  const raw = env.SETTLE_SIGNING_KEY?.trim();
  if (!raw) return undefined;
  const seed = Buffer.from(raw, 'base64');
  return seed.length === 32 ? keyFromSeed(seed, 'live') : undefined;
}

/**
 * The key a deal's record is signed with. Judge-mode deals and local development without a key use
 * the public demo key; production without a valid key signs nothing.
 */
export function signingKeyFor(demoDeal: boolean, env: Env = process.env): SigningKey | undefined {
  if (demoDeal) return demoSigningKey();
  return liveSigningKey(env) ?? (env.NODE_ENV === 'production' ? undefined : demoSigningKey());
}

/** Every key a record may verify against, as published: the live key (when set) and the demo key. */
export function publishedKeys(env: Env = process.env): PublicKeyInfo[] {
  return [liveSigningKey(env)?.info, demoSigningKey().info].filter((k): k is PublicKeyInfo => !!k);
}

export type RecordInput = {
  dealId: string;
  demo: boolean;
  cardHash: string;
  receipts: readonly Receipt[];
  pdf?: { disputeId: string; sha256: string };
  now?: () => Date;
};

export function signRecord(input: RecordInput, key: SigningKey): SignedRecord {
  const receipts = [...input.receipts];
  const body: RecordBody = {
    dealId: input.dealId,
    demo: input.demo,
    signedAt: (input.now ?? (() => new Date()))().toISOString(),
    cardHash: input.cardHash,
    chainHead: receipts.at(-1)?.hash ?? GENESIS_HASH,
    receiptCount: receipts.length,
    receipts,
    pdf: input.pdf ?? null,
  };
  const value = sign(null, messageOf(body), key.privateKey).toString('base64url');
  return { format: RECORD_FORMAT, body, signature: { alg: 'Ed25519', keyId: key.info.keyId, kind: key.info.kind, value } };
}

export type Check = { id: string; status: 'pass' | 'fail' | 'info'; detail: string };
export type RecordCheck = { ok: boolean; kind: KeyKind | null; checks: Check[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a record against the published keys. Never throws: a malformed record is a failed check.
 * Each check says what it found, so a page can show it line by line.
 */
export function verifyRecord(input: unknown, keys: readonly PublicKeyInfo[]): RecordCheck {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, pass: string, fail: string) => checks.push({ id, status: ok ? 'pass' : 'fail', detail: ok ? pass : fail });
  const done = (kind: KeyKind | null): RecordCheck => ({ ok: checks.every((c) => c.status !== 'fail'), kind, checks });

  const record = input as { format?: unknown; body?: unknown; signature?: unknown };
  const shaped = isObject(input) && record.format === RECORD_FORMAT && isObject(record.body) && isObject(record.signature) && Array.isArray((record.body as { receipts?: unknown }).receipts);
  add('format', shaped, `A ${RECORD_FORMAT} record.`, `Not a ${RECORD_FORMAT} record.`);
  if (!shaped) return done(null);
  const { body, signature } = input as SignedRecord;

  const key = keys.find((k) => k.keyId === signature.keyId);
  add('key', !!key, `Signed with key ${signature.keyId}, which is on the published list${key?.kind === 'demo' ? ' (the public demo key)' : ''}.`, `Key ${String(signature.keyId)} is not on the published list.`);
  let signed = false;
  if (key) {
    try {
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' });
      signed = verify(null, messageOf(body), publicKey, Buffer.from(String(signature.value), 'base64url'));
    } catch {
      signed = false;
    }
  }
  add('signature', signed, 'The signature matches this exact record.', 'The signature does not match this record: it was changed after signing, or signed with a different key.');

  const chain = verifyChain(body.receipts);
  add('chain', chain.ok, `All ${chain.ok ? chain.count : 0} receipts link, each holding the hash of the one before.`, `The receipt chain is broken${chain.ok ? '' : ` at receipt ${chain.brokenAt} (${chain.reason})`}.`);
  const head = body.receipts.at(-1)?.hash ?? GENESIS_HASH;
  add('head', body.chainHead === head && body.receiptCount === body.receipts.length, 'The chain head and receipt count match the receipts.', 'The chain head or receipt count does not match the receipts.');
  add('deal', body.receipts.every((r) => r.dealId === body.dealId), `Every receipt belongs to deal ${body.dealId}.`, 'A receipt belongs to another deal.');
  if (body.pdf) checks.push({ id: 'pdf', status: 'info', detail: `Covers the evidence PDF for dispute ${body.pdf.disputeId} (SHA-256 ${body.pdf.sha256.slice(0, 16)}…): drop the PDF to compare.` });
  if (body.demo || key?.kind === 'demo') checks.push({ id: 'demo', status: 'info', detail: 'Judge-mode demo record: replayed data, signed with the public demo key that anyone can use. It shows the file format, not a real deal.' });
  return done(key?.kind ?? null);
}

/** SHA-256 of an evidence PDF, as the record stores it. */
export const pdfSha256 = (pdf: Uint8Array) => createHash('sha256').update(pdf).digest('hex');

/** Json-safe view for responses. */
export const recordJson = (r: SignedRecord) => r as unknown as Json;
