// What the external pinger loads every 5 minutes during judging, so the free
// Render instance never sleeps. It never touches the database: Neon's free tier counts compute
// hours, and a ping every 5 minutes would keep it running all month.
export function GET() {
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
