import Link from 'next/link';
import evalB from '@/data/eval/results-settle-link-b.json';
import proof from '@/data/proof/proof.json';
import readerEval from '@/data/eval/reader-test.json';
import baseline from '@/data/eval/baseline.json';
import labelEval from '@/data/eval/label.json';
import { signalById } from '@/lib/settle/signals';
import { TopBar } from '@/app/components/brand';

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
  { label: "Settle Link's model only", pick: (s: Signal) => s.model },
  { label: 'Model plus rules (what runs)', pick: (s: Signal) => s.combined },
];

export default function Page() {
  const positives = signals.reduce((n, [, s]) => n + s.positives, 0);
  const weakest = [...signals].sort((a, b) => (a[1].combined.recall ?? 0) - (b[1].combined.recall ?? 0)).slice(0, 2);
  return (
    <div className="min-h-full">
      <TopBar note={"Proof: numbers from files committed with the code. Nothing on this page is live."} />
      <main className="mx-auto w-full max-w-4xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Proof</h1>
        <p className="mt-2 max-w-2xl">
          Settle Link&apos;s warning check reads a redacted copy of the chat and explains what looks risky, and an AI reader points at the deal terms in it. It never approves a payment or a shipment: those come from PayPal&apos;s records and from both people. This page shows how often the check is right, how the rules that stop attacks are tested, and what we don&apos;t know.
        </p>

        <section className="mt-10">
          <h2 className="text-xl font-semibold">How often the warning check is right</h2>
          <p className="mt-2 max-w-2xl text-sm text-pp-muted">
            {evalB.chats} chats we wrote for Settle Link, with {positives} risky moments across ten signals; every chat is a negative for each signal it doesn&apos;t list. The model ({evalB.model}) never trained on them. Run {evalB.ranAt.slice(0, 10)}. Precision: of the warnings shown, how many were right. Recall: of the risky moments, how many were caught.
          </p>
          <div className="mt-4 overflow-x-auto surface rounded-2xl">
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
            Keyword rules alone miss most of what matters: they can&apos;t tell &ldquo;send it to my cousin&rdquo; or &ldquo;the money is held until you ship&rdquo; from ordinary talk. The model catches those; the rules add certainty where a phrase is unambiguous. A third option, one broad &ldquo;is this a scam?&rdquo; question to Jev (TypeSafe), was <strong>not run</strong>: we had no TypeSafe credits, and we won&apos;t show a number we didn&apos;t measure. The same broad question to a general LLM on Groq <em>was</em> run; it is below.
          </p>
        </section>

        <section className="mt-10 max-w-2xl">
          <h2 className="text-xl font-semibold">False alarms</h2>
          <p className="mt-2 text-sm text-pp-muted">A warning on a chat with nothing risky in it. Counted per chat, any signal.</p>
          <ul className="mt-3 divide-y divide-pp-gridline surface rounded-2xl text-sm tabular-nums">
            <li className="px-4 py-2">
              <strong>
                {evalB.falseAlarms.noRiskChats.withoutWarning} of {evalB.falseAlarms.noRiskChats.chats}
              </strong>{' '}
              chats with nothing risky show no warning.
            </li>
            <li className="px-4 py-2">
              <strong>
                {evalB.falseAlarms.honestRefusals.withoutWarning} of {evalB.falseAlarms.honestRefusals.chats}
              </strong>{' '}
              honest refusals show no warning: chats where someone says &ldquo;not Friends and Family&rdquo; or &ldquo;I don&apos;t take Zelle&rdquo; and nobody asks for it. Written after a reviewer&apos;s honest chat was flagged, and never used in training.
            </li>
          </ul>
          <p className="mt-3 text-sm">
            When the buyer suggests Friends and Family and the seller refuses, the suggestion is still shown: someone did ask, and the warning says who.
          </p>
        </section>

        <AgainstAnLlm />

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
              The warning check: {evalB.latencyMs.p50} ms per chat at the median, {evalB.latencyMs.p95} ms at the 95th percentile, on our own server, with no AI API. The AI reader: {readerEval.latencyMs.p50} ms median and {readerEval.latencyMs.p95} ms at the 95th percentile on Groq, about {readerEval.tokensPerChat?.input} tokens in and {readerEval.tokensPerChat?.output} out per chat, which is ${readerEval.costPerChatUsd?.toFixed(5)} at Groq&apos;s paid rates ($0 on the free tier we use).
            </p>
          </div>
        </section>


        <ReadingTheCard />

        <ReadingALabel />

        <section className="mt-10">
          <h2 className="text-xl font-semibold">Tests and attacks</h2>
          <p className="mt-2 text-sm">
            {proof.tests.pass} of {proof.tests.total} tests pass at commit <span className="font-mono">{proof.commit}</span> (PayPal and the model mocked). {proof.attacks.filter((a) => a.stopped).length} of {proof.attacks.length} attacks stopped when last recorded ({proof.generatedAt.slice(0, 10)});{' '}
            <Link href="/demo/attacks" className="text-pp-blue underline underline-offset-2">
              run them yourself
            </Link>
            .
          </p>
          <ul className="mt-3 divide-y divide-pp-gridline surface rounded-2xl text-sm">
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
            <li>These are our own synthetic chats, 3 to 7 risky examples per signal. That is too few for firm percentages; treat them as a sanity check, not a benchmark.</li>
            <li>
              Weakest: {weakest.map(([id, s]) => `${signalById(id)?.title ?? id} (recall ${pct(s.combined.recall)})`).join(' and ')}. A missed warning never makes a deal safe: payment and shipping are still checked against PayPal&apos;s records, and the address rule holds a shipment on a new postcode whatever the model says.
            </li>
            <li>Thresholds were chosen on our training messages, never on these test chats.</li>
            <li>PayPal decides every claim and dispute. Settle Link shows which checks pass; it never says a deal is protected.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

type Counts = { right: number; wrong: number; asked: number; missed: number };
const READ_TERMS = [
  ['price', 'Price'],
  ['shipBy', 'Ship-by date'],
  ['delivery', 'Delivery'],
  ['item', 'Item name'],
] as const;
const READ_MODES = [
  ['codeOnly', 'Code only'],
  ['readerOnly', 'AI reader only'],
  ['both', 'Both (what runs)'],
] as const;

/** PLAN M8: code and the AI reader read each term; the card fills only what they agree on. */
function ReadingTheCard() {
  const r = readerEval as unknown as {
    chats: number;
    readerRan: number;
    model: string;
    at: string;
    terms: Record<string, Record<string, Counts>>;
    claims: { chats: number; labelled: number; kept: number; precision: number | null; recall: number | null };
    quotesDropped: number;
    incomplete?: string;
  };
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold">Reading the card</h2>
      <p className="mt-2 max-w-2xl text-sm text-pp-muted">
        Code and an AI reader ({r.model} on Groq) each read the deal terms from the same redacted chat. The AI can only point: at a price or date placeholder, a message, a delivery option, or exact words that code checks are in the message. A term is filled only when both agree; otherwise both people answer a question. {r.chats} of our own synthetic chats, never used to write the prompt; the reader ran on {r.readerRan}. Run {r.at}.{r.incomplete ? ` Incomplete: ${r.incomplete}` : ''}
      </p>
      <div className="mt-4 overflow-x-auto surface rounded-2xl">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Deal terms filled right, filled wrong, or asked, by who read them</caption>
          <thead className="border-b border-pp-border text-pp-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-semibold">Term</th>
              {READ_MODES.map(([k, label]) => (
                <th key={k} scope="col" className="px-4 py-2 font-semibold">
                  {label}
                  <span className="block font-normal">right / wrong / asked</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-pp-gridline tabular-nums">
            {READ_TERMS.map(([k, label]) => (
              <tr key={k}>
                <th scope="row" className="px-4 py-2 font-normal">{label}</th>
                {READ_MODES.map(([m]) => {
                  const c = r.terms[m][k];
                  return (
                    <td key={m} className="px-4 py-2">
                      {c.right} / <span className={c.wrong ? 'font-semibold text-pp-danger' : ''}>{c.wrong}</span> / {c.asked}
                      {c.missed ? <span className="text-pp-muted"> ({c.missed} left blank)</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-2xl text-sm">
        A wrong term is the costly mistake; a question costs both people one tap. Filling only what both readers agree on trades some questions for fewer wrong terms. What the seller said about the item: {r.claims.kept} lines kept across {r.claims.chats} labelled chats, precision {pct(r.claims.precision)}, recall {pct(r.claims.recall)}; code dropped {r.quotesDropped} quotes that weren&apos;t exactly in their message. Small numbers on chats we wrote: a sanity check, not a benchmark.
      </p>
    </section>
  );
}

type Count = { of: number; count: number; failed?: number; ids: string[] };
type Side = { scamCaught: Count; cleanFlagged: Count; refusalsFlagged: Count; injectionHandled: Count; latencyMs: { p50: number | null; p95: number | null }; costPerChatUsd: number | null };

/** A general LLM asked one broad question per chat, beside our check (npm run baseline). */
function AgainstAnLlm() {
  const b = baseline as unknown as { model: string; provider: string; question: string; ranAt: string; chats: number; failed: string[]; baseline: Side & { tokensPerChat: { input: number; output: number } }; ours: Side & { model: string } };
  const rows: { label: string; key: 'scamCaught' | 'cleanFlagged' | 'refusalsFlagged' | 'injectionHandled'; higherIsBetter: boolean; listLabel: string }[] = [
    { label: 'Scam chats caught', key: 'scamCaught', higherIsBetter: true, listLabel: 'missed' },
    { label: 'Clean chats wrongly flagged', key: 'cleanFlagged', higherIsBetter: false, listLabel: 'flagged' },
    { label: 'Honest refusals wrongly flagged', key: 'refusalsFlagged', higherIsBetter: false, listLabel: 'flagged' },
    { label: 'Injection chats handled', key: 'injectionHandled', higherIsBetter: true, listLabel: 'not handled' },
  ];
  const better = (r: (typeof rows)[number], mine: number, theirs: number) => (r.higherIsBetter ? mine > theirs : mine < theirs);
  const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const cell = (r: (typeof rows)[number], side: Side, other: Side) => {
    const c = side[r.key];
    return (
      <td className="px-4 py-2 align-top">
        <span className={better(r, c.count, other[r.key].count) ? 'font-semibold text-pp-success' : ''}>
          {c.count} of {c.of}
        </span>
        {c.failed ? <span className="text-pp-muted"> ({c.failed} no answer)</span> : null}
        {c.ids.length > 0 && (
          <span className="block text-xs text-pp-muted">
            {r.listLabel}: {c.ids.join(', ')}
          </span>
        )}
      </td>
    );
  };
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold">Against a general LLM</h2>
      <p className="mt-2 max-w-2xl text-sm text-pp-muted">
        The same {b.chats} redacted chats, each sent once to {b.model} on {b.provider} with one question: &ldquo;{b.question}&rdquo; Run {b.ranAt.slice(0, 10)}; {b.failed.length === 0 ? 'every chat got an answer' : `${b.failed.length} got no usable answer (${b.failed.join(', ')})`}. For our check, &ldquo;flagged&rdquo; means any warning on the chat. The better number in each row is in green, whichever side it is.
      </p>
      <div className="mt-4 overflow-x-auto surface rounded-2xl">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Our warning check beside a general LLM asked one question</caption>
          <thead className="border-b border-pp-border text-pp-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-semibold"></th>
              <th scope="col" className="px-4 py-2 font-semibold">Settle Link&apos;s check ({b.ours.model} plus rules)</th>
              <th scope="col" className="px-4 py-2 font-semibold">General LLM ({b.model})</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-pp-gridline tabular-nums">
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="px-4 py-2 align-top font-normal">{r.label}</th>
                {cell(r, b.ours, b.baseline)}
                {cell(r, b.baseline, b.ours)}
              </tr>
            ))}
            <tr>
              <th scope="row" className="px-4 py-2 align-top font-normal">Latency per chat (median / 95th)</th>
              <td className="px-4 py-2">{ms(b.ours.latencyMs.p50)} / {ms(b.ours.latencyMs.p95)}, on our server</td>
              <td className="px-4 py-2">{ms(b.baseline.latencyMs.p50)} / {ms(b.baseline.latencyMs.p95)}, over the network</td>
            </tr>
            <tr>
              <th scope="row" className="px-4 py-2 align-top font-normal">Cost per chat</th>
              <td className="px-4 py-2">$0: no AI API</td>
              <td className="px-4 py-2">
                {b.baseline.costPerChatUsd === null ? '—' : `$${b.baseline.costPerChatUsd.toFixed(5)}`} at Groq&apos;s paid rates ({b.baseline.tokensPerChat.input} tokens in, {b.baseline.tokensPerChat.output} out); $0 on the free tier we used
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-2xl text-sm">
        A yes/no answer also can&apos;t say what to do: our warnings quote the message, name the PayPal term it breaks and tell each side what to do next. And whichever check is used, it only adds caution: payment and shipping are still decided by PayPal&apos;s records and both people.
      </p>
    </section>
  );
}

type LabelEval = {
  note: string;
  ranAt: string;
  model: string;
  labels: number;
  ofLabels?: number;
  notRun?: string[];
  right: number;
  wrong: number;
  refused: number;
  misses: { id: string; expected: string | null; got: string | null; outcome: string; reason: string | null }[];
  latencyMs: { p50: number | null; p95: number | null };
  tokensPerLabel: { input: number; output: number };
  costPerLabelUsd: number | null;
  earlierRuns?: { promptVersion: string; right: number; wrong: number; refused: number; labels: number; note: string }[];
};

/** Part B: the label photo reader, on rendered labels (npm run label:eval). */
function ReadingALabel() {
  const l = labelEval as unknown as LabelEval;
  return (
    <section className="mt-10 max-w-2xl">
      <h2 className="text-xl font-semibold">Reading a label photo</h2>
      <p className="mt-2 text-sm text-pp-muted">
        A seller can read the label postcode from a photo ({l.model} on Groq). The reading only fills the box: the seller checks it, and code compares it with PayPal&apos;s address as before. {l.labels} of {l.ofLabels ?? l.labels} labels we rendered ourselves were measured, run {l.ranAt.slice(0, 10)}{l.notRun?.length ? `; ${l.notRun.length} not run yet because Groq's free daily limit was used up (${l.notRun.join(', ')}), so they are not counted either way` : ''}. {l.note}
      </p>
      <ul className="mt-3 divide-y divide-pp-gridline surface rounded-2xl text-sm tabular-nums">
        <li className="px-4 py-2">
          <strong>{l.right} of {l.labels}</strong> measured labels read right.
        </li>
        <li className="px-4 py-2">
          <strong className={l.wrong ? 'text-pp-danger' : ''}>{l.wrong}</strong> read wrong. <strong>{l.refused}</strong> refused, so the seller types the postcode.
        </li>
        <li className="px-4 py-2">
          {l.latencyMs.p50} ms median, {l.latencyMs.p95} ms at the 95th percentile; about {l.tokensPerLabel.input} tokens in and {l.tokensPerLabel.output} out per photo, which is ${l.costPerLabelUsd?.toFixed(5)} at Groq&apos;s paid rates ($0 on the free tier we use).
        </li>
      </ul>
      {l.misses.length > 0 && (
        <p className="mt-3 text-sm">
          Not right: {l.misses.map((m) => `${m.id} (${m.outcome}${m.reason ? `: ${m.reason}` : ''})`).join('; ')}.
        </p>
      )}
      {l.earlierRuns?.map((r) => (
        <p key={r.promptVersion} className="mt-2 text-sm text-pp-muted">
          Earlier run ({r.promptVersion}): {r.right} right, {r.wrong} wrong, {r.refused} refused of {r.labels}. {r.note}
        </p>
      ))}
    </section>
  );
}
