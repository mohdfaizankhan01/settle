import type { Metadata } from 'next';
import { connection } from 'next/server';
import { dealForPreview } from '@/lib/settle/preview-deal';
import { previewFor } from '@/lib/settle/preview';
import { DealPage } from './deal-page';

// What a chat app shows when the link is pasted (PLAN M6): item, price, delivery and status only.
// The status changes as the deal moves, so this is read per request.
export async function generateMetadata({ params }: PageProps<'/d/[id]'>): Promise<Metadata> {
  await connection();
  const { id } = await params;
  const p = previewFor(await dealForPreview(id));
  const description = [p.terms, p.status, p.nudge].filter(Boolean).join(' · ');
  return {
    title: p.title,
    description,
    openGraph: { title: p.title, description, siteName: 'Settle Link', type: 'website' },
    // Deal links are private: keep them out of search engines.
    robots: { index: false, follow: false },
  };
}

// The link key is in the URL fragment (#k=…), which only the browser sees, so the page itself
// renders on the client and sends the key in a header.
export default async function Page({ params }: PageProps<'/d/[id]'>) {
  const { id } = await params;
  return <DealPage dealId={id} />;
}
