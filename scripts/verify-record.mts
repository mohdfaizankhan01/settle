// npm run verify:record -- record.json [--pdf evidence.pdf] [--keys keys.json]
// Checks a signed deal record offline, with no network and the same check the /verify page runs in
// a browser (lib/settle/verify-core.ts). Keys: --keys takes a key list file (the JSON from
// /.well-known/settle-link-key.json, or one key). Without it, the check uses the public key
// committed in this repository (docs/signing-public-key.json) and the public demo key.
// Exit code: 0 the record checks out (signed with a real key), 3 it is a judge-mode demo record whose
// format and chain check out (signed with the public demo key, so it shows nothing about a real
// deal), 1 it does not check out, 2 usage or an unreadable file.

import { existsSync, readFileSync } from 'node:fs';
import { demoSigningKey, nodeCrypto } from '../lib/settle/signing';
import { checkPdfWith, parseKeys, verifyRecordWith, type PublicKeyInfo, type SignedRecord } from '../lib/settle/verify-core';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !['--pdf', '--keys'].includes(args[i - 1] ?? ''));
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
if (!file) fail('usage: npm run verify:record -- record.json [--pdf evidence.pdf] [--keys keys.json]');
const read = (path: string) => (existsSync(path) ? readFileSync(path) : fail(`cannot read ${path}`));

let keys: PublicKeyInfo[];
let keysFrom: string;
if (opt('keys')) {
  keys = parseKeys(read(opt('keys')!).toString('utf8')) ?? fail(`${opt('keys')} is not a key list`);
  keysFrom = opt('keys')!;
} else {
  const committed = existsSync('docs/signing-public-key.json') ? parseKeys(readFileSync('docs/signing-public-key.json', 'utf8')) : undefined;
  keys = [...(committed ?? []), demoSigningKey().info];
  keysFrom = committed ? 'docs/signing-public-key.json and the public demo key' : 'the public demo key (no docs/signing-public-key.json yet)';
}

let parsed: unknown;
try {
  parsed = JSON.parse(read(file!).toString('utf8'));
} catch {
  parsed = undefined;
}
const out = await verifyRecordWith(parsed, keys, nodeCrypto);
const rows = [...out.checks];
let pdfOk = true;
if (opt('pdf') && out.checks.find((c) => c.id === 'format')?.status === 'pass') {
  const pdf = await checkPdfWith(parsed as SignedRecord, new Uint8Array(read(opt('pdf')!)), nodeCrypto);
  pdfOk = pdf.status === 'pass';
  const at = rows.findIndex((c) => c.id === 'pdf');
  if (at >= 0) rows[at] = pdf;
  else rows.push(pdf);
}
const mark = { pass: '✓', fail: '✕', info: 'ℹ' } as const;
for (const c of rows) console.log(`${mark[c.status]} ${c.detail}`);
const verdict = out.ok && pdfOk ? out.verdict : 'failed';
const tail = `Checked against ${keysFrom}. It does not show the events happened; PayPal decides that.`;
if (verdict === 'verified') console.log(`\nThis record checks out: unchanged since it was signed. ${tail}`);
else if (verdict === 'demo') console.log(`\nDemo record: its format and chain check out, but it is signed with the public demo key that anyone can use, so this shows nothing about a real deal. ${tail}`);
else console.log(`\nThis record does NOT check out. ${tail}`);
process.exit(verdict === 'verified' ? 0 : verdict === 'demo' ? 3 : 1);
