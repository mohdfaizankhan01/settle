// The home page's example deal card: what a confirmed card looks like, built from a demo chat.
// Static and labelled as an example (CLAUDE.md: every screen says what is real).

const Check = () => (
  <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TERMS = [
  { label: 'Item', value: 'Trek Domane AL 2, 54cm', quote: 'yes, Trek Domane AL 2, 54cm, barely used' },
  { label: 'Price', value: '$320.00', quote: 'ok $320, I can post it tracked by Friday', big: true },
  { label: 'Delivery', value: 'Post, tracked', quote: 'I can post it tracked by Friday' },
];

export function HeroCard() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:mx-0" aria-label="Example deal card">
      {/* Chat bubbles behind the card: where the card came from. */}
      <div className="rise absolute -left-14 -top-14 z-10 hidden w-60 space-y-2 [animation-delay:120ms] sm:block" aria-hidden="true">
        <p className="w-fit rounded-2xl rounded-bl-md bg-pp-surface px-3 py-2 text-xs text-pp-muted shadow-[var(--pp-shadow-md)]">would you do $320?</p>
        <p className="ml-auto w-fit rounded-2xl rounded-br-md bg-pp-blue px-3 py-2 text-xs text-white shadow-[var(--pp-shadow-md)]">ok $320, I can post it tracked</p>
      </div>

      <div className="rise surface-raised relative overflow-hidden rounded-3xl [animation-delay:200ms]">
        <div className="h-1 bg-gradient-to-r from-pp-navy via-pp-blue to-pp-sky" aria-hidden="true" />
        <div className="flex items-center justify-between px-6 pt-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-pp-muted">Deal card</p>
          <p className="rounded-full bg-pp-canvas px-2 py-0.5 text-[11px] font-medium text-pp-muted">Example</p>
        </div>
        <dl className="stagger divide-y divide-pp-border/60">
          {TERMS.map((t, i) => (
            <div key={t.label} className="px-6 py-3.5" style={{ animationDelay: `${320 + i * 90}ms` }}>
              <dt className="text-xs text-pp-muted">{t.label}</dt>
              <dd className={t.big ? 'mt-0.5 text-2xl font-semibold tracking-[-0.02em] tabular-nums text-pp-navy' : 'mt-0.5 font-semibold text-pp-ink'}>{t.value}</dd>
              <dd className="mt-1 truncate text-xs text-pp-muted">“{t.quote}”</dd>
              <dd className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-pp-highlight px-2 py-0.5 text-[11px] font-medium text-pp-navy">
                <span className="text-pp-blue">
                  <Check />
                </span>
                Code and the AI reader agree
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center justify-between gap-3 border-t border-dashed border-pp-border bg-pp-canvas/80 px-6 py-3.5">
          <span className="font-mono text-[11px] text-pp-muted">a41f09c2e7…</span>
          <span className="flex gap-1.5 text-xs">
            <span className="stamp-in inline-flex items-center gap-1 rounded-full border border-pp-success/60 bg-[#ecfdf5] px-2.5 py-0.5 font-semibold text-pp-success [animation-delay:900ms]">
              <Check /> Seller
            </span>
            <span className="stamp-in inline-flex items-center gap-1 rounded-full border border-pp-success/60 bg-[#ecfdf5] px-2.5 py-0.5 font-semibold text-pp-success [animation-delay:1100ms]">
              <Check /> Buyer
            </span>
          </span>
        </div>
      </div>

      {/* The payment that follows the card. */}
      <div className="rise absolute -bottom-16 -left-10 z-10 hidden items-center gap-2.5 rounded-2xl border border-pp-border/70 bg-pp-surface/95 px-4 py-3 shadow-[var(--pp-shadow-lg)] backdrop-blur [animation-delay:1300ms] sm:flex" aria-hidden="true">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#ecfdf5] text-pp-success">
          <Check />
        </span>
        <span className="text-xs leading-tight">
          <span className="block font-semibold text-pp-navy">Paid through PayPal checkout</span>
          <span className="text-pp-muted">Verified webhook + fresh order read</span>
        </span>
      </div>
    </div>
  );
}
