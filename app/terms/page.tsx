import Link from 'next/link';
import { loadTerms } from '@/lib/settle/terms-doc';

// /terms: every PayPal clause Settle cites, with PayPal's own wording, read from
// docs/protection-terms.md at build time. Each check on a deal page links to a row here.

export const metadata = { title: 'PayPal terms Settle checks' };

const plain = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '');

export default function Page() {
  const { rows, sources } = loadTerms();
  const seller = rows.filter((r) => r.id.startsWith('SP-'));
  const buyer = rows.filter((r) => r.id.startsWith('PP-'));
  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">
        PayPal&apos;s own wording, copied from its pages. PayPal decides every claim; Settle only shows which checks pass.
      </div>
      <main className="mx-auto w-full max-w-4xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">PayPal terms Settle checks</h1>
        <p className="mt-2 max-w-2xl">
          Every warning and ship check on a deal page names one of these clauses. Quotes were retrieved on 18 October 2026 and re-checked word for word on 6 November 2026.
        </p>
        <ul className="mt-4 space-y-1 text-sm">
          {sources.map((s) => (
            <li key={s.key}>
              <a href={s.url} className="text-pp-blue underline underline-offset-2" rel="noreferrer" target="_blank">
                {s.title}
              </a>{' '}
              <span className="text-pp-muted">
                ({s.key}, updated {s.updated})
              </span>
            </li>
          ))}
        </ul>
        <Section title="Seller Protection" rows={seller} />
        <Section title="Purchase Protection (US) and Buyer Protection (UK)" rows={buyer} />
      </main>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: ReturnType<typeof loadTerms>['rows'] }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold">{title}</h2>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.id} id={r.id} className="scroll-mt-6 rounded-md border border-pp-border bg-pp-surface p-4 target:border-pp-blue target:ring-2 target:ring-pp-blue/30">
            <p className="font-semibold">
              {plain(r.requirement)} <span className="font-mono text-xs font-normal text-pp-muted">{r.id}</span>
            </p>
            <dl className="mt-2 space-y-2 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-pp-muted">US</dt>
                <dd>{plain(r.us)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-pp-muted">UK</dt>
                <dd>{plain(r.uk)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-pp-muted">How Settle uses it</dt>
                <dd>{plain(r.how)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
