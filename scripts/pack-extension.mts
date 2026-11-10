// Zips the Chrome extension for the Chrome Web Store: only the files Chrome loads (no tests, docs
// or package.json). `npm run ext:pack` → dist/settle-link-chrome-<version>.zip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `settle-link-chrome-${version}.zip`);
mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, 'manifest.json', 'popup.html', 'popup.css', 'popup.js', 'lib', 'icons', '-x', '*.DS_Store'], { cwd: dir, stdio: 'inherit' });
console.log(`\n${out}`);
