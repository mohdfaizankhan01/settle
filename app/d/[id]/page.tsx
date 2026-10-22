import { DealPage } from './deal-page';

export const metadata = { title: 'Deal card · Settle' };

// The link key is in the URL fragment (#k=…), which only the browser sees, so the page itself
// renders on the client and sends the key in a header.
export default async function Page({ params }: PageProps<'/d/[id]'>) {
  const { id } = await params;
  return <DealPage dealId={id} />;
}
