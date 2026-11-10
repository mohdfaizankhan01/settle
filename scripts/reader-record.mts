// npm run reader:record — reads each judge-mode chat once with the AI reader (live, GROQ_API_KEY)
// and writes data/demo/reader-recorded.json, so judge mode shows a reading with no key set
// ("Reading recorded on <date>"). Only the redacted reading is stored: IDs, sure flags and quotes
// from the redacted chat. Re-run after changing the prompt (PROMPT_VERSION) or a demo chat.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatHash, type RecordedReading } from '../lib/reader/deal-reader';
import { PROMPT_VERSION, readDeal, readerModel } from '../lib/reader/read';
import { parseChat } from '../lib/settle/chat';
import { SCENARIOS } from '../lib/settle/demo';
import { redactChat } from '../lib/settle/redact';

const readings: RecordedReading[] = [];
const seen = new Set<string>();
for (const s of SCENARIOS) {
  const r = redactChat(parseChat(s.chat, s.seller));
  const hash = chatHash(r);
  if (seen.has(hash)) continue;
  seen.add(hash);
  if (readings.length) await new Promise((f) => setTimeout(f, 16_000));
  const run = await readDeal(r);
  if (run.status !== 'ran') throw new Error(`${s.id}: the reader ${run.status} (${run.reason}); nothing written`);
  readings.push({ promptVersion: PROMPT_VERSION, model: run.model, chatHash: hash, run });
  console.log(`${s.id}: ${run.reading.claims.length} claims, ${run.usage.input}/${run.usage.output} tokens, ${run.ms} ms`);
}
writeFileSync(
  join(process.cwd(), 'data', 'demo', 'reader-recorded.json'),
  `${JSON.stringify({ note: 'AI reader answers for the judge-mode chats, recorded with npm run reader:record. Redacted readings only: IDs, sure flags and quotes from the redacted chat.', model: readerModel(), readings }, null, 2)}\n`,
);
console.log(`wrote ${readings.length} readings`);
