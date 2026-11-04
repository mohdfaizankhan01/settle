import Link from 'next/link';
import { connection } from 'next/server';
import { devPagesEnabled } from '@/lib/settle/dev-pages';

// Home: what Settle Link does, and the two ways in (make a link from a chat, or judge mode).
// The boilerplate PayPal data pages are linked only where dev pages are on (lib/settle/dev-pages.ts).

const STEPS = [
  { title: 'Paste the chat', text: 'Settle reads a redacted copy, finds the item, price and delivery, and explains anything risky, like being asked to pay as Friends and Family.' },
  { title: 'Both confirm one card', text: 'Buyer and seller each confirm the same card. It is locked by its fingerprint; any change clears both confirmations.' },
  { title: 'Pay through PayPal checkout', text: "The buyer pays the card's exact total to the seller's own PayPal account. Settle never holds the money." },
  { title: 'Ship when the checks pass', text: 'Payment counts only when a verified PayPal webhook and a fresh read of the order agree. A new address after payment holds the parcel.' },
  { title: 'Answer a dispute from the record', text: 'The case file, honest advice and an evidence pack come from what happened. The seller approves the exact response; PayPal decides.' },
];

const devPages = [
  { href: '/dashboard', label: 'Dashboard (AG Studio boilerplate)' },
  { href: '/products', label: 'Catalog products' },
  { href: '/plans', label: 'Billing plans' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/balances', label: 'Balances' },
];

export default async function Home() {
  // Checked per request, so SETTLE_DEV_PAGES on Render takes effect without a rebuild.
  await connection();
  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">PayPal sandbox build for the PayPal AI Hackathon: no real money moves.</div>
      <main className="mx-auto w-full max-w-5xl px-4 py-14 font-paypal text-pp-ink sm:py-20">
        <section className="max-w-3xl">
          <h1 className="text-[40px] font-semibold leading-[1.1] text-pp-navy sm:text-[52px]">One link to settle a deal made in a DM.</h1>
          <p className="mt-5 text-lg leading-relaxed text-pp-muted">
            Strangers who agree a sale in a chat get stuck on who goes first. Settle Link turns the chat into one card both people confirm, paid through PayPal checkout instead of Friends and Family or a bank transfer, and keeps the record from the first message to a dispute.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/demo" className="rounded-full bg-pp-blue px-6 py-3 font-semibold text-white">
              Try it in judge mode
            </Link>
            <Link href="/check" className="rounded-full border border-pp-border bg-pp-surface px-6 py-3 font-semibold">
              Make a deal link from your chat
            </Link>
          </div>
          <p className="mt-3 text-sm text-pp-muted">Judge mode sets up six demo deals, one at each stage, with buyer and seller side by side. Nothing reaches PayPal.</p>
        </section>

        <section className="mt-16" aria-labelledby="how">
          <h2 id="how" className="text-xl font-semibold">
            How a deal goes
          </h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="border-t-2 border-pp-navy pt-3">
                <span className="text-sm font-semibold text-pp-muted tabular-nums">{i + 1}</span>
                <h3 className="mt-1 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Link href="/proof" className="text-pp-blue underline underline-offset-2">
            Proof: how often the checks are right
          </Link>
          <Link href="/demo/attacks" className="text-pp-blue underline underline-offset-2">
            Try to fool it
          </Link>
        </section>

        <p className="mt-10 max-w-3xl text-xs text-pp-muted">
          Settle Link explains warnings; it never approves a payment or a shipment. It never says a deal is protected: it shows which of PayPal&apos;s published requirements the record meets, and PayPal decides eligibility and disputes.
        </p>

        {devPagesEnabled() && (
          <section className="mt-16 border-t border-pp-border pt-6">
            <h2 className="text-sm font-semibold text-pp-muted">Local development pages</h2>
            <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {devPages.map((p) => (
                <li key={p.href}>
                  <Link href={p.href} className="text-pp-blue underline underline-offset-2">
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
