// Android share sheet → Settle Link (PLAN M6, app/share/route.ts). Helpers kept here so they can be
// tested: the chat a share carries, and JSON that is safe to put inside a <script>.

import { MAX_CHAT_CHARS } from './policy';

/** Where the shared chat waits in the tab's session storage for the "make a deal link" page. */
export const SHARED_CHAT_SLOT = 'settle-shared-chat';

/** JSON for inside a <script>: nothing in it can close the tag or break the line. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The chat from a share: the text, plus the shared URL if the app sent one separately. Capped. */
export function sharedChat(form: FormData): string {
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const text = field('text');
  const url = field('url');
  const joined = url && !text.includes(url) ? `${text}\n${url}` : text;
  return joined.slice(0, MAX_CHAT_CHARS);
}

/** The page the share POST answers with: it stores the chat in this tab, then opens the form. */
export function sharePage(chat: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Settle Link</title>
<p>Opening Settle Link…</p>
<script>try{sessionStorage.setItem(${scriptJson(SHARED_CHAT_SLOT)},${scriptJson(chat)})}catch(e){}location.replace('/check')</script>`;
}
