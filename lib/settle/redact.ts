// Redacts chat text before it reaches Jev or any LLM (CLAUDE.md). Personal details are removed
// outright. Prices, dates, links, postcodes and ZIPs become numbered tokens ([PRICE_1], [DATE_2],
// [LINK_1 (not PayPal)]): the model sees where they are and can pick one, but the values stay in
// code. Detection runs over the original text in priority order and spans never overlap, so a
// placeholder is never re-matched by a later pattern.

import type { ChatMessage, Role } from './chat';

export type TokenKind = 'PRICE' | 'DATE' | 'LINK' | 'POSTCODE' | 'ZIP';
type RemovedKind = 'EMAIL' | 'CARD' | 'IBAN' | 'SORTCODE' | 'WALLET' | 'PHONE' | 'ADDRESS' | 'NUMBER';

export type Token = {
  /** PRICE_1, DATE_2, …, numbered in chat order. */
  id: string;
  kind: TokenKind;
  messageId: string;
  /** Original text. Never sent to a model. */
  raw: string;
  /** PRICE: decimal amount as a string ("1200.00") and currency, if one was written. */
  amount?: string;
  currency?: 'GBP' | 'USD' | 'EUR' | 'CAD' | 'AUD';
  /** LINK: host, and whether it is PayPal's own (paypal.com or paypal.me, exact suffix). */
  host?: string;
  isPayPal?: boolean;
};

export type RedactedMessage = { id: string; role: Role; text: string };
export type Redacted = { messages: RedactedMessage[]; tokens: Token[] };

type Rule = { kind: TokenKind | RemovedKind; re: RegExp };

const CURRENCY_WORDS = String.raw`gbp|usd|eur|cad|aud|quid|pounds?|bucks|dollars?|euros?`;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const MONTHS = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const UNITS = String.raw`gb|tb|mb|mm|cm|m|inch(?:es)?|in|days?|hours?|hrs?|mins?|minutes|years?|yrs?|months?|weeks?|km|miles?|kg|g|lbs?|%|x|pm|am|st|nd|rd|th|ml|l`;

// Priority order: earlier rules win overlaps.
const RULES: Rule[] = [
  { kind: 'EMAIL', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    kind: 'LINK',
    // The whole dotted run is taken, so "paypal.com.evil.ru" is one link whose host isn't PayPal's.
    re: /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?/gi,
  },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g },
  { kind: 'WALLET', re: /\b(?:bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40})\b/g },
  { kind: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g },
  { kind: 'SORTCODE', re: /(?<=\bsort\s?code:?\s*)\d{2}[- ]?\d{2}[- ]?\d{2}\b/gi },
  {
    kind: 'DATE',
    re: new RegExp(
      [
        String.raw`\b\d{4}-\d{2}-\d{2}\b`,
        String.raw`\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b`,
        String.raw`\b\d{1,2}\.\d{1,2}\.\d{2,4}\b`,
        String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS})\b\.?(?:,?\s+\d{4})?`,
        String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?`,
        String.raw`\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next week)\b`,
      ].join('|'),
      'gi',
    ),
  },
  {
    kind: 'PRICE',
    re: new RegExp(
      [
        String.raw`(?:US\$|C\$|A\$|[£$€])\s?(?:${AMOUNT})`,
        String.raw`\b(?:gbp|usd|eur|cad|aud)\s?(?:${AMOUNT})\b`,
        String.raw`\b(?:${AMOUNT})\s?(?:[£€$]|(?:${CURRENCY_WORDS})\b)`,
        // A bare number right after a price word: "for 120", "I'll do 95", "offer 300".
        String.raw`(?<=\b(?:for|do|at|pay|paid|offer|offering|price|take|accept|asking|sell|selling|is|be)\s)\d{2,5}(?:\.\d{1,2})?\b(?![/.:]\d)(?!\s*(?:${UNITS})\b)`,
      ].join('|'),
      'gi',
    ),
  },
  { kind: 'POSTCODE', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi },
  { kind: 'ZIP', re: /(?<=\b(?:[A-Z]{2}|[Zz]ip(?:\s?code)?:?)\s+)\d{5}(?:-\d{4})?\b/g },
  {
    kind: 'ADDRESS',
    re: /\b\d{1,5}\s+(?:[A-Za-z]+\s+){1,3}(?:st|street|ave|avenue|rd|road|ln|lane|dr|drive|blvd|way|close|court|ct|place|pl|crescent|terrace)\b\.?/gi,
  },
  { kind: 'PHONE', re: /(?:\+|\b)\d[\d\s().-]{7,}\d\b/g },
  // Remaining long numbers: one-time codes, account numbers, order references.
  { kind: 'NUMBER', re: /\b\d{6,}\b/g },
];

const TLDS = new Set(['com', 'me', 'co', 'uk', 'io', 'net', 'org', 'app', 'link', 'ly', 'xyz', 'shop', 'store', 'pay', 'info', 'biz', 'online', 'site']);

/** A bare dotted run is a link if its last label is a known TLD or a two-letter country code. */
function looksLikeLink(raw: string): boolean {
  if (/^(?:https?:\/\/|www\.)/i.test(raw)) return true;
  const last = raw.split('/')[0].split('.').pop()!.toLowerCase();
  return TLDS.has(last) || /^[a-z]{2}$/.test(last);
}

const TOKEN_KINDS = new Set<string>(['PRICE', 'DATE', 'LINK', 'POSTCODE', 'ZIP']);

type Span = { start: number; end: number; kind: Rule['kind']; raw: string };

function findSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const { kind, re } of RULES) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (kind === 'LINK' && !looksLikeLink(m[0])) continue;
      if (kind === 'PHONE' && m[0].replace(/\D/g, '').length < 9) continue;
      // "PS5 2TB" looks like a postcode; real inward codes never end in a unit or ordinal.
      if (kind === 'POSTCODE' && /\d(?:tb|gb|mb|kg|nd|rd|th|st)$/i.test(m[0])) continue;
      if (spans.some((s) => start < s.end && end > s.start)) continue;
      spans.push({ start, end, kind, raw: m[0] });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

const SYMBOLS: Record<string, Token['currency']> = { '£': 'GBP', '€': 'EUR', $: 'USD', us$: 'USD', c$: 'CAD', a$: 'AUD' };
const WORDS: Record<string, Token['currency']> = {
  gbp: 'GBP', quid: 'GBP', pound: 'GBP', pounds: 'GBP',
  usd: 'USD', buck: 'USD', bucks: 'USD', dollar: 'USD', dollars: 'USD',
  eur: 'EUR', euro: 'EUR', euros: 'EUR',
  cad: 'CAD', aud: 'AUD',
};

export function parsePrice(raw: string): Pick<Token, 'amount' | 'currency'> {
  const lower = raw.toLowerCase();
  const number = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/.exec(lower)?.[0] ?? '';
  const amount = Number(number.replace(/,/g, '')).toFixed(2);
  const symbol = /us\$|c\$|a\$|[£€$]/.exec(lower)?.[0];
  const word = new RegExp(`\\b(?:${CURRENCY_WORDS})\\b`).exec(lower)?.[0];
  const currency = symbol ? SYMBOLS[symbol] : word ? WORDS[word] : undefined;
  return currency ? { amount, currency } : { amount };
}

function linkHost(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const isPayPalHost = (host: string) => ['paypal.com', 'paypal.me'].some((d) => host === d || host.endsWith(`.${d}`));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Name parts that are ordinary words ("Me" and "You" in WhatsApp exports) are left alone.
const NOT_NAMES = new Set(['you', 'me', 'the', 'and', 'mum', 'mom', 'dad', 'buyer', 'seller']);

/** Replaces each name (and each part of it) with its label, e.g. "[SELLER]". */
function replaceNames(text: string, names: { name: string; label: string }[]): string {
  const parts = names
    .flatMap(({ name, label }) =>
      [name, ...name.split(/\s+/)].filter((p) => p.length >= 3 && !NOT_NAMES.has(p.toLowerCase())).map((p) => ({ p, label })),
    )
    .sort((a, b) => b.p.length - a.p.length);
  return parts.reduce((out, { p, label }) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(p)}(?![\\p{L}\\p{N}_])`, 'giu'), label), text);
}

/**
 * Square brackets a person typed become round ones, so a typed "[PRICE_1]" or "[SELLER]" can't
 * pass for one of Settle's placeholders in what a model reads.
 */
const defang = (text: string) => text.replace(/\[/g, '(').replace(/\]/g, ')');

export function redactChat(messages: readonly ChatMessage[], extraNames: string[] = []): Redacted {
  const names = [
    ...new Map(messages.map((m) => [m.speaker, { name: m.speaker, label: `[${m.role.toUpperCase()}]` }])).values(),
    ...extraNames.map((name) => ({ name, label: '[NAME]' })),
  ];
  const counters = new Map<TokenKind, number>();
  const tokens: Token[] = [];

  const redacted = messages.map((message): RedactedMessage => {
    let out = '';
    let at = 0;
    for (const span of findSpans(message.text)) {
      out += replaceNames(defang(message.text.slice(at, span.start)), names);
      at = span.end;
      if (!TOKEN_KINDS.has(span.kind)) {
        out += `[${span.kind}]`;
        continue;
      }
      const kind = span.kind as TokenKind;
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      const token: Token = { id: `${kind}_${n}`, kind, messageId: message.id, raw: span.raw };
      if (kind === 'PRICE') Object.assign(token, parsePrice(span.raw));
      if (kind === 'LINK') {
        token.host = linkHost(span.raw);
        token.isPayPal = isPayPalHost(token.host);
      }
      tokens.push(token);
      out += kind === 'LINK' ? `[${token.id} (${token.isPayPal ? 'PayPal' : 'not PayPal'})]` : `[${token.id}]`;
    }
    out += replaceNames(defang(message.text.slice(at)), names);
    return { id: message.id, role: message.role, text: out };
  });

  return { messages: redacted, tokens };
}
