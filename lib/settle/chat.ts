// Parses a pasted chat into numbered messages. Accepts plain "Name: text" lines and the common
// WhatsApp export prefixes ("[22/10/2026, 10:15:03] Name: text", "22/10/2026, 10:15 - Name: text").
// A deal chat has two people, so the two most frequent "Name:" prefixes are the speakers; any
// other line (including "Price: 50" inside a message) continues the previous message.

import { MAX_CHAT_CHARS, MAX_MESSAGES } from './policy';

export type Role = 'seller' | 'buyer';

export type ChatMessage = {
  /** Stable ID used for source quotes: m1, m2, … */
  id: string;
  speaker: string;
  role: Role;
  text: string;
};

export class ChatError extends Error {}

// Optional timestamp, then a speaker name (no colon, up to 40 chars), then ": ".
const TIMESTAMP = String.raw`(?:\[[^\]]{4,40}\]\s*|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?\s+-\s+)?`;
const LINE = new RegExp(`^${TIMESTAMP}~?\\s*([^:\\n]{1,40}?)\\s*:\\s?(.*)$`);
// Invisible marks WhatsApp adds around names and attachments.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;

type Line = { speaker?: string; text: string };

function splitLines(raw: string): Line[] {
  return raw
    .replace(INVISIBLE, '')
    .split(/\r?\n/)
    .map((line): Line => {
      const m = LINE.exec(line);
      return m ? { speaker: m[1].trim(), text: m[2] } : { text: line };
    });
}

/** The two speakers in the chat, most frequent first. */
export function findSpeakers(raw: string): string[] {
  const counts = new Map<string, number>();
  for (const { speaker } of splitLines(raw)) if (speaker) counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
}

export function parseChat(raw: string, sellerName: string): ChatMessage[] {
  if (raw.length > MAX_CHAT_CHARS) throw new ChatError(`chat is longer than ${MAX_CHAT_CHARS} characters`);
  const speakers = findSpeakers(raw);
  if (speakers.length !== 2) throw new ChatError('chat needs two speakers, as "Name: message" lines');
  if (!speakers.includes(sellerName)) throw new ChatError('the seller must be one of the two speakers');

  const messages: ChatMessage[] = [];
  for (const line of splitLines(raw)) {
    if (line.speaker && speakers.includes(line.speaker)) {
      messages.push({
        id: `m${messages.length + 1}`,
        speaker: line.speaker,
        role: line.speaker === sellerName ? 'seller' : 'buyer',
        text: line.text.trim(),
      });
    } else if (messages.length > 0) {
      const prev = messages[messages.length - 1];
      const text = line.speaker ? `${line.speaker}: ${line.text}` : line.text;
      prev.text = `${prev.text}\n${text}`.trim();
    }
    if (messages.length > MAX_MESSAGES) throw new ChatError(`chat has more than ${MAX_MESSAGES} messages`);
  }
  return messages.filter((m) => m.text.length > 0).map((m, i) => ({ ...m, id: `m${i + 1}` }));
}
