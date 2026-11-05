import { ImageResponse } from 'next/og';
import { connection } from 'next/server';
import { previewFor } from '@/lib/settle/preview';
import { dealForPreview } from '@/lib/settle/preview-deal';

// The card a chat app shows for a deal link (PLAN M6). Only item, price, delivery and status: chat
// apps fetch it from their own servers, without the link key (lib/settle/preview.ts).
export const alt = 'Settle Link deal card';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const NAVY = '#001c64';
const BLUE = '#0070e0';
const MUTED = '#545d68';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const p = previewFor(await dealForPreview(id));
  const done = /^(Terms locked|Held by PayPal|Paid|Handed over)/.test(p.status);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#f5f7fa', padding: 56, fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 30, color: NAVY, fontWeight: 700 }}>
          <span>Settle Link</span>
          <span style={{ fontSize: 24, color: MUTED, fontWeight: 400 }}>{p.realness}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 48, background: 'white', borderRadius: 24, border: '2px solid #dbe1e8', padding: '44px 48px', flexGrow: 1 }}>
          <div style={{ fontSize: 60, fontWeight: 700, color: NAVY, lineHeight: 1.1 }}>{p.item ?? 'A deal agreed in a chat'}</div>
          {p.terms && <div style={{ fontSize: 40, color: '#1a1a1a', marginTop: 20 }}>{p.terms}</div>}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 28, fontSize: 36, fontWeight: 700, color: done ? '#007a3d' : BLUE }}>
            {done ? '✓ ' : ''}
            {p.status}
          </div>
        </div>
        <div style={{ marginTop: 28, fontSize: 30, color: NAVY, fontWeight: 700 }}>{p.nudge}</div>
      </div>
    ),
    { ...size },
  );
}
