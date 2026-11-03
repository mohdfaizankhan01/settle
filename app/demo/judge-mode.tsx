'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DealPage } from '@/app/d/[id]/deal-page';

type DemoDeal = { dealId: string; scenario: string; keys: { seller: string; buyer: string }; title: string; side: 'buyer' | 'seller'; shows: string };
type Session = { createdAt: string; expiresAt: string; deals: DemoDeal[] };

export function JudgeMode() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [picked, setPicked] = useState<string | null>(null);
  const [side, setSide] = useState<'buyer' | 'seller'>('seller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/demo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => setSession(b.session ?? null))
      .catch(() => setSession(null));
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Judge mode could not start.');
      setSession(body.session);
      setPicked(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Judge mode could not start.');
    } finally {
      setBusy(false);
    }
  }, []);

  const current = session?.deals.find((d) => d.scenario === picked) ?? session?.deals[0];
  const pick = (d: DemoDeal) => {
    setPicked(d.scenario);
    setSide(d.side);
  };

  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">
        Judge mode: demo deals in a private session. Settle&apos;s checks run live; PayPal is replayed from a real sandbox run, so nothing reaches PayPal and no money moves.
      </div>
      <main className="mx-auto w-full max-w-[1400px] px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <header className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="text-[28px] font-semibold text-pp-navy">Judge mode</h1>
            <p className="mt-1 text-pp-muted">
              One deal at each stage, from the first DM to a dispute. Pick one to see the buyer and the seller side by side, and act as either.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link href="/demo/attacks" className="rounded-full border border-pp-border bg-pp-surface px-4 py-2 font-semibold">
              Try to fool it
            </Link>
            <Link href="/proof" className="rounded-full border border-pp-border bg-pp-surface px-4 py-2 font-semibold">
              Proof
            </Link>
            <button onClick={start} disabled={busy} className="rounded-full bg-pp-blue px-5 py-2 font-semibold text-white disabled:opacity-40">
              {busy ? 'Setting up six deals…' : session ? 'Start over with fresh deals' : 'Start judge mode'}
            </button>
          </div>
        </header>
        {error && (
          <p role="alert" className="mt-4 text-pp-danger">
            {error}
          </p>
        )}

        {session === undefined && <p className="mt-10 text-pp-muted">Loading…</p>}
        {session === null && (
          <p className="mt-10 max-w-2xl">
            Starting judge mode creates six demo deals that only this browser can see. They expire after a day. Real deals are never shown or changed.
          </p>
        )}

        {session && current && (
          <div className="mt-10 grid gap-8 xl:grid-cols-[18rem_minmax(0,1fr)]">
            <nav aria-label="Demo deals">
              <ul className="divide-y divide-pp-gridline rounded-md border border-pp-border bg-pp-surface">
                {session.deals.map((d) => {
                  const on = d.scenario === current.scenario;
                  return (
                    <li key={d.dealId}>
                      <button onClick={() => pick(d)} aria-current={on} className={`block w-full px-4 py-3 text-left text-sm ${on ? 'bg-pp-highlight' : 'hover:bg-pp-canvas'}`}>
                        <span className={`block ${on ? 'font-semibold text-pp-navy' : 'font-semibold'}`}>{d.title}</span>
                        <span className="mt-0.5 block text-pp-muted">Best seen as the {d.side}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-pp-muted">Session started {new Date(session.createdAt).toLocaleString()}; expires {new Date(session.expiresAt).toLocaleString()}.</p>
            </nav>

            <section aria-label={current.title}>
              <p className="max-w-3xl">{current.shows}</p>
              <div className="mt-4 flex gap-2 lg:hidden" role="tablist" aria-label="Whose view">
                {(['buyer', 'seller'] as const).map((s) => (
                  <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={`rounded-full border px-4 py-1.5 text-sm ${side === s ? 'border-pp-blue bg-pp-highlight font-semibold' : 'border-pp-border'}`}>
                    {s === 'buyer' ? "Buyer's view" : "Seller's view"}
                  </button>
                ))}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                {(['buyer', 'seller'] as const).map((s) => (
                  <div key={`${current.dealId}-${s}`} className={`rounded-lg border border-pp-border bg-pp-canvas p-4 ${side === s ? '' : 'hidden lg:block'}`}>
                    <h2 className="mb-3 text-sm font-semibold text-pp-muted">{s === 'buyer' ? "Buyer's view" : "Seller's view"}</h2>
                    <DealPage dealId={current.dealId} linkKey={current.keys[s]} embedded />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
