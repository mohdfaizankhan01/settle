import Link from 'next/link';
import evalB from '@/data/eval/results-settle-link-b.json';
import proof from '@/data/proof/proof.json';
import { signalById } from '@/lib/settle/signals';

// /proof (PLAN M5 SHOULD): what Settle's warning check gets right and wrong, from committed JSON
// only (npm run eval, npm run proof). Our own synthetic chats, not a benchmark; numbers are shown
// with the counts behind them.

export const metadata = { title: 'Proof' };

type PRF = { tp: number; fp: number; fn: number; precision: number | null; recall: number | null };
type Signal = { threshold: number; positives: number; model: PRF; rulesOnly: PRF; combined: PRF };

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const signals = Object.entries(evalB.signals as Record<string, Signal>);

function micro(pick: (s: Signal) => PRF) {
  const t = signals.reduce((a, [, s]) => ({ tp: a.tp + pick(s).tp, fp: a.fp + pick(s).fp, fn: a.fn + pick(s).fn }), { tp: 0, fp: 0, fn: 0 });
  return { precision: t.tp + t.fp ? t.tp / (t.tp + t.fp) : null, recall: t.tp + t.fn ? t.tp / (t.tp + t.fn) : null, ...t };
}

const COLUMNS = [
  { label: 'Keyword rules only', pick: (s: Signal) => s.rulesOnly },
  { label: "Settle's model only", pick: (s: Signal) => s.model },
  { label: 'Model plus rules (what runs)', pick: (s: Signal) => s.combined },
];

export default function Page() {
  const positives = signals.reduce((n, [, s]) => n + s.positives, 0);
  const weakest = [...signals].sort((a, b) => (a[1].combined.recall ?? 0) - (b[1].combined.recall ?? 0)).slice(0, 2);
  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">
        Proof: numbers from files committed with the code. Nothing on this page is live.
      </div>
      <main className="mx-auto w-full max-w-4xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Proof</h1>
        <p className="mt-2 max-w-2xl">
          Settle&apos;s warning check reads a redacted copy of the chat and explains what looks risky. It never approves a payment or a shipment: those come from PayPal&apos;s records and from both people. This page shows how often the check is right, how the rules that stop attacks are tested, and what we don&apos;t know.
        </p>

        <section className="mt-10">
          <h2 className="text-xl font-semibold">How often the warning check is right</h2>
          <p className="mt-2 max-w-2xl text-sm text-pp-muted">
            {evalB.chats} chats we wrote for Settle, with {positives} risky moments across ten signals; every chat is a negative for each signal it doesn&apos;t list. The model ({evalB.model}) never trained on them. Run {evalB.ranAt.slice(0, 10)}. Precision: of the warnings shown, how many were right. Recall: of the risky moments, how many were caught.
          </p>
          <div className="mt-4 overflow-x-auto rounded-md border border-pp-border bg-pp-surface">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Precision and recall per warning signal</caption>
              <thead className="border-b border-pp-border text-pp-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">Signal (risky chats)</th>
                  {COLUMNS.map((c) => (
                    <th key={c.label} scope="col" className="px-4 py-2 font-semibold">
                      {c.label}
                      <span className="block font-normal">precision / recall</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-pp-gridline tabular-nums">
                {signals.map(([id, s]) => (
                  <tr key={id}>
                    <th scope="row" className="px-4 py-2 font-normal">
                      {signalById(id)?.title ?? id} <span className="text-pp-muted">({s.positives})</span>
                    </th>
                    {COLUMNS.map((c) => (
                      <td key={c.label} className="px-4 py-2">
                        {pct(c.pick(s).precision)} / {pct(c.pick(s).recall)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-pp-border font-semibold tabular-nums">
                <tr>
                  <th scope="row" className="px-4 py-2">
                    All signals
                  </th>
                  {COLUMNS.map((c) => {
                    const m = micro(c.pick);
                    return (
                      <td key={c.label} className="px-4 py-2">
                        {pct(m.precision)} / {pct(m.recall)}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 max-w-2xl text-sm">
            Keyword rules alone miss most of what matters: they can&apos;t tell &ldquo;send it to my cousin&rdquo; or &ldquo;the money is held until you ship&rdquo; from ordinary talk. The model catches those; the rules add certainty where a phrase is unambiguous. A third option, one broad &ldquo;is this a scam?&rdquo; question to Jev (TypeSafe), was <strong>not run</strong>: we had no TypeSafe credits (DECISIONS #15), and we won&apos;t show a number we didn&apos;t measure.
          </p>
        </section>

        <section className="mt-10 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xl font-semibold">Deal terms read from the chat</h2>
            <p className="mt-2 text-sm">
              Price right in {evalB.terms.price.correct} of {evalB.terms.price.labelled} chats; delivery in {evalB.terms.delivery.correct} of {evalB.terms.delivery.labelled}. Prices and dates are found in code, not by the model. When a term is uncertain both people answer a question instead, and nobody can pay until both confirm the card.
            </p>
          </div>
          <div>
            <h2 className="text-xl font-semibold">Speed and cost</h2>
            <p className="mt-2 text-sm">
              {evalB.latencyMs.p50} ms per chat at the median, {evalB.latencyMs.p95} ms at the 95th percentile, on our own server. No AI API is called, so each check costs nothing beyond hosting, and no chat leaves Settle.
            </p>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-semibold">Tests and attacks</h2>
          <p className="mt-2 text-sm">
            {proof.tests.pass} of {proof.tests.total} tests pass at commit <span className="font-mono">{proof.commit}</span> (PayPal and the model mocked). {proof.attacks.filter((a) => a.stopped).length} of {proof.attacks.length} attacks stopped when last recorded ({proof.generatedAt.slice(0, 10)});{' '}
            <Link href="/demo/attacks" className="text-pp-blue underline underline-offset-2">
              run them yourself
            </Link>
            .
          </p>
          <ul className="mt-3 divide-y divide-pp-gridline rounded-md border border-pp-border bg-pp-surface text-sm">
            {proof.attacks.map((a) => (
              <li key={a.id} className="px-4 py-2">
                <span className={a.stopped ? 'text-pp-success' : 'text-pp-danger'}>{a.stopped ? '✓ Stopped' : '✕ Not stopped'}</span> {a.title}
                <span className="block text-xs text-pp-muted">Proved by {a.test}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10 max-w-2xl">
          <h2 className="text-xl font-semibold">What this doesn&apos;t show</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            <li>These are our own synthetic chats, 3 to 5 risky examples per signal. That is too few for firm percentages; treat them as a sanity check, not a benchmark.</li>
            <li>
              Weakest: {weakest.map(([id, s]) => `${signalById(id)?.title ?? id} (recall ${pct(s.combined.recall)})`).join(' and ')}. A missed warning never makes a deal safe: payment and shipping are still checked against PayPal&apos;s records, and the address rule holds a shipment on a new postcode whatever the model says.
            </li>
            <li>Thresholds were chosen on our training messages, never on these test chats.</li>
            <li>PayPal decides every claim and dispute. Settle shows which checks pass; it never says a deal is protected.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
