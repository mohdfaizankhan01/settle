import { ImageResponse } from 'next/og';

// App icons for the manifest (installable on Android so Settle Link appears in the share sheet).
// Drawn here, so there are no image files to keep in sync.
const SIZES = new Set([192, 512]);

export async function GET(_request: Request, ctx: RouteContext<'/icons/[size]'>) {
  const size = Number((await ctx.params).size);
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#001c64', color: 'white', fontSize: size * 0.56, fontWeight: 700, fontFamily: 'sans-serif' }}>
        S
      </div>
    ),
    { width: size, height: size, headers: { 'Cache-Control': 'public, max-age=86400' } },
  );
}
