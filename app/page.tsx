import Link from 'next/link';
import { connection } from 'next/server';
import { devPagesEnabled } from '@/lib/settle/dev-pages';
import { TopBar } from '@/app/components/brand';
import { HeroCard } from '@/app/components/hero-card';

// Home: what Settle Link does, and the two ways in (make a link from a chat, or judge mode).
// The boilerplate PayPal data pages are linked only where dev pages are on (lib/settle/dev-pages.ts).

const STEPS = [
  { title: 'Paste the chat', text: 'Settle reads a redacted copy, finds the item, price and delivery, and explains anything risky, like being asked to pay as Friends and Family.' },
  { title: 'Both confirm one card', text: 'Buyer and seller each confirm the same card. It is locked by its fingerprint; any change clears both confirmations.' },
  { title: 'Pay through PayPal checkout', text: "The buyer pays the card's exact total to the seller's own PayPal account. Settle never holds the money." },
  { title: 'Ship when the checks pass, or meet up', text: 'Payment counts only when a verified PayPal webhook and a fresh read of the order agree. A new address after payment holds the parcel. For a meet-up, PayPal holds the money until the buyer checks the item and scans the seller\'s code.' },
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
    <div className="hero-glow min-h-full">
      <TopBar note="PayPal sandbox build for the PayPal AI Hackathon: no real money moves." />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-14 font-paypal text-pp-ink sm:pt-24">
        <div className="grid items-center gap-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="stagger max-w-3xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-pp-border bg-pp-surface/80 px-3 py-1 text-xs font-medium text-pp-muted shadow-[var(--pp-shadow-sm)]">
            <span className="dot-live h-1.5 w-1.5 rounded-full bg-pp-success" aria-hidden="true" />
            Paid through PayPal checkout, straight to the seller&apos;s own account
          </p>
          <h1 className="mt-6 text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-pp-navy sm:text-[64px]">
            One link to <span className="font-serif font-normal italic tracking-[-0.01em] text-pp-blue">settle</span> a deal made in a DM.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-pp-muted sm:text-xl">
            Strangers who agree a sale in a chat get stuck on who goes first. Settle Link turns the chat into one card both people confirm, paid through PayPal checkout instead of Friends and Family or a bank transfer, and keeps the record from the first message to a dispute.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/demo" className="btn-primary rounded-full px-7 py-3.5 font-semibold">
              Try it in judge mode
            </Link>
            <Link href="/check" className="lift rounded-full border border-pp-border bg-pp-surface px-7 py-3.5 font-semibold text-pp-navy shadow-[var(--pp-shadow-sm)]">
              Make a deal link from your chat
            </Link>
          </div>
          <p className="mt-4 text-sm text-pp-muted">Judge mode sets up eight demo deals, one at each stage plus one where the two readers disagree, with buyer and seller side by side. Nothing reaches PayPal.</p>
        </section>
        <HeroCard />
        </div>

        <section className="mt-24" aria-labelledby="how">
          <div className="flex items-end justify-between gap-6">
            <h2 id="how" className="text-2xl font-semibold tracking-[-0.02em] text-pp-navy">
              How a deal goes
            </h2>
            <p className="hidden max-w-sm text-right text-sm text-pp-muted md:block">One record follows the deal, from the chat to the payment to a dispute.</p>
          </div>
          <ol className="stagger mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="surface lift rounded-2xl p-5">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-pp-highlight text-xs font-semibold tabular-nums text-pp-blue">{i + 1}</span>
                <h3 className="mt-4 font-semibold tracking-[-0.01em] text-pp-navy">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-pp-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16 grid gap-4 sm:grid-cols-2">
          <Link href="/proof" className="surface lift group rounded-2xl p-5">
            <span className="text-sm font-semibold text-pp-navy">Proof</span>
            <span className="mt-1 block text-sm text-pp-muted">How often the checks are right, with the counts behind every number.</span>
            <span className="mt-3 inline-block text-sm font-semibold text-pp-blue transition-transform duration-200 group-hover:translate-x-0.5">See the numbers →</span>
          </Link>
          <Link href="/demo/attacks" className="surface lift group rounded-2xl p-5">
            <span className="text-sm font-semibold text-pp-navy">Try to fool it</span>
            <span className="mt-1 block text-sm text-pp-muted">Run ten attacks through the real server code: fake payment emails, forged webhooks, cards edited after confirming.</span>
            <span className="mt-3 inline-block text-sm font-semibold text-pp-blue transition-transform duration-200 group-hover:translate-x-0.5">Run the attacks →</span>
          </Link>
        </section>

        <p className="mt-12 max-w-3xl text-xs leading-relaxed text-pp-muted">
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
