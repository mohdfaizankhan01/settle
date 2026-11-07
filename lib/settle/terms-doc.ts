// Reads docs/protection-terms.md (the source of truth every check cites) into rows for /terms.
// Server-only: it reads the file from disk. Quotes are shown exactly as the doc has them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type TermRow = { id: string; requirement: string; us: string; uk: string; how: string };
export type TermSource = { key: string; title: string; url: string; updated: string };

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function parseTerms(md: string): { rows: TermRow[]; sources: TermSource[] } {
  const rows: TermRow[] = [];
  const sources: TermSource[] = [];
  for (const line of md.split('\n')) {
    if (/^\| (?:SP|PP)-/.test(line)) {
      const [id, requirement, us, uk, how] = cells(line);
      rows.push({ id, requirement, us, uk, how });
    } else if (/^\| (?:US|UK)-[A-Z]+ \|/.test(line)) {
      const [key, page, updated] = cells(line);
      const m = /^\[(.+)\]\((https:\/\/www\.paypal\.com\/[^)]+)\)$/.exec(page);
      if (m) sources.push({ key, title: m[1], url: m[2], updated });
    }
  }
  return { rows, sources };
}

export function loadTerms() {
  return parseTerms(readFileSync(join(process.cwd(), 'docs', 'protection-terms.md'), 'utf8'));
}
