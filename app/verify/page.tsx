import Link from 'next/link';
import { TopBar } from '@/app/components/brand';
import { Verifier } from './verifier';

// /verify (Part B): anyone checks a signed deal record, and optionally its evidence PDF, without
// trusting Settle Link. The check runs in the browser (lib/settle/verify-core.ts); nothing is uploaded.

export const metadata = { title: 'Verify a record' };

export default function Page() {
  return (
    <div className="min-h-full">
      <TopBar note="Verify: the check runs in your browser and nothing you drop here is uploaded. Records from judge mode are demo data signed with a public key." />
      <main className="mx-auto w-full max-w-3xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Verify a record</h1>
        <p className="mt-2 max-w-2xl">
          The seller of a deal can download a <strong>signed record</strong>: every receipt Settle Link wrote for the deal, each holding the hash of the one before, signed with Settle Link&apos;s key. Drop the file below to check that it is unchanged since it was signed. If the record covers a dispute, drop the evidence PDF too and the page checks that it is the one the record names.
        </p>

        <Verifier />

        <section className="mt-10 max-w-2xl space-y-3 text-sm">
          <h2 className="text-xl font-semibold">What a passing check shows, and what it doesn&apos;t</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>It shows the file was signed with the key whose ID is shown, and no receipt has been changed, removed from the middle or reordered since.</li>
            <li>It does <strong>not</strong> show the events happened. PayPal decides what happened with a payment or a dispute; receipts are Settle Link&apos;s own notes of what it did and saw.</li>
            <li>Whoever holds the signing key could sign false data, and steps cut from the very end of a chain can&apos;t be seen. With no outside anchor, this is &ldquo;unchanged since Settle Link signed it&rdquo;, not &ldquo;Settle Link couldn&apos;t have lied&rdquo;.</li>
            <li>The key list on this page comes from this server. To not trust it, compare the key ID with <code className="font-mono">docs/signing-public-key.json</code> in the <a className="text-pp-blue underline underline-offset-2" href="https://github.com/mohdfaizankhan01/settle/blob/main/docs/signing-public-key.json">public repository</a>, or paste your own key list below. The same check runs offline with <code className="font-mono">npm run verify:record</code>.</li>
            <li>Judge-mode records are replayed demo data signed with a public key that anyone can use, so they only show the file format.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
