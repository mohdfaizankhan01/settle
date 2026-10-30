// Features for Settle's own warning model: word unigrams and bigrams plus character 3- to
// 5-grams of a redacted message, hashed into a fixed number of slots (no vocabulary file),
// binary and L2-normalised. Redaction placeholders become single words such as <price> and
// <link_other>, so the model learns "a non-PayPal link" rather than any real URL.

export const DIMS = 1 << 15;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[link_\d+ \(not paypal\)\]/g, ' linkother ')
    .replace(/\[link_\d+ \(paypal\)\]/g, ' linkpaypal ')
    .replace(/\[(price|date|postcode|zip)_\d+\]/g, (_, k: string) => ` ${k}tok `)
    .replace(/\[(email|card|iban|sortcode|wallet|phone|address|number|name|seller|buyer)\]/g, (_, k: string) => ` ${k}tok `)
    .replace(/f\s?[&+]\s?f/g, ' fandf ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// FNV-1a, 32-bit.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type SparseVector = { idx: Int32Array; val: Float32Array };

export function featurise(text: string): SparseVector {
  const norm = normalise(text);
  const words = norm.split(' ').filter(Boolean);
  const keys = new Set<string>();
  for (const w of words) keys.add(`w:${w}`);
  for (let i = 0; i + 1 < words.length; i++) keys.add(`b:${words[i]} ${words[i + 1]}`);
  const padded = ` ${norm} `;
  for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= padded.length; i++) keys.add(`c:${padded.slice(i, i + n)}`);
  const slots = new Set<number>();
  for (const k of keys) slots.add(hash(k) % DIMS);
  const idx = Int32Array.from([...slots].sort((a, b) => a - b));
  const v = idx.length ? 1 / Math.sqrt(idx.length) : 0;
  return { idx, val: new Float32Array(idx.length).fill(v) };
}
