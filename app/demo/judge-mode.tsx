'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DealPage } from '@/app/d/[id]/deal-page';
import { rememberPayer } from '@/app/d/[id]/handover-panel';
import { TopBar } from '@/app/components/brand';

type DemoDeal = { dealId: string; scenario: string; keys: { seller: string; buyer: string; payer?: string }; title: string; side: 'buyer' | 'seller'; shows: string };
type Session = { createdAt: string; expiresAt: string; deals: DemoDeal[] };

export function JudgeMode() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [picked, setPicked] = useState<string | null>(null);
  const [side, setSide] = useState<'buyer' | 'seller'>('seller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // /demo?deal=<scenario> (from the timeline) opens that deal.
    const want = new URLSearchParams(window.location.search).get('deal');
    fetch('/api/demo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => {
        setSession(b.session ?? null);
        const d = (b.session?.deals as DemoDeal[] | undefined)?.find((x) => x.scenario === want);
        if (d) {
          setPicked(d.scenario);
          setSide(d.side);
        }
      })
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
  // The meet-up demo deal: this browser plays the buyer's phone that placed the hold.
  useEffect(() => {
    for (const d of session?.deals ?? []) if (d.keys.payer) rememberPayer(d.dealId, d.keys.payer);
  }, [session]);
  const pick = (d: DemoDeal) => {
    setPicked(d.scenario);
    setSide(d.side);
  };

  return (
    <div className="min-h-full">
      <TopBar width="max-w-[1400px]" note={"Judge mode: demo deals in a private session. Settle's checks run live; PayPal is replayed from a real sandbox run, so nothing reaches PayPal and no money moves."} />
      <main className="mx-auto w-full max-w-[1400px] px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <header className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="text-[36px] font-semibold tracking-[-0.035em] text-pp-navy">
              Judge <span className="font-serif font-normal italic text-pp-blue">mode</span>
            </h1>
            <p className="mt-2 text-lg leading-relaxed text-pp-muted">
              One deal at each stage, from the first DM to a dispute. Pick one to see the buyer and the seller side by side, and act as either.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {session && (
              <Link href="/demo/timeline" className="lift rounded-full border border-pp-border bg-pp-surface px-4 py-2 font-semibold text-pp-navy shadow-[var(--pp-shadow-sm)]">
                Seller timeline
              </Link>
            )}
            <Link href="/demo/attacks" className="lift rounded-full border border-pp-border bg-pp-surface px-4 py-2 font-semibold text-pp-navy shadow-[var(--pp-shadow-sm)]">
              Try to fool it
            </Link>
            <Link href="/proof" className="lift rounded-full border border-pp-border bg-pp-surface px-4 py-2 font-semibold text-pp-navy shadow-[var(--pp-shadow-sm)]">
              Proof
            </Link>
            <button onClick={start} disabled={busy} aria-busy={busy} className="btn-primary inline-flex items-center gap-2 rounded-full px-5 py-2 font-semibold disabled:opacity-40">
              {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
              {busy ? 'Setting up seven deals…' : session ? 'Start over with fresh deals' : 'Start judge mode'}
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
            Starting judge mode creates seven demo deals that only this browser can see. They expire after a day. Real deals are never shown or changed.
          </p>
        )}

        {session && current && (
          <div className="mt-10 grid gap-8 xl:grid-cols-[18rem_minmax(0,1fr)]">
            <nav aria-label="Demo deals">
              <ul className="stagger surface space-y-1 rounded-2xl p-1.5">
                {session.deals.map((d) => {
                  const on = d.scenario === current.scenario;
                  return (
                    <li key={d.dealId}>
                      <button onClick={() => pick(d)} aria-current={on} className={`relative block w-full rounded-xl px-4 py-3 text-left text-sm ${on ? 'bg-pp-highlight' : 'hover:bg-pp-canvas'}`}>
                        <span className={`absolute inset-y-3 left-0 w-[3px] rounded-full bg-pp-blue transition-opacity duration-200 ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                        <span className={`block font-semibold ${on ? 'text-pp-navy' : ''}`}>{d.title}</span>
                        <span className="mt-0.5 block text-pp-muted">Best seen as the {d.side}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-pp-muted">Session started {new Date(session.createdAt).toLocaleString()}; expires {new Date(session.expiresAt).toLocaleString()}.</p>
            </nav>

            <section aria-label={current.title}>
              <p key={current.scenario} className="rise max-w-3xl text-[15px] leading-relaxed">{current.shows}</p>
              <div className="mt-4 flex gap-2 lg:hidden" role="tablist" aria-label="Whose view">
                {(['buyer', 'seller'] as const).map((s) => (
                  <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={`rounded-full border px-4 py-1.5 text-sm ${side === s ? 'border-pp-blue bg-pp-highlight font-semibold text-pp-navy' : 'border-pp-border bg-pp-surface'}`}>
                    {s === 'buyer' ? "Buyer's view" : "Seller's view"}
                  </button>
                ))}
              </div>
              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                {(['buyer', 'seller'] as const).map((s) => (
                  <div key={`${current.dealId}-${s}`} className={`rise rounded-3xl border border-pp-border/80 bg-gradient-to-b from-pp-surface to-pp-canvas p-5 shadow-[var(--pp-shadow-md)] ${side === s ? '' : 'hidden lg:block'}`}>
                    <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-pp-navy">
                      <span className={`h-2 w-2 rounded-full ${s === 'buyer' ? 'bg-pp-sky' : 'bg-pp-navy'}`} aria-hidden="true" />
                      {s === 'buyer' ? "Buyer's view" : "Seller's view"}
                    </h2>
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
