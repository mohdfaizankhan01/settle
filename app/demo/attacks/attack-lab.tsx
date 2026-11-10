'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AttackResult } from '@/lib/settle/attacks';
import { TopBar } from '@/app/components/brand';

export function AttackLab() {
  const [results, setResults] = useState<AttackResult[] | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/attacks', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'The attacks could not run.');
      setResults(body.results);
      setRanAt(body.ranAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The attacks could not run.');
    } finally {
      setBusy(false);
    }
  };

  const stopped = results?.filter((r) => r.stopped).length ?? 0;

  return (
    <div className="min-h-full">
      <TopBar note={"Judge mode: these attacks run through Settle's real server code in a throwaway store. PayPal is stood in, so nothing reaches PayPal and no money moves."} />
      <main className="mx-auto w-full max-w-4xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/demo" className="text-pp-blue underline underline-offset-2">
            Back to judge mode
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Try to fool it</h1>
        <p className="mt-1 max-w-2xl text-pp-muted">
          Ten ways people try to cheat a stranger deal. Each one runs now, against the same code a live deal uses. The result comes from what the code did, with the rule that stopped it and the test that proves it.
        </p>
        <button onClick={run} disabled={busy} className="mt-6 rounded-full bg-pp-blue px-5 py-2 font-semibold text-white disabled:opacity-40">
          {busy ? 'Running ten attacks…' : results ? 'Run them again' : 'Run the attacks'}
        </button>
        {error && (
          <p role="alert" className="mt-4 text-pp-danger">
            {error}
          </p>
        )}

        {results && (
          <>
            <p className="mt-8 text-lg font-semibold" role="status">
              {stopped} of {results.length} stopped
              <span className="ml-2 text-sm font-normal text-pp-muted">run at {new Date(ranAt!).toLocaleTimeString()}</span>
            </p>
            <ul className="mt-4 divide-y divide-pp-gridline surface rounded-2xl">
              {results.map((r) => (
                <li key={r.id} className="grid gap-1 px-5 py-4 text-sm sm:grid-cols-[1.5rem_minmax(0,1fr)]">
                  <span aria-hidden className={`text-lg font-semibold leading-6 ${r.stopped ? 'text-pp-success' : 'text-pp-danger'}`}>
                    {r.stopped ? '✓' : '✕'}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold">
                      {r.title} <span className={`font-normal ${r.stopped ? 'text-pp-success' : 'text-pp-danger'}`}>({r.stopped ? 'stopped' : 'not stopped'})</span>
                    </h2>
                    <p className="mt-1">
                      <span className="text-pp-muted">The attack: </span>
                      {r.attempt}
                    </p>
                    <p className="mt-1">
                      <span className="text-pp-muted">What Settle did: </span>
                      {r.outcome}
                    </p>
                    <p className="mt-2 text-xs text-pp-muted">
                      Stopped by {r.rule}. Proved by {r.test}. Took {r.ms} ms.
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
