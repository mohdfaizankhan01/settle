// Writes data/proof/proof.json for the /proof page: the test count from `npm test`, and the
// "try to fool it" attack results run now. The eval numbers come from data/eval (npm run eval).
// Run: npm run proof

import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runAttacks } from '../lib/settle/attacks';

process.env.PAYPAL_CLIENT_ID ??= 'proof-script';
const run = spawnSync('npm', ['test'], { encoding: 'utf8' });
const num = (label: string) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(run.stdout)?.[1] ?? NaN);
const attacks = await runAttacks();
const proof = {
  generatedAt: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD').toString().trim(),
  tests: { total: num('tests'), pass: num('pass'), fail: num('fail') },
  attacks: attacks.map(({ id, title, stopped, rule, test, ms }) => ({ id, title, stopped, rule, test, ms })),
};
writeFileSync('data/proof/proof.json', `${JSON.stringify(proof, null, 2)}\n`);
console.log(`tests ${proof.tests.pass}/${proof.tests.total} pass; attacks ${attacks.filter((a) => a.stopped).length}/${attacks.length} stopped`);
process.exit(proof.tests.fail === 0 && attacks.every((a) => a.stopped) ? 0 : 1);
