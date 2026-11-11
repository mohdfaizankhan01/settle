// The check behind /verify, written once and run in two places: in the browser on the /verify page
// (WebCrypto) and in Node by `npm run verify:record` and the tests (node:crypto). It has no Node
// imports: the crypto it needs (SHA-256 and Ed25519 verification) is passed in, so a verdict can't
// differ between the two. It never throws on bad input: a malformed record is a failed check.

import { canonicalJson } from './canonical-json';
import type { Receipt } from './receipts';

export const RECORD_FORMAT = 'settle-link-record/1';
/** The previous-hash of the first receipt (the same value as receipts.ts). */
export const GENESIS = '0'.repeat(64);
export type KeyKind = 'live' | 'demo';

/** What the public key list publishes for one key. */
export type PublicKeyInfo = { alg: 'Ed25519'; keyId: string; publicKey: string; kind: KeyKind };

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

export type Check = { id: string; status: 'pass' | 'fail' | 'info'; detail: string };
/**
 * `ok`: no check failed. `verdict`: what a page may headline. A record signed with the public demo
 * key is never "verified": anyone can sign with that key, so it only shows the file format.
 */
export type Verdict = 'verified' | 'demo' | 'failed';
export type RecordCheck = { ok: boolean; verdict: Verdict; /** The kind of the published key that matched (not the label in the file). */ kind: KeyKind | null; checks: Check[] };

/** The crypto the check needs. Each environment supplies its own. */
export type VerifyCrypto = {
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** Ed25519 verify; `publicKey` is the raw 32-byte key as base64url. May throw when unsupported. */
  ed25519Verify(publicKey: string, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
};

const utf8 = (text: string) => new TextEncoder().encode(text);

/** The exact bytes that are signed. Used by both signing and checking, so they can't drift. */
export const recordMessage = (body: RecordBody) => utf8(`${RECORD_FORMAT}\n${canonicalJson(body)}`);

export function base64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The receipt hash, as receipts.ts computes it. */
const receiptHash = (c: VerifyCrypto, r: Receipt) =>
  c.sha256Hex(utf8(canonicalJson({ seq: r.seq, dealId: r.dealId, kind: r.kind, at: r.at, data: r.data, prevHash: r.prevHash })));

/** Walks the receipt chain the way receipts.ts verifyChain does; returns the first problem, or null. */
export async function chainProblem(c: VerifyCrypto, receipts: readonly Receipt[]): Promise<{ at: number; reason: string } | null> {
  let prev = GENESIS;
  for (const [i, r] of receipts.entries()) {
    if (!isObject(r) || typeof r.hash !== 'string') return { at: i, reason: 'not a receipt' };
    if (r.seq !== i) return { at: i, reason: 'sequence gap or reorder' };
    if (r.dealId !== receipts[0].dealId) return { at: i, reason: 'mixed deals' };
    if (r.prevHash !== prev) return { at: i, reason: 'previous hash does not match' };
    let h: string;
    try {
      h = await receiptHash(c, r);
    } catch {
      return { at: i, reason: 'receipt could not be hashed' };
    }
    if (h !== r.hash) return { at: i, reason: 'receipt was changed' };
    prev = r.hash;
  }
  return null;
}

/** Checks a record against the published keys. Each check says what it found, line by line. */
export async function verifyRecordWith(input: unknown, keys: readonly PublicKeyInfo[], c: VerifyCrypto): Promise<RecordCheck> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, pass: string, fail: string) => checks.push({ id, status: ok ? 'pass' : 'fail', detail: ok ? pass : fail });
  const done = (kind: KeyKind | null): RecordCheck => {
    const ok = checks.every((x) => x.status !== 'fail');
    return { ok, verdict: !ok ? 'failed' : kind === 'demo' ? 'demo' : 'verified', kind, checks };
  };

  const record = input as { format?: unknown; body?: unknown; signature?: unknown };
  const shaped = isObject(input) && record.format === RECORD_FORMAT && isObject(record.body) && isObject(record.signature) && Array.isArray((record.body as { receipts?: unknown }).receipts);
  add('format', shaped, `A ${RECORD_FORMAT} record.`, `Not a ${RECORD_FORMAT} record.`);
  if (!shaped) return done(null);
  const { body, signature } = input as SignedRecord;

  const key = keys.find((k) => k.keyId === signature.keyId);
  add('key', !!key, `Signed with key ${signature.keyId}, which is on the list of keys used for this check${key?.kind === 'demo' ? ' (the public demo key)' : ''}.`, `Key ${String(signature.keyId)} is not on the list of keys used for this check.`);

  // The demo key is public, so a record signed with it must say it is demo data; a record that
  // claims to be a real deal under that key is refused. (The kind label inside the file is not
  // signed, so only the published key's own kind counts.)
  if (key) {
    const honest = key.kind === 'demo' ? body.demo === true : body.demo !== true;
    add(
      'kind',
      honest,
      key.kind === 'demo' ? 'The record says it is judge-mode demo data, which matches the public demo key it is signed with.' : 'The record is a real deal, signed with the live key.',
      key.kind === 'demo'
        ? 'Signed with the public demo key, but the record does not say it is demo data. Anyone can sign with that key, so this proves nothing.'
        : 'The record says it is demo data but is signed with the live key.',
    );
  }

  let signed = false;
  let unsupported = false;
  if (key) {
    try {
      signed = await c.ed25519Verify(key.publicKey, recordMessage(body), base64urlToBytes(String(signature.value)));
    } catch (error) {
      // A malformed signature is a failed check; a platform without Ed25519 is said plainly instead.
      unsupported = error instanceof Error && error.name === 'NotSupportedError';
      signed = false;
    }
  }
  add(
    'signature',
    signed,
    'The signature matches this exact record.',
    unsupported ? 'This browser cannot check Ed25519 signatures. Use `npm run verify:record` instead.' : 'The signature does not match this record: it was changed after signing, or signed with a different key.',
  );

  const problem = await chainProblem(c, body.receipts);
  add('chain', !problem, `All ${body.receipts.length} receipts link, each holding the hash of the one before.`, `The receipt chain is broken${problem ? ` at receipt ${problem.at} (${problem.reason})` : ''}.`);
  const head = body.receipts.at(-1)?.hash ?? GENESIS;
  add('head', body.chainHead === head && body.receiptCount === body.receipts.length, 'The chain head and receipt count match the receipts.', 'The chain head or receipt count does not match the receipts.');
  add('deal', body.receipts.every((r) => isObject(r) && r.dealId === body.dealId), `Every receipt belongs to deal ${body.dealId}.`, 'A receipt belongs to another deal.');
  if (body.pdf) checks.push({ id: 'pdf', status: 'info', detail: `Covers the evidence PDF for dispute ${body.pdf.disputeId} (SHA-256 ${body.pdf.sha256.slice(0, 16)}…): drop the PDF to compare.` });
  if (body.demo || key?.kind === 'demo') checks.push({ id: 'demo', status: 'info', detail: 'Judge-mode demo record: replayed data, signed with the public demo key that anyone can use. It shows the file format, not a real deal.' });
  return done(key?.kind ?? null);
}

/** Compares an evidence PDF with the hash a record carries. */
export async function checkPdfWith(record: SignedRecord, pdf: Uint8Array, c: VerifyCrypto): Promise<Check> {
  const want = record.body.pdf;
  if (!want) return { id: 'pdf', status: 'fail', detail: 'This record does not cover an evidence PDF (it was exported without a dispute).' };
  const got = await c.sha256Hex(pdf);
  return got === want.sha256
    ? { id: 'pdf', status: 'pass', detail: `This PDF is the one the record covers (dispute ${want.disputeId}, SHA-256 ${got.slice(0, 16)}…).` }
    : { id: 'pdf', status: 'fail', detail: `This PDF is not the one the record covers: it may be from a later state of the deal, or changed (its SHA-256 starts ${got.slice(0, 16)}…, the record's ${want.sha256.slice(0, 16)}…).` };
}

/** Reads a key list from JSON text: `{ "keys": [...] }`, an array, or a single key. Returns undefined when it isn't one. */
export function parseKeys(text: string): PublicKeyInfo[] | undefined {
  try {
    const v: unknown = JSON.parse(text);
    const list = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.keys) ? v.keys : [v];
    const ok = list.every((k) => isObject(k) && k.alg === 'Ed25519' && typeof k.keyId === 'string' && typeof k.publicKey === 'string' && (k.kind === 'live' || k.kind === 'demo'));
    return ok && list.length > 0 ? (list as PublicKeyInfo[]) : undefined;
  } catch {
    return undefined;
  }
}
