'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Shell } from '@/app/components/shell';
import type { DealView, SourceView } from '@/lib/settle/view';
import { PayButton } from './pay-button';
import { HandoverPanel, rememberBuyerKey } from './handover-panel';
import { keyHeaders, rememberDevice } from './link-auth';

const keyFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('k') ?? '';

/** The caller's link key, for the few requests made outside `act` (the evidence pack download). */
const KeyContext = createContext<() => string>(() => '');

/**
 * `linkKey` comes from judge mode, which shows both sides at once; otherwise the key is read from
 * the URL fragment. `embedded` drops the page frame for a side-by-side pane.
 */
export function DealPage({ dealId, linkKey, embedded = false }: { dealId: string; linkKey?: string; embedded?: boolean }) {
  // Read once on the client; the key never goes into React state or the rendered page.
  const keyRef = useRef<string | null>(null);
  const Frame = embedded ? EmbeddedFrame : Shell;
  const [view, setView] = useState<DealView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (k: string) => {
      const res = await fetch(`/api/deals/${dealId}`, { headers: keyHeaders(k), cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'This deal could not be loaded.');
      // First open on this device: keep the secret that makes this link work here (and only here).
      if (typeof body.claim === 'string') rememberDevice(k, body.claim);
      setView(body);
      // Meet-up deals: the buyer scans the seller's code with this phone's camera, which opens the
      // handover page without the link key, so this phone remembers it (handover-panel.tsx).
      if (body.role === 'buyer') rememberBuyerKey(dealId, k);
    },
    [dealId],
  );

  useEffect(() => {
    keyRef.current = linkKey ?? keyFromHash();
    load(keyRef.current).catch((e: Error) => setError(e.message));
  }, [load, linkKey]);

  // The other side acts on their own page: refresh every 10 s while this tab is visible.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busyRef.current && keyRef.current) load(keyRef.current).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/deals/${dealId}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...keyHeaders(keyRef.current ?? '') },
          body: JSON.stringify(body ?? {}),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.debugId ? `${out.error} (PayPal debug ID ${out.debugId})` : out.error);
        await load(keyRef.current ?? '');
        return out;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That did not work.');
        await load(keyRef.current ?? '').catch(() => undefined);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [dealId, load],
  );

  if (!view) {
    return (
      <Frame>
        <p className={error ? 'text-pp-danger' : 'text-pp-muted'}>{error ?? 'Loading the deal…'}</p>
      </Frame>
    );
  }

  const me = view.role;
  const other = me === 'seller' ? 'buyer' : 'seller';

  return (
    <KeyContext.Provider value={() => keyRef.current ?? ''}>
    <Frame wide>
      <Realness view={view} />
      <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold text-pp-navy">Deal card</h1>
          <p className="text-pp-muted">
            You are the <strong className="text-pp-ink">{me}</strong>. {view.locked ? 'Both of you confirmed this card.' : `Both of you confirm it before the buyer pays.`}
          </p>
        </div>
      </header>

      {error && (
        <p role="alert" className="mt-6 rounded-md border border-pp-danger/40 bg-white p-3 text-pp-danger">
          {error}
        </p>
      )}

      <div className={`mt-8 grid gap-8 ${embedded ? '' : 'lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]'}`}>
        <div className={`order-2 space-y-8 ${embedded ? '' : 'lg:order-1'}`}>
          <Card view={view} />

          {view.questions.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">Settle these first</h2>
              {view.questions.map((q) => (
                <div key={q.id} className="rounded-md border border-pp-border bg-pp-surface p-4">
                  <p className="font-semibold">{q.prompt}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {q.options.map((o) => (
                      <button
                        key={o.id}
                        disabled={busy}
                        onClick={() => act('/answer', { questionId: q.id, optionId: o.id })}
                        className={`rounded-full border px-4 py-1.5 text-sm ${q.mine === o.id ? 'border-pp-blue bg-pp-highlight font-semibold' : 'border-pp-border hover:border-pp-blue'}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-sm text-pp-muted">
                    {q.disagree
                      ? `You and the ${other} picked different answers. Agree in the chat, then pick again.`
                      : q.otherAnswered
                        ? `The ${other} has answered.`
                        : `Waiting for the ${other} to answer too.`}
                  </p>
                </div>
              ))}
            </section>
          )}

          {view.canEnter.length > 0 && <EnterTerms view={view} busy={busy} act={act} />}

          {me === 'seller' && !view.payee.connected && (
            <section className="rounded-md border border-pp-border bg-pp-surface p-4">
              <h2 className="font-semibold">Get paid to your own PayPal account</h2>
              <p className="mt-1 text-sm text-pp-muted">
                Connect your PayPal business account so the buyer pays you directly. PayPal opens in a new tab; come back here when you&apos;re done.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  onClick={async () => {
                    const tab = window.open('', '_blank');
                    const out = await act('/connect');
                    if (out?.actionUrl && tab) tab.location.href = out.actionUrl;
                    else tab?.close();
                  }}
                  className="rounded-full bg-pp-blue px-5 py-2 font-semibold text-white disabled:opacity-40"
                >
                  Connect PayPal
                </button>
                <button disabled={busy} onClick={() => act('/connect/check')} className="rounded-full border border-pp-border px-5 py-2 font-semibold">
                  I&apos;ve finished connecting
                </button>
              </div>
            </section>
          )}

          <Confirm view={view} busy={busy} act={act} />
          <Decline view={view} busy={busy} act={act} />

          {me === 'buyer' && view.realness.mode === 'judge' && view.locked && !view.order && (
            <p className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
              Here the buyer would pay with PayPal checkout, for exactly the total on the card. Judge mode never takes a payment; the &ldquo;Paid and ready to ship&rdquo; deal shows what happens next.
            </p>
          )}
          {me === 'buyer' && view.checkout && !view.payBlocker && <PayButton dealId={dealId} getKey={() => keyRef.current ?? ''} checkout={view.checkout} onDone={() => load(keyRef.current ?? '')} onError={setError} />}
          {view.order && !view.afterPayment && (
            <section className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
              <p>
                PayPal order <span className="font-mono">{view.order.id}</span>: created, waiting for the buyer to approve it in PayPal.
              </p>
            </section>
          )}
          {view.afterPayment && <AfterPayment view={view} busy={busy} act={act} />}
          {/* Before payment is when a fake "you've been paid" email usually arrives. */}
          {me === 'seller' && !view.afterPayment && <PaidCheckBox busy={busy} act={act} />}
          <History view={view} />
        </div>

        <aside className={`order-1 space-y-8 ${embedded ? '' : 'lg:order-2'}`}>
          <Warnings view={view} />
          {view.check.status === 'failed' && (
            <button disabled={busy} onClick={() => act('/recheck')} className="rounded-full border border-pp-border bg-pp-surface px-5 py-2 font-semibold disabled:opacity-40">
              {busy ? 'Checking…' : 'Run the check again'}
            </button>
          )}
          <Chat view={view} />
        </aside>
      </div>
    </Frame>
    </KeyContext.Provider>
  );
}

function EmbeddedFrame({ children }: { children: React.ReactNode; wide?: boolean }) {
  return <div className="font-paypal text-pp-ink">{children}</div>;
}

/** What's real on this screen: live sandbox or replayed PayPal, and whether the check ran. */
function Realness({ view }: { view: DealView }) {
  const judge = view.realness.mode === 'judge';
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${judge ? 'border-pp-warning/50 bg-[#fff8eb]' : 'border-pp-border bg-pp-surface'}`}>
      <p>
        <strong>{judge ? 'Judge mode (demo deal).' : 'Live deal.'}</strong> {view.realness.paypal}
      </p>
      <p className="mt-0.5 text-pp-muted">{view.realness.check}</p>
    </div>
  );
}

function sourceText(s: SourceView | null) {
  if (!s) return null;
  if (s.kind === 'message') return { label: `From the ${s.from}, message ${s.messageId.slice(1)}`, quote: s.quote };
  if (s.kind === 'answer') return { label: `You both answered: ${s.prompt}`, quote: null };
  return { label: `Typed in by the ${s.by}`, quote: null };
}

function Card({ view }: { view: DealView }) {
  return (
    <section aria-label="Deal card" className="relative rounded-lg border border-pp-border bg-pp-surface shadow-[0_1px_0_var(--pp-border),0_12px_24px_-16px_rgba(0,28,100,0.25)]">
      <dl className="divide-y divide-pp-border/60">
        {view.terms.map((t) => {
          const src = sourceText(t.source);
          return (
            <div key={t.key} className="grid gap-1 px-6 py-4 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <dt className="text-sm text-pp-muted">{t.label}</dt>
              <dd>
                {t.display ? (
                  <p className={t.key === 'price' ? 'text-2xl font-semibold tabular-nums text-pp-navy' : 'font-semibold'}>{t.display}</p>
                ) : (
                  <p className="text-pp-muted">{t.key === 'shipBy' ? 'No date agreed' : 'Not settled yet'}</p>
                )}
                {src && (
                  <figure className="mt-1.5 text-sm">
                    {src.quote && <blockquote className="border-l-2 border-pp-sky pl-3 text-pp-ink/80">“{src.quote}”</blockquote>}
                    <figcaption className="mt-1 text-pp-muted">{src.label}</figcaption>
                  </figure>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {view.money && (
        <div className="grid gap-1 border-t border-pp-border/60 px-6 py-4 text-sm sm:grid-cols-3">
          <p>
            <span className="block text-pp-muted">Buyer pays</span>
            <span className="text-lg font-semibold tabular-nums text-pp-navy">{view.money.total}</span>
          </p>
          <p>
            <span className="block text-pp-muted">PayPal&apos;s fee, about</span>
            <span className="font-semibold tabular-nums">{view.money.fee}</span>
          </p>
          <p>
            <span className="block text-pp-muted">Seller gets, about</span>
            <span className="font-semibold tabular-nums">{view.money.sellerGets}</span>
          </p>
          <p className="text-xs text-pp-muted sm:col-span-3">
            Estimated from PayPal&apos;s published rate ({(view.money.rate.bp / 100).toFixed(2)}% plus a fixed fee, {view.money.rate.cite} in docs/fees.md). PayPal&apos;s own figure on the payment is the real one.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-dashed border-pp-border bg-pp-canvas px-6 py-3 text-sm">
        <span className="min-w-0 text-pp-muted">
          Fingerprint <span className="break-all font-mono text-xs text-pp-ink" title={view.cardHash}>{view.cardHash.slice(0, 16)}…</span>
        </span>
        <span className="flex gap-2">
          <Stamp who="Seller" at={view.confirmed.seller} />
          <Stamp who="Buyer" at={view.confirmed.buyer} />
        </span>
      </div>
    </section>
  );
}

function Stamp({ who, at }: { who: string; at: string | null }) {
  return at ? (
    <span className="rounded-full border border-pp-success px-3 py-0.5 font-semibold text-pp-success" title={new Date(at).toLocaleString()}>
      {who} confirmed
    </span>
  ) : (
    <span className="rounded-full border border-dashed border-pp-border px-3 py-0.5 text-pp-muted">{who} not yet</span>
  );
}

function Confirm({ view, busy, act }: { view: DealView; busy: boolean; act: (p: string, b?: unknown) => Promise<unknown> }) {
  const mine = view.confirmed[view.role];
  if (mine) return null;
  return (
    <section className="space-y-3">
      {view.blockers.length > 0 ? (
        <div className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
          <p className="font-semibold">Before you can confirm</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-pp-muted">
            {view.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p className="max-w-prose text-sm text-pp-muted">
            Confirming locks this exact card. If anything on it changes later, both confirmations are cleared and the buyer can&apos;t pay until you both confirm again.
          </p>
          <button
            disabled={busy}
            onClick={() => act('/confirm', { cardHash: view.cardHash })}
            className="rounded-full bg-pp-navy px-6 py-3 font-semibold text-white disabled:opacity-40"
          >
            Confirm this card
          </button>
        </>
      )}
    </section>
  );
}

function EnterTerms({ view, busy, act }: { view: DealView; busy: boolean; act: (p: string, b?: unknown) => Promise<unknown> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <section className="rounded-md border border-pp-border bg-pp-surface p-4">
      <h2 className="font-semibold">Fill in what the chat didn&apos;t settle</h2>
      <p className="mt-1 text-sm text-pp-muted">The buyer sees that you typed it and still has to confirm the card.</p>
      {view.canEnter.map((term) => (
        <form
          key={term}
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act('/term', { term, value: values[term] ?? '' });
          }}
        >
          <label className="grow">
            <span className="text-sm">{term === 'item' ? 'Item' : `Price (${view.currency})`}</span>
            <input
              value={values[term] ?? ''}
              onChange={(e) => setValues({ ...values, [term]: e.target.value })}
              inputMode={term === 'price' ? 'decimal' : undefined}
              className="mt-1 block w-full rounded-md border border-pp-border px-3 py-2"
            />
          </label>
          <button disabled={busy} className="rounded-full border border-pp-border px-4 py-2 font-semibold">
            Save {term}
          </button>
        </form>
      ))}
    </section>
  );
}

function Warnings({ view }: { view: DealView }) {
  return (
    <section aria-label="Warnings">
      <p className={`text-lg font-semibold ${view.check.status === 'failed' ? 'text-pp-danger' : view.warnings.length ? 'text-pp-warning' : 'text-pp-success'}`}>
        {view.check.label}
      </p>
      {view.check.status === 'ran' && view.warnings.length === 0 && (
        <p className="mt-1 text-sm text-pp-muted">That&apos;s not a guarantee. Pay and get paid only through this page, and PayPal decides on any claim.</p>
      )}
      <p className="mt-2 text-xs text-pp-muted">{view.explainNote}</p>
      <ul className="mt-4 space-y-4">
        {view.warnings.map((w) => (
          <li key={w.signalId} className="rounded-md border-l-4 border-pp-warning bg-pp-surface p-4">
            <p className="font-semibold">{w.title}</p>
            {w.quote && <blockquote className="mt-2 border-l-2 border-pp-border pl-3 text-sm text-pp-ink/80">“{w.quote.text}”</blockquote>}
            <p className="mt-2 text-sm">{w.means}</p>
            <p className="mt-1 text-sm font-semibold">{w.todo}</p>
            <p className="mt-2 text-xs text-pp-muted">
              {w.found
                .map((f) =>
                  f.by === 'jev' ? `Jev ${Math.round((f.probability ?? 0) * 100)}%` : f.by === 'model' ? `Settle Link model ${Math.round((f.probability ?? 0) * 100)}%` : f.by.startsWith('rule') ? `keyword “${f.matched}”` : f.by === 'decline' ? 'their decline' : 'from the card',
                )
                .join(', ')}
              {w.cites.length > 0 && ` · PayPal terms: ${w.cites.join(', ')}`}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Chat({ view }: { view: DealView }) {
  return (
    <section aria-label="The chat">
      <h2 className="text-sm font-semibold text-pp-muted">The chat this card came from</h2>
      <ol className="mt-3 space-y-2">
        {view.messages.map((m) => (
          <li key={m.id} id={m.id} className={`flex ${m.from === 'seller' ? 'justify-start' : 'justify-end'}`}>
            <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.from === 'seller' ? 'bg-white' : 'bg-pp-highlight'}`}>
              <span className="block text-xs text-pp-muted">
                {m.from}, message {m.id.slice(1)}
                {m.added && `, added after payment by the ${m.added.by}`}
              </span>
              {m.text}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Decline({ view, busy, act }: { view: DealView; busy: boolean; act: (p: string, b?: unknown) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  if (view.order && view.order.status !== 'CREATED') return null;
  if (view.myDecline) {
    return (
      <section className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
        <p>
          You declined this deal: {view.declineReasons[view.myDecline as keyof typeof view.declineReasons].toLowerCase()}. The other side can see this.
        </p>
        <button disabled={busy} onClick={() => act('/decline', { withdraw: true })} className="mt-2 rounded-full border border-pp-border px-4 py-1.5 font-semibold">
          Withdraw my decline
        </button>
      </section>
    );
  }
  return (
    <section className="text-sm">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-pp-muted underline underline-offset-2 hover:text-pp-ink">
          Decline this deal
        </button>
      ) : (
        <div className="rounded-md border border-pp-border bg-pp-surface p-4">
          <p className="font-semibold">Why are you declining?</p>
          <p className="mt-1 text-pp-muted">The other side sees your reason. Nothing is paid.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(view.declineReasons).map(([id, label]) => (
              <button key={id} disabled={busy} onClick={() => act('/decline', { reason: id })} className="rounded-full border border-pp-border px-4 py-1.5 hover:border-pp-danger">
                {label}
              </button>
            ))}
            <button onClick={() => setOpen(false)} className="px-2 text-pp-muted underline">
              Keep the deal
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type Act = (p: string, b?: unknown) => Promise<unknown>;
type After = NonNullable<DealView['afterPayment']>;
type Gate = NonNullable<After['gate']>;

const MARK: Record<Gate['checks'][number]['status'], { glyph: string; tone: string; word: string }> = {
  pass: { glyph: '✓', tone: 'text-pp-success', word: 'Passes' },
  fail: { glyph: '✕', tone: 'text-pp-danger', word: 'Fails' },
  not_yet: { glyph: '○', tone: 'text-pp-muted', word: 'Not yet' },
  cant_check: { glyph: '?', tone: 'text-pp-warning', word: "Can't check" },
};

const DECISION_TONE: Record<Gate['decision'], string> = {
  SHIP: 'border-pp-success',
  HOLD: 'border-pp-danger',
  REVIEW: 'border-pp-warning',
};

function AfterPayment({ view, busy, act }: { view: DealView; busy: boolean; act: Act }) {
  const a = view.afterPayment!;
  const tone = a.payment.state === 'paid' || a.payment.state === 'held' ? 'text-pp-success' : a.payment.state === 'waiting' || a.payment.state === 'voided' ? 'text-pp-muted' : 'text-pp-danger';
  // Once tracking is on the PayPal order the parcel has gone: "ship or hold" no longer applies,
  // and the checklist as it stood at shipping is in the receipts and the evidence pack.
  const shipped = a.tracking?.state === 'sent';
  return (
    <div className="space-y-8">
      <section aria-label="Payment" className="text-sm">
        <p className={`font-semibold ${tone}`}>{a.payment.text}</p>
        <p className="mt-1 text-pp-muted">
          PayPal order <span className="font-mono">{view.order!.id}</span>
          {a.checkedAt && `, last ${view.realness.mode === 'judge' ? 'replayed from the recorded sandbox run' : 'read from PayPal'} ${new Date(a.checkedAt).toLocaleTimeString()}`}. Sandbox: no real money moved.
        </p>
        {a.fee && (
          <p className="mt-1 text-pp-muted">
            PayPal&apos;s fee on this payment: {a.fee.actual}
            {a.fee.estimate && ` (Settle estimated ${a.fee.estimate})`}
            {a.fee.net && `. You receive ${a.fee.net}`}.
          </p>
        )}
      </section>
      {a.disputes.map((d) => (view.role === 'seller' ? <DisputePanel key={d.id} d={d} busy={busy} act={act} dealId={view.id} judge={view.realness.mode === 'judge'} /> : <BuyerDispute key={d.id} d={d} />))}
      {a.handover && <HandoverPanel dealId={view.id} role={view.role} h={a.handover} judge={view.realness.mode === 'judge'} busy={busy} act={act} />}
      {a.gate && (shipped ? <ShippedPanel a={a} busy={busy} act={act} /> : <ShipPanel a={a} gate={a.gate} busy={busy} act={act} />)}
      {view.role === 'seller' && !shipped && <PaidCheckBox busy={busy} act={act} />}
      <AddMessages view={view} busy={busy} act={act} />
    </div>
  );
}

function ShipPanel({ a, gate, busy, act }: { a: After; gate: Gate; busy: boolean; act: Act }) {
  return (
    <section aria-label="Ship check" className="space-y-6">
      <div className={`border-l-4 ${DECISION_TONE[gate.decision]} bg-pp-surface px-5 py-4`}>
        <h2 className="text-[28px] font-semibold leading-tight text-pp-navy">{gate.headline}</h2>
        {gate.reasons.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-pp-muted">{gate.note}</p>
      </div>

      <ul aria-label="Seller Protection checklist" className="divide-y divide-pp-gridline rounded-md border border-pp-border bg-pp-surface">
        {gate.checks.map((c) => (
          <li key={c.id} className="flex gap-3 px-4 py-3">
            <span aria-hidden className={`w-5 shrink-0 text-center text-lg font-semibold leading-6 ${MARK[c.status].tone}`}>
              {MARK[c.status].glyph}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-semibold">
                {c.label} <span className={`font-normal ${MARK[c.status].tone}`}>({MARK[c.status].word})</span>
              </p>
              <p className="mt-0.5">{c.detail}</p>
              {(c.cites.length > 0 || c.proof) && (
                <p className="mt-1 text-xs text-pp-muted">
                  {c.cites.length > 0 && `PayPal terms: ${c.cites.join(', ')}`}
                  {c.cites.length > 0 && c.proof && '. '}
                  {c.proof && `Proof: ${c.proof}`}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="text-sm">
          <h3 className="font-semibold">Ship to this address only</h3>
          {a.shipTo ? (
            <address className="mt-2 not-italic leading-relaxed">
              {a.shipTo.name && <span className="block font-semibold">{a.shipTo.name}</span>}
              {a.shipTo.lines.map((l) => (
                <span key={l} className="block">{l}</span>
              ))}
              <span className="block">
                {a.shipTo.postalCode} {a.shipTo.countryCode}
              </span>
            </address>
          ) : (
            <p className="mt-2 text-pp-muted">PayPal&apos;s shipping address appears once the payment is confirmed.</p>
          )}
          <p className="mt-2 text-xs text-pp-muted">From the PayPal payment. Don&apos;t use an address sent in the chat.</p>
        </div>
        <LabelForm a={a} busy={busy} act={act} />
      </div>

      <TrackingForm a={a} busy={busy} act={act} />
    </section>
  );
}

function ShippedPanel({ a, busy, act }: { a: After; busy: boolean; act: Act }) {
  return (
    <section aria-label="Shipped" className="space-y-3 text-sm">
      <h2 className="text-lg font-semibold">Shipped</h2>
      <p>
        Tracking <span className="font-mono">{a.tracking!.number}</span> ({a.tracking!.carrier}) is on the PayPal order
        {a.shipTo && `, to the PayPal address (${a.shipTo.postalCode})`}. The ship check as it stood when you shipped is in the deal history and the evidence pack.
      </p>
      <DeliveredForm a={a} busy={busy} act={act} />
    </section>
  );
}

const input = 'w-full rounded-md border border-pp-border bg-white px-3 py-2 text-sm focus:border-pp-blue focus:outline-none focus:ring-2 focus:ring-pp-blue/30';
const primary = 'rounded-full bg-pp-blue px-5 py-2 text-sm font-semibold text-white disabled:opacity-40';

function LabelForm({ a, busy, act }: { a: After; busy: boolean; act: Act }) {
  const [code, setCode] = useState(a.labelPostcode ?? '');
  return (
    <form
      className="text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        act('/label', { postcode: code });
      }}
    >
      <label htmlFor="label-postcode" className="font-semibold">
        {a.postcodeLabel} on your shipping label
      </label>
      <p className="mt-1 text-pp-muted">Settle compares it with PayPal&apos;s address before you hand the parcel over.</p>
      <div className="mt-2 flex gap-2">
        <input id="label-postcode" value={code} onChange={(e) => setCode(e.target.value)} className={input} autoComplete="off" />
        <button disabled={busy || !code.trim()} className={primary}>
          Compare
        </button>
      </div>
    </form>
  );
}

function TrackingForm({ a, busy, act }: { a: After; busy: boolean; act: Act }) {
  const [carrier, setCarrier] = useState(a.carriers[0]?.id ?? '');
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  if (a.tracking?.state === 'sent') {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Tracking <span className="font-mono">{a.tracking.number}</span> ({a.tracking.carrier}) was added to the PayPal order.
        </p>
        <DeliveredForm a={a} busy={busy} act={act} />
      </div>
    );
  }
  return (
    <form
      className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        act('/tracking', { carrier, number, ...(carrier === 'OTHER' ? { carrierName: name } : {}) });
      }}
    >
      <h3 className="font-semibold">Add tracking to PayPal</h3>
      <p className="mt-1 text-pp-muted">
        After you post it. PayPal needs tracking as proof of shipment and delivery. Sent through PayPal&apos;s TypeScript SDK; the check passes once PayPal shows it on the order.
      </p>
      {a.tracking?.state === 'unknown' && (
        <p className="mt-2 text-pp-warning">PayPal didn&apos;t answer last time. Add it again: Settle checks PayPal first, so it won&apos;t be added twice.</p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
        <select aria-label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} className={input}>
          {a.carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input aria-label="Tracking number" placeholder="Tracking number" value={number} onChange={(e) => setNumber(e.target.value)} className={input} autoComplete="off" />
        <button disabled={busy || !number.trim()} className={primary}>
          Add tracking
        </button>
      </div>
      {carrier === 'OTHER' && <input aria-label="Carrier name" placeholder="Carrier name" value={name} onChange={(e) => setName(e.target.value)} className={`${input} mt-2`} />}
    </form>
  );
}

type PaidAnswer = { verdict: 'paid' | 'not_paid' | 'cant_check'; answer: string; notes: string[] };

function PaidCheckBox({ busy, act }: { busy: boolean; act: Act }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<PaidAnswer | null>(null);
  const tone = result?.verdict === 'paid' ? 'border-pp-success' : result?.verdict === 'not_paid' ? 'border-pp-danger' : 'border-pp-warning';
  const word = result?.verdict === 'paid' ? 'Paid' : result?.verdict === 'not_paid' ? 'Not paid' : "Couldn't reach PayPal";
  return (
    <section aria-label="Is this paid?" className="text-sm">
      <h2 className="text-lg font-semibold">Got a &ldquo;payment received&rdquo; message?</h2>
      <p className="mt-1 text-pp-muted">Paste the email or the text from the screenshot. Settle answers from this deal&apos;s PayPal order, not from the message. The text isn&apos;t saved.</p>
      <form
        className="mt-3 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const out = (await act('/paid-check', { text })) as PaidAnswer | undefined;
          if (out) setResult(out);
        }}
      >
        <textarea aria-label="Payment message" rows={4} value={text} onChange={(e) => setText(e.target.value)} className={input} />
        <button disabled={busy} className={primary}>
          Check with PayPal
        </button>
      </form>
      {result && (
        <div role="status" className={`mt-4 border-l-4 ${tone} bg-pp-surface px-4 py-3`}>
          <p className="text-lg font-semibold">{word}</p>
          <p className="mt-1">{result.answer}</p>
          {result.notes.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function AddMessages({ view, busy, act }: { view: DealView; busy: boolean; act: Act }) {
  const [text, setText] = useState('');
  const names = [...new Set(view.messages.map((m) => m.from))];
  return (
    <form
      className="text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await act('/messages', { text })) setText('');
      }}
    >
      <h2 className="text-lg font-semibold">New messages since payment</h2>
      <p className="mt-1 text-pp-muted">
        Paste any new messages from the chat, one per line starting with the sender&apos;s name as before. Settle checks them for warning signs, such as a new delivery address{view.role === 'seller' ? ', before you ship' : ''}.
      </p>
      <textarea aria-label="New messages" rows={3} value={text} onChange={(e) => setText(e.target.value)} className={`${input} mt-2`} placeholder={names.length ? 'Name: message' : undefined} />
      <button disabled={busy || !text.trim()} className={`${primary} mt-2`}>
        Add messages
      </button>
    </form>
  );
}

function DeliveredForm({ a, busy, act }: { a: After; busy: boolean; act: Act }) {
  const [date, setDate] = useState('');
  if (a.delivered) return <p>You recorded that the carrier shows it delivered on {a.delivered}.</p>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        act('/delivered', { date });
      }}
    >
      <label className="block">
        <span className="font-semibold">Carrier shows delivered on</span>
        <span className="block text-pp-muted">Settle can&apos;t see the carrier. Record it once their tracking page says delivered; a dispute needs it.</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${input} mt-1 w-auto`} />
      </label>
      <button disabled={busy || !date} className={primary}>
        Record delivery
      </button>
    </form>
  );
}

type DisputeView = After['disputes'][number];

const PROOF_MARK = {
  on_file: { glyph: '✓', tone: 'text-pp-success', word: 'On file' },
  missing: { glyph: '○', tone: 'text-pp-muted', word: 'Missing' },
  contradicts: { glyph: '✕', tone: 'text-pp-danger', word: 'Contradicts' },
} as const;

function due(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
}

function BuyerDispute({ d }: { d: DisputeView }) {
  return (
    <section aria-label="Dispute" className="border-l-4 border-pp-warning bg-pp-surface px-5 py-4 text-sm">
      <h2 className="text-lg font-semibold">You opened a PayPal dispute: {d.reason.toLowerCase()}</h2>
      <p className="mt-1 text-pp-muted">
        Case {d.id}, {d.status === 'RESOLVED' ? `resolved${d.outcome ? ` (${d.outcome})` : ''}` : `status ${d.status.toLowerCase().replaceAll('_', ' ')}`}. PayPal decides it; follow it in your PayPal account.
      </p>
    </section>
  );
}

type Preview = { request: { advice: string; rel: string; url: string; json: unknown; files: { name: string; size: number; sha256: string }[]; hash: string }; recommended: boolean };

function DisputePanel({ d, busy, act, dealId, judge }: { d: DisputeView; busy: boolean; act: Act; dealId: string; judge: boolean }) {
  const plan = d.plan!;
  const cf = d.caseFile!;
  const resolved = d.status === 'RESOLVED';
  const choices = [plan.action ? plan.advice : null, ...plan.alternatives.map((x) => x.advice)].filter((x): x is NonNullable<typeof x> => !!x);
  // Start on a response PayPal offers: the advice if it can be sent, otherwise nothing picked.
  const [advice, setAdvice] = useState<string | null>(plan.action ? plan.advice : null);
  const [offer, setOffer] = useState('');
  const [withFiles, setWithFiles] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const getKey = useContext(KeyContext);
  const choice = { disputeId: d.id, advice, ...(advice === 'offer' ? { offerAmount: offer } : {}), ...(withFiles ? {} : { withFiles: false }) };

  const download = async () => {
    const key = getKey();
    setDownloadError(null);
    const res = await fetch(`/api/deals/${dealId}/disputes/pack?d=${encodeURIComponent(d.id)}`, { headers: keyHeaders(key), cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setDownloadError(body.error ?? 'The evidence pack could not be downloaded. Reload the page and try again.');
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `settle-evidence-${d.id}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label="Dispute" className="space-y-6">
      <div className={`border-l-4 ${resolved ? 'border-pp-border' : 'border-pp-danger'} bg-pp-surface px-5 py-4`}>
        <h2 className="text-[28px] font-semibold leading-tight text-pp-navy">
          {resolved ? 'Dispute resolved' : 'The buyer opened a dispute'}: {cf.reasonLabel.toLowerCase()}
        </h2>
        <p className="mt-2 text-sm">
          PayPal case {d.id}
          {d.amount && `, ${d.amount}`}. Stage {d.stage.toLowerCase().replaceAll('_', ' ')}, status {d.status.toLowerCase().replaceAll('_', ' ')}
          {d.outcome && `, outcome ${d.outcome}`}.
        </p>
        {!resolved && d.dueDate && <p className="mt-1 text-sm font-semibold">Respond by {due(d.dueDate)}.</p>}
        <p className="mt-1 text-xs text-pp-muted">
          {judge ? 'Replayed from the recorded sandbox case' : 'Read from PayPal'} {new Date(d.readAt).toLocaleTimeString()}
          {d.failedAt && '; the last re-read failed, so this may be out of date'}. Sandbox: no real money moves.
        </p>
      </div>

      <div>
        <h3 className="text-lg font-semibold">What the record shows</h3>
        <ul className="mt-2 divide-y divide-pp-gridline rounded-md border border-pp-border bg-pp-surface">
          {cf.proofs.map((p) => (
            <li key={p.id} className="flex gap-3 px-4 py-3 text-sm">
              <span aria-hidden className={`w-5 shrink-0 text-center text-lg font-semibold leading-6 ${PROOF_MARK[p.status].tone}`}>
                {PROOF_MARK[p.status].glyph}
              </span>
              <div className="min-w-0">
                <p className="font-semibold">
                  {p.label} <span className={`font-normal ${PROOF_MARK[p.status].tone}`}>({PROOF_MARK[p.status].word})</span>
                </p>
                <p className="mt-0.5">{p.detail}</p>
                <p className="mt-1 text-xs text-pp-muted">
                  Source: {p.source}. PayPal terms: {p.cites.join(', ')}.
                </p>
              </div>
            </li>
          ))}
        </ul>
        {cf.notes.map((n) => (
          <p key={n} className="mt-2 text-sm text-pp-muted">
            {n}
          </p>
        ))}
      </div>

      <div className="text-sm">
        <h3 className="text-lg font-semibold">Settle&apos;s advice: {d.adviceLabels![plan.advice].toLowerCase()}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {plan.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-3 font-semibold">
          Proof on file: {plan.score.lines.map((l) => `${l.points >= 0 ? '+' : ''}${l.points}`).join(' ')} = {plan.score.total} of {plan.score.of}
        </p>
        <p className="mt-1 text-pp-muted">{plan.note}</p>
        {plan.fallback && <p className="mt-2 text-pp-warning">{plan.fallback}</p>}
      </div>

      {!resolved && choices.length > 0 && (
        <div className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
          <h3 className="font-semibold">Respond to PayPal</h3>
          <p className="mt-1 text-pp-muted">Only the responses PayPal offers on this case right now. You see the exact request before anything is sent.</p>
          <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Response">
            {choices.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={advice === c}
                onClick={() => {
                  setAdvice(c);
                  setPreview(null);
                }}
                className={`rounded-full border px-4 py-1.5 ${advice === c ? 'border-pp-blue bg-pp-highlight font-semibold' : 'border-pp-border hover:border-pp-blue'}`}
              >
                {d.adviceLabels![c]}
                {c === plan.advice && ' (advised)'}
              </button>
            ))}
          </div>
          {advice === 'offer' && (
            <label className="mt-3 block">
              <span className="font-semibold">Refund to offer</span>
              <input value={offer} onChange={(e) => { setOffer(e.target.value); setPreview(null); }} className={`${input} mt-1 w-40`} inputMode="decimal" />
            </label>
          )}
          {advice === 'fight' && (
            <label className="mt-3 flex items-center gap-2">
              <input type="checkbox" checked={withFiles} onChange={(e) => { setWithFiles(e.target.checked); setPreview(null); }} />
              Attach the evidence pack PDF
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={busy || !advice}
              className={primary}
              onClick={async () => {
                const out = (await act('/disputes/preview', choice)) as Preview | undefined;
                if (out) setPreview(out);
              }}
            >
              Review the request
            </button>
            <button type="button" onClick={download} className="rounded-full border border-pp-border px-5 py-2 font-semibold">
              Download evidence pack
            </button>
          </div>
          {downloadError && <p role="alert" className="mt-2 text-pp-danger">{downloadError}</p>}

          {preview && (
            <div className="mt-4 space-y-2 border-t border-pp-gridline pt-4">
              <p className="font-semibold">This is exactly what Settle will send to PayPal, as you:</p>
              <p className="font-mono text-xs break-all">POST {preview.request.url}</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-pp-canvas p-3 text-xs whitespace-pre-wrap">{JSON.stringify(preview.request.json, null, 2)}</pre>
              {preview.request.files.map((f) => (
                <p key={f.sha256} className="text-xs">
                  File {f.name}, {Math.round(f.size / 1024)} KB, SHA-256 <span className="font-mono break-all">{f.sha256}</span>
                </p>
              ))}
              <p className="text-xs text-pp-muted">Request fingerprint {preview.request.hash.slice(0, 16)}…. If the case or the record changes before you approve, Settle asks you to review again.</p>
              <button
                disabled={busy}
                className="rounded-full bg-pp-navy px-5 py-2 font-semibold text-white disabled:opacity-40"
                onClick={async () => {
                  if (await act('/disputes/submit', { ...choice, hash: preview.request.hash })) setPreview(null);
                }}
              >
                Approve and send to PayPal
              </button>
            </div>
          )}
        </div>
      )}

      {(resolved || choices.length === 0) && (
        <div className="text-sm">
          <button type="button" onClick={download} className="rounded-full border border-pp-border px-5 py-2 font-semibold">
            Download evidence pack
          </button>
          {downloadError && <p role="alert" className="mt-2 text-pp-danger">{downloadError}</p>}
        </div>
      )}

      {d.submissions.length > 0 && (
        <ul className="space-y-1 text-sm">
          {d.submissions.map((x) => (
            <li key={x.at + x.rel}>
              {x.rel.replaceAll('_', ' ')}: {x.state}
              {x.debugId && <span className="text-pp-muted"> (PayPal debug ID {x.debugId})</span>}, {new Date(x.at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The deal's history from its receipts, and whether the chain of receipts verifies. */
function History({ view }: { view: DealView }) {
  const h = view.history;
  if (h.items.length === 0) return null;
  return (
    <details className="rounded-md border border-pp-border bg-pp-surface text-sm">
      <summary className="cursor-pointer px-4 py-3 font-semibold">
        History of this deal ({h.items.length} steps){' '}
        <span className={`font-normal ${h.chain.ok ? 'text-pp-success' : 'text-pp-danger'}`}>
          {h.chain.ok ? 'record verifies' : 'record does not verify'}
        </span>
      </summary>
      <div className="border-t border-pp-gridline px-4 py-3">
        <p className="text-xs text-pp-muted">
          {h.chain.ok
            ? `Each step is a receipt holding the hash of the one before, so a step changed, reordered or removed from the middle would show here${h.chain.count !== null ? `; all ${h.chain.count} check out` : ''}. Steps removed from the very end would not.`
            : `${h.chain.brokenAt !== null ? `Receipt ${h.chain.brokenAt}` : 'A step'} does not check out (${h.chain.reason}). The record from there on can't be trusted.`}
        </p>
        <ol className="mt-3 space-y-2">
          {h.items.map((i) => (
            <li key={i.seq} className="grid gap-x-3 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
              <time dateTime={i.at} className="text-xs text-pp-muted tabular-nums">
                {new Date(i.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </time>
              <span>
                {i.text}
                {i.debugId && (
                  <span className="text-xs text-pp-muted">
                    {' '}
                    PayPal debug ID {i.debugId}
                    {i.replayed && ' (replayed from the recorded sandbox run)'}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
