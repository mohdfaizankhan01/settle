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
import type { Json } from './canonical';
import { GENESIS_HASH, type Receipt } from './receipts';
import { recordMessage, RECORD_FORMAT, verifyRecordWith, type KeyKind, type PublicKeyInfo, type RecordBody, type RecordCheck, type SignedRecord, type VerifyCrypto } from './verify-core';

export { RECORD_FORMAT, type Check, type KeyKind, type PublicKeyInfo, type RecordBody, type RecordCheck, type SignedRecord } from './verify-core';
export type SigningKey = { privateKey: KeyObject; info: PublicKeyInfo };

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

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
  const value = sign(null, recordMessage(body), key.privateKey).toString('base64url');
  return { format: RECORD_FORMAT, body, signature: { alg: 'Ed25519', keyId: key.info.keyId, kind: key.info.kind, value } };
}

/** The Node side of the shared check: node:crypto for SHA-256 and Ed25519. */
export const nodeCrypto: VerifyCrypto = {
  sha256Hex: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
  ed25519Verify: async (publicKey, message, signature) =>
    verify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }), signature),
};

/** Checks a record against the published keys, with the same code the /verify page runs in a browser. Never throws. */
export const verifyRecord = (input: unknown, keys: readonly PublicKeyInfo[]): Promise<RecordCheck> => verifyRecordWith(input, keys, nodeCrypto);

/** SHA-256 of an evidence PDF, as the record stores it. */
export const pdfSha256 = (pdf: Uint8Array) => createHash('sha256').update(pdf).digest('hex');

/** Json-safe view for responses. */
export const recordJson = (r: SignedRecord) => r as unknown as Json;
