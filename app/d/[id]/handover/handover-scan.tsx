'use client';

// What the buyer's phone shows after scanning the seller's code. It needs both: the seller's
// one-time code (from this URL's fragment) and the buyer's own link key (remembered on this phone
// when the buyer opened their deal link). The server checks both, re-reads the hold from PayPal,
// and only then takes the money. Nothing here can move money without the buyer's tap.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Shell } from '@/app/components/shell';
import type { DealView } from '@/lib/settle/view';
import { buyerKeyOnThisPhone, payerOnThisPhone } from '../handover-panel';
import { keyHeaders } from '../link-auth';

export function HandoverScan({ dealId }: { dealId: string }) {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const key = useRef<string | null>(null);
  const [view, setView] = useState<DealView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'sending' | 'done'>('loading');

  useEffect(() => {
    // The code moves from the address bar into this tab's session storage, so it isn't left in the
    // history and survives the page mounting again after the URL changes.
    const slot = `settle-handover-code:${dealId}`;
    const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get('t');
    try {
      if (fromUrl) sessionStorage.setItem(slot, fromUrl);
      token.current = fromUrl ?? sessionStorage.getItem(slot);
    } catch {
      token.current = fromUrl;
    }
    // Through the router: Next.js keeps its own history state, so a bare replaceState is undone.
    if (fromUrl) router.replace(window.location.pathname, { scroll: false });
    key.current = buyerKeyOnThisPhone(dealId);
    Promise.resolve()
      .then(() => {
        if (!token.current) throw new Error("This page needs the seller's code. Scan it again from their phone.");
        if (!key.current) throw new Error("This phone doesn't know you're the buyer yet. Open your own deal link on this phone first, then scan the seller's code again.");
        if (!payerOnThisPhone(dealId)) throw new Error('Only the phone that placed the PayPal hold can confirm the handover. Scan the code with that phone.');
        return fetch(`/api/deals/${dealId}`, { headers: keyHeaders(key.current), cache: 'no-store' });
      })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'This deal could not be loaded.');
        if (body.role !== 'buyer') throw new Error('Only the buyer confirms the handover. Open the buyer\'s own deal link on this phone.');
        setView(body);
        setState('ready');
      })
      .catch((e: Error) => setProblem(e.message));
  }, [dealId, router]);

  // The key stays out of the rendered page; the link is built only when tapped.
  const backToDeal = () => router.push(`/d/${dealId}#k=${encodeURIComponent(key.current ?? '')}`);

  async function release() {
    setState('sending');
    setProblem(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/handover/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...keyHeaders(key.current ?? ''), 'x-settle-payer': payerOnThisPhone(dealId) ?? '' },
        body: JSON.stringify({ token: token.current }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'The payment was not taken.');
      if (out.captureStatus && out.captureStatus !== 'COMPLETED') {
        setState('ready');
        return void setProblem(`PayPal shows the payment as ${out.captureStatus}, not completed. Don't take the item yet; your deal page updates when PayPal finishes.`);
      }
      setState('done');
    } catch (e) {
      setState('ready');
      setProblem(e instanceof Error ? e.message : 'The payment was not taken.');
    }
  }

  const item = view?.terms.find((t) => t.key === 'item')?.display;
  const total = view?.money?.total;
  const h = view?.afterPayment?.handover;

  return (
    <Shell>
      {view?.realness.mode === 'judge' && <p className="mb-4 rounded-md border border-pp-warning/40 bg-pp-surface p-3 text-sm">{view.realness.paypal}</p>}
      <h1 className="text-[28px] font-semibold text-pp-navy">Handover</h1>
      {state === 'done' ? (
        <div className="mt-6 border-l-4 border-pp-success bg-pp-surface px-5 py-4">
          <p className="text-xl font-semibold text-pp-success">PayPal took the payment</p>
          <p className="mt-2">
            {total} for {item}, paid to the seller&apos;s PayPal account. The seller&apos;s own page now shows Handed over; take the item once they see it.
          </p>
          <p className="mt-2 text-sm text-pp-muted">
            It counts as paid once PayPal&apos;s verified notification arrives; your deal page shows it.{' '}
            <button className="text-pp-blue underline" onClick={backToDeal}>
              Back to the deal
            </button>
          </p>
        </div>
      ) : view && h?.state === 'held' ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-md border border-pp-border bg-pp-surface p-4">
            <p className="text-sm text-pp-muted">You&apos;re paying</p>
            <p className="text-3xl font-semibold text-pp-navy">{total}</p>
            <p className="mt-1">{item}</p>
          </div>
          <p className="border-l-4 border-pp-warning bg-pp-surface px-4 py-3 font-semibold">
            Only confirm after you&apos;ve checked the item. Confirming sends the money to the seller.
          </p>
          <div className="flex flex-wrap gap-3">
            <button disabled={state !== 'ready'} onClick={release} className="rounded-full bg-pp-blue px-6 py-3 font-semibold text-white disabled:opacity-40">
              {state === 'sending' ? 'Asking PayPal…' : `I've checked it: pay ${total}`}
            </button>
            <button onClick={backToDeal} className="rounded-full border border-pp-border px-6 py-3 font-semibold">
              Not yet
            </button>
          </div>
          <p className="text-xs text-pp-muted">An in-person handover isn&apos;t covered by PayPal Seller Protection or Item Not Received (SP-INPERSON, PP-COLLECT). PayPal decides any claim.</p>
        </div>
      ) : view ? (
        <p className="mt-6">
          {h?.state === 'released'
            ? 'This handover is already done: PayPal took the payment.'
            : h?.state === 'voided'
              ? 'This deal was called off and PayPal released the hold. Nothing was taken.'
              : "PayPal doesn't show the money held for this deal right now, so there's nothing to confirm."}
        </p>
      ) : null}
      {problem && (
        <p role="alert" className="mt-4 text-pp-danger">
          {problem}
        </p>
      )}
      {state === 'loading' && !problem && <p className="mt-6 text-pp-muted">Loading the handover…</p>}
    </Shell>
  );
}
