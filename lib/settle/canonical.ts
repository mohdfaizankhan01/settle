// Canonical JSON and SHA-256, shared by the deal hash and the receipt chain. Keys are sorted at
// every level so the same data always hashes the same. Values JSON can't round-trip exactly
// (undefined, NaN, Infinity, functions) throw instead of being silently dropped.

import { createHash } from 'node:crypto';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const hashJson = (value: unknown) => sha256Hex(canonicalJson(value));
