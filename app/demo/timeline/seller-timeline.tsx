'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TimelineData } from './scheduler';

// Bryntum Scheduler needs the browser, so it loads on the client only.
const Scheduler = dynamic(() => import('./scheduler'), { ssr: false, loading: () => <p className="text-pp-muted">Loading the timeline…</p> });

export function SellerTimeline() {
  const [data, setData] = useState<TimelineData | null | undefined>(undefined);

  useEffect(() => {
    fetch('/api/demo/timeline', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => setData(b.timeline ?? null))
      .catch(() => setData(null));
  }, []);

  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">
        Judge mode: demo deals with back-dated demo dates. Payment, tracking and dispute data are replayed from a real PayPal sandbox run.
      </div>
      <main className="mx-auto w-full max-w-[1400px] px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Seller timeline</h1>
        <p className="mt-1 max-w-3xl text-pp-muted">
          Every deal as a seller sees it over time: when both sides agreed, when PayPal confirmed payment, the window to ship in, delivery, and a dispute&apos;s response window. Rows are coloured by Settle&apos;s ship check. Click a row or an event to open that deal.
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Colours">
          {[
            ['bg-[#2e7d32]', 'Ready to ship'],
            ['bg-[#c62828]', 'Hold, or a dispute'],
            ['bg-[#ef6c00]', 'Warning or review'],
            ['bg-[#1565c0]', 'Before payment'],
          ].map(([c, l]) => (
            <li key={l} className="flex items-center gap-2">
              <span aria-hidden className={`inline-block h-3 w-3 rounded-sm ${c}`} />
              {l}
            </li>
          ))}
        </ul>
        <div className="mt-6">
          {data === undefined && <p className="text-pp-muted">Loading…</p>}
          {data === null && (
            <p>
              Start judge mode first: the timeline shows this browser&apos;s demo deals.{' '}
              <Link href="/demo" className="text-pp-blue underline underline-offset-2">
                Go to judge mode
              </Link>
            </p>
          )}
          {data && <Scheduler data={data} />}
        </div>
        <p className="mt-4 text-xs text-pp-muted">Timeline by Bryntum Scheduler (trial licence).</p>
      </main>
    </div>
  );
}
