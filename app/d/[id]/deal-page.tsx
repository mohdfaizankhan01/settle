'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Shell } from '@/app/components/shell';
import type { DealView, SourceView } from '@/lib/settle/view';
import { PayButton } from './pay-button';

const keyFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('k') ?? '';

export function DealPage({ dealId }: { dealId: string }) {
  // Read once on the client; the key never goes into React state or the rendered page.
  const keyRef = useRef<string | null>(null);
  const [view, setView] = useState<DealView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (k: string) => {
      const res = await fetch(`/api/deals/${dealId}`, { headers: { 'x-settle-key': k }, cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'This deal could not be loaded.');
      setView(body);
    },
    [dealId],
  );

  useEffect(() => {
    keyRef.current = keyFromHash();
    load(keyRef.current).catch((e: Error) => setError(e.message));
  }, [load]);

  const act = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/deals/${dealId}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-settle-key': keyRef.current ?? '' },
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
      <Shell>
        <p className={error ? 'text-pp-danger' : 'text-pp-muted'}>{error ?? 'Loading the deal…'}</p>
      </Shell>
    );
  }

  const me = view.role;
  const other = me === 'seller' ? 'buyer' : 'seller';

  return (
    <Shell wide>
      <header className="flex flex-wrap items-end justify-between gap-4">
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

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="order-2 space-y-8 lg:order-1">
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

          {me === 'buyer' && view.checkout && !view.payBlocker && <PayButton dealId={dealId} getKey={() => keyRef.current ?? ''} checkout={view.checkout} onDone={() => load(keyRef.current ?? '')} onError={setError} />}
          {view.order && (
            <section className="rounded-md border border-pp-border bg-pp-surface p-4 text-sm">
              <p>
                PayPal order <span className="font-mono">{view.order.id}</span>: {orderStatusText(view.order.status)}
              </p>
            </section>
          )}
        </div>

        <aside className="order-1 space-y-8 lg:order-2">
          <Warnings view={view} />
          {view.check.status === 'failed' && (
            <button disabled={busy} onClick={() => act('/recheck')} className="rounded-full border border-pp-border bg-pp-surface px-5 py-2 font-semibold disabled:opacity-40">
              {busy ? 'Checking…' : 'Run the check again'}
            </button>
          )}
          <Chat view={view} />
        </aside>
      </div>
    </Shell>
  );
}

function orderStatusText(status: string) {
  if (status === 'CREATED') return 'created, waiting for the buyer to approve it in PayPal.';
  if (status === 'CAPTURE_REQUESTED')
    return 'PayPal accepted the capture. Settle treats the payment as confirmed only after PayPal\'s own notification is verified (coming in the next milestone), so the seller should not ship yet.';
  return `status ${status}.`;
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
      <ul className="mt-4 space-y-4">
        {view.warnings.map((w) => (
          <li key={w.signalId} className="rounded-md border-l-4 border-pp-warning bg-pp-surface p-4">
            <p className="font-semibold">{w.title}</p>
            {w.quote && <blockquote className="mt-2 border-l-2 border-pp-border pl-3 text-sm text-pp-ink/80">“{w.quote.text}”</blockquote>}
            <p className="mt-2 text-sm">{w.means}</p>
            <p className="mt-1 text-sm font-semibold">{w.todo}</p>
            <p className="mt-2 text-xs text-pp-muted">
              {w.found.map((f) => (f.by === 'jev' ? `Jev ${Math.round((f.probability ?? 0) * 100)}%` : f.by.startsWith('rule') ? `keyword “${f.matched}”` : 'from the card')).join(', ')}
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
              </span>
              {m.text}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
