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
  // AI reader labels (PLAN M8). Missing means the chat isn't graded on that term.
  /** The ship-by date as written in the chat, or null when none was agreed. */
  shipBy?: string | null;
  /** Words the item's name on the card should contain; null: not graded. */
  item?: string | null;
  /** The seller's statements about the item, each an exact quote of a seller message. */
  claims?: string[];
};

/** Chats for reader prompt work. Never tune on data/test-chats.jsonl. */
export const DEV_CHATS = join(process.cwd(), 'data', 'reader-dev-chats.jsonl');

export function loadChats(path = join(process.cwd(), 'data', 'test-chats.jsonl')): EvalChat[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalChat);
}
