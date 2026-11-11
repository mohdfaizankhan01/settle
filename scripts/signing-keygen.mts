// npm run verify:keygen — makes the Ed25519 key that signs records (/verify). The secret goes into
// .env.local as SETTLE_SIGNING_KEY and is never printed; only the public key is shown and written
// to docs/signing-public-key.json (committed, so anyone can compare it with the live one). Refuses
// to replace a key that is already set: a new key would make every earlier record fail.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeSeed, liveSigningKey } from '../lib/settle/signing';

const ENV = '.env.local';
const existing = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
if (/^SETTLE_SIGNING_KEY=\S+/m.test(existing)) {
  console.error('SETTLE_SIGNING_KEY is already set in .env.local; not replacing it (earlier records would stop verifying).');
  process.exit(1);
}

const seed = encodeSeed(randomBytes(32));
const { info } = liveSigningKey({ SETTLE_SIGNING_KEY: seed })!;
appendFileSync(ENV, `${existing && !existing.endsWith('\n') ? '\n' : ''}SETTLE_SIGNING_KEY=${seed}\n`, { mode: 0o600 });
writeFileSync('docs/signing-public-key.json', `${JSON.stringify(info, null, 2)}\n`);

console.log('Made the signing key. The secret is in .env.local (SETTLE_SIGNING_KEY); set the same value on Render. Never commit it.');
console.log(`Public key id ${info.keyId}`);
console.log(`Public key    ${info.publicKey}`);
console.log('Wrote docs/signing-public-key.json (commit this one).');
