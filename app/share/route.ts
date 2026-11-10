import { sharedChat, sharePage } from '@/lib/settle/share';
import { readBodyLimited } from '@/lib/settle/webhook';

// A shared chat is at most 20,000 characters; this leaves room for UTF-8 and form encoding.
const MAX_SHARE_BYTES = 256 * 1024;

// Android share sheet → Settle Link (PLAN M6). The shared chat arrives in the POST body, so it never
// sits in a URL or a server log, and it isn't stored on the server: the page puts it in the tab's
// own session storage and opens "make a deal link", which reads it once. Redaction and the warning
// check run as usual when the deal is made.
export async function POST(request: Request) {
  let chat = '';
  try {
    // Read at most MAX_SHARE_BYTES before parsing, so a huge cross-site post is never buffered.
    const raw = await readBodyLimited(request, MAX_SHARE_BYTES);
    if (raw !== undefined) {
      const form = await new Request('http://share.local', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') ?? '' }, body: raw }).formData();
      chat = sharedChat(form);
    }
  } catch {
    // Not a form post: open the empty form.
  }
  return new Response(sharePage(chat), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// Opened directly (not from a share): go to the normal form.
export function GET(request: Request) {
  return Response.redirect(new URL('/check', request.url), 303);
}
