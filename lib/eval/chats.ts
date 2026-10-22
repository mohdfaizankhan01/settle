// The eval set: synthetic chats written for Settle (not a benchmark). A chat counts as a negative
// for every signal it doesn't list as positive.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Delivery } from '../settle/types';

export type EvalChat = {
  id: string;
  seller: string;
  country: 'US' | 'UK';
  chat: string;
  positive: string[];
  /** Expected agreed price, or null when the chat doesn't settle one. */
  price: string | null;
  delivery: Delivery | null;
  note?: string;
};

export function loadChats(path = join(process.cwd(), 'data', 'test-chats.jsonl')): EvalChat[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalChat);
}
