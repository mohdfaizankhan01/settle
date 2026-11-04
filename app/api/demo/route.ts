import { cookies } from 'next/headers';
import { DealError } from '@/lib/settle/deals';
import { DEMO_COOKIE, DEMO_TTL_MS, demoView, startDemo } from '@/lib/settle/demo';
import { api, getStore, rateLimited } from '@/lib/settle/runtime';

// Judge mode. The session lives in an httpOnly cookie; a session only ever reads its own deals.
// Starting a session seeds six demo deals (each runs the warning check), so it is rate-limited.

const COOKIE = DEMO_COOKIE;

export async function GET() {
  return api(async () => {
    const id = (await cookies()).get(COOKIE)?.value;
    return { session: (await demoView(getStore(), id)) ?? null };
  });
}

/** Starts a fresh session (also the reset button): new cookie, new deals. */
export async function POST(request: Request) {
  return api(async () => {
    if (rateLimited(request, 'demo-start', 10, 200)) throw new DealError('too many judge sessions from here; try again in an hour', 400);
    const session = await startDemo(getStore());
    (await cookies()).set(COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Math.floor(DEMO_TTL_MS / 1000),
    });
    return { session: await demoView(getStore(), session.id) };
  });
}
