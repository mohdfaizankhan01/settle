// Canonical JSON and SHA-256, shared by the deal hash and the receipt chain. Keys are sorted at
// every level so the same data always hashes the same. Values JSON can't round-trip exactly
// (undefined, NaN, Infinity, functions) throw instead of being silently dropped.

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

export { canonicalJson, type Json } from './canonical-json';

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const hashJson = (value: unknown) => sha256Hex(canonicalJson(value));
