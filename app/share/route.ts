import { sharedChat, sharePage } from '@/lib/settle/share';

// Android share sheet → Settle Link (PLAN M6). The shared chat arrives in the POST body, so it never
// sits in a URL or a server log, and it isn't stored on the server: the page puts it in the tab's
// own session storage and opens "make a deal link", which reads it once. Redaction and the warning
// check run as usual when the deal is made.
export async function POST(request: Request) {
  let chat = '';
  try {
    chat = sharedChat(await request.formData());
  } catch {
    // Not a form post: open the empty form.
  }
  return new Response(sharePage(chat), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// Opened directly (not from a share): go to the normal form.
export function GET(request: Request) {
  return Response.redirect(new URL('/check', request.url), 303);
}
