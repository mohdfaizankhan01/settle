import { HandoverScan } from './handover-scan';

export const metadata = { title: 'Handover' };

// The buyer's camera opens this from the seller's QR code (/d/<id>/handover#t=…). The code is in the
// fragment, which only the browser sees, so this page renders on the client.
export default async function Page({ params }: PageProps<'/d/[id]/handover'>) {
  const { id } = await params;
  return <HandoverScan dealId={id} />;
}
