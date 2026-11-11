'use client';

// Meet-up mode on the deal page (DECISIONS #20). The seller sees the hold PayPal confirmed and
// shows a one-time QR code at the handover; the buyer scans it with this phone's camera, which
// opens /d/<id>/handover. That page has no link key in its URL, so the buyer's phone remembers the
// key when the buyer opens their own deal link. Either side can call the deal off, which releases
// the hold. Wording: PayPal holds the money, never Settle; nothing is "protected".

import QRCode from 'qrcode';
import { useState } from 'react';
import type { DealView } from '@/lib/settle/view';

type Handover = NonNullable<NonNullable<DealView['afterPayment']>['handover']>;
type Act = (p: string, b?: unknown) => Promise<unknown>;

const storageKey = (dealId: string) => `settle-buyer-key:${dealId}`;

/** Remembers the buyer's link key on this phone, for the handover page. Never required elsewhere. */
export function rememberBuyerKey(dealId: string, key: string) {
  try {
    if (key) localStorage.setItem(storageKey(dealId), key);
  } catch {
    // Private mode or blocked storage: the handover page explains how to open the deal link first.
  }
}

const payerKey = (dealId: string) => `settle-payer:${dealId}`;

/** Meet-up deals: the secret this phone got when it started the PayPal hold. Only this phone can release it. */
export function rememberPayer(dealId: string, secret: string) {
  try {
    localStorage.setItem(payerKey(dealId), secret);
  } catch {
    // Without storage this phone can't confirm the handover; the scan page says so.
  }
}

export function payerOnThisPhone(dealId: string): string | null {
  try {
    return localStorage.getItem(payerKey(dealId));
  } catch {
    return null;
  }
}

export function buyerKeyOnThisPhone(dealId: string): string | null {
  try {
    return localStorage.getItem(storageKey(dealId));
  } catch {
    return null;
  }
}

const primary = 'rounded-full bg-pp-blue px-5 py-2 text-sm font-semibold text-white disabled:opacity-40';
const secondary = 'rounded-full border border-pp-border px-5 py-2 text-sm font-semibold disabled:opacity-40';
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function HandoverPanel({ dealId, role, h, judge, busy, act }: { dealId: string; role: 'buyer' | 'seller'; h: Handover; judge: boolean; busy: boolean; act: Act }) {
  const [code, setCode] = useState<{ url: string; qr: string; expiresAt: string } | null>(null);

  async function showCode() {
    const out = (await act('/handover/code')) as { token: string; expiresAt: string } | undefined;
    if (!out) return;
    const url = `${window.location.origin}/d/${dealId}/handover#t=${encodeURIComponent(out.token)}`;
    setCode({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: 'M' }), expiresAt: out.expiresAt });
  }

  const callOff = (
    <button disabled={busy} onClick={() => act('/handover/cancel')} className={secondary}>
      {role === 'buyer' ? "Don't buy: release the hold" : 'Call it off: release the hold'}
    </button>
  );

  return (
    <section aria-label="Handover" className="space-y-4">
      <div className={`border-l-4 ${h.state === 'held' ? 'border-pp-success' : h.state === 'voided' ? 'border-pp-border' : 'border-pp-blue'} bg-pp-surface px-5 py-4`}>
        <h2 className="text-[28px] font-semibold leading-tight text-pp-navy">
          {h.state === 'held'
            ? `PayPal holds ${h.total}`
            : h.state === 'pending'
              ? 'Not confirmed yet: keep the item'
            : h.state === 'released'
              ? 'Handed over'
              : h.state === 'voided'
                ? 'Called off: hold released'
                : h.state === 'waiting'
                  ? 'Waiting for PayPal to confirm the hold'
                  : 'Completing with PayPal…'}
        </h2>
        <p className="mt-2 text-sm">
          {h.state === 'held'
            ? role === 'seller'
              ? "The money is on the buyer's account, held by PayPal. It is taken only when the buyer scans your code and confirms. Hand the item over when this page, on your own phone, says Handed over: never on the buyer's screen, which could be faked."
              : `PayPal holds the money on your account. Nothing is taken until you've checked the item and scanned the seller's code.`
            : h.state === 'pending'
              ? h.captureStatus && h.captureStatus !== 'COMPLETED'
                ? `The buyer confirmed on ${when(h.at)}, but PayPal shows the payment as ${h.captureStatus}. Don't hand the item over until this page says Handed over.`
                : `The buyer confirmed on ${when(h.at)}. Waiting for PayPal's verified confirmation, usually seconds: don't hand the item over until this page says Handed over.`
            : h.state === 'released'
              ? `The buyer scanned the code on ${when(h.at)} and PayPal took the money. You can hand the item over.`
              : h.state === 'voided'
                ? h.by === 'meet_by_passed'
                  ? `No handover within PayPal's ${h.holdDays}-day hold, so Settle Link released it on ${when(h.at)}. The buyer was not charged.`
                  : `The ${h.by} called it off on ${when(h.at)}. PayPal released the hold; the buyer was not charged.`
                : h.state === 'waiting'
                  ? "Don't meet to hand over until this page shows the hold."
                  : 'Settle Link sent the request to PayPal; this page updates when PayPal answers.'}
        </p>
        {h.state === 'held' && h.deadline && (
          <p className="mt-2 text-sm text-pp-muted">
            PayPal guarantees a hold for {h.holdDays} days. If there&apos;s no handover by {when(h.deadline)}, Settle Link releases it and the buyer isn&apos;t charged.
          </p>
        )}
        <p className="mt-2 text-xs text-pp-muted">
          An in-person handover isn&apos;t covered by PayPal Seller Protection, and Item Not Received doesn&apos;t apply to collection (SP-INPERSON, PP-COLLECT). The hold makes the payment real before you meet; PayPal decides any claim.
        </p>
      </div>

      {h.failed && (
        <p role="alert" className="rounded-md border border-pp-danger/40 bg-pp-surface p-3 text-sm text-pp-danger">
          {h.failed.kind === 'release' ? 'PayPal did not take the money' : 'Releasing the hold failed'} ({h.failed.reason}
          {h.failed.debugId ? `, PayPal debug ID ${h.failed.debugId}` : ''}). {h.failed.kind === 'release' ? "It's still held: don't hand the item over yet." : 'The money is still held.'}
        </p>
      )}

      {h.state === 'held' && role === 'seller' && (
        <div className="surface rounded-2xl p-4 text-sm">
          <h3 className="font-semibold">At the handover</h3>
          {code ? (
            <div className="mt-3 flex flex-wrap items-start gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made on this phone */}
              <img src={code.qr} alt="Handover code for the buyer to scan" width={220} height={220} className="rounded-md border border-pp-border bg-white p-2" />
              <div className="max-w-xs space-y-2">
                <p>Let the buyer check the item, then scan this with their phone&apos;s camera. It works once, until {when(code.expiresAt)}.</p>
                <p className="text-pp-muted">Only the buyer&apos;s phone that placed the hold can use it. Hand the item over once <strong>this page</strong> says Handed over; it updates by itself.</p>
                {judge && (
                  <p className="text-pp-muted">
                    Judge mode:{' '}
                    <a className="text-pp-blue underline" href={code.url} target="_blank" rel="noreferrer">
                      open the scan as the buyer
                    </a>{' '}
                    in a new tab. PayPal is replayed; no money moves.
                  </p>
                )}
                <button disabled={busy} onClick={showCode} className={secondary}>
                  New code
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="mt-1 text-pp-muted">When you meet, show the buyer a one-time code. It is valid for {h.codeMinutes} minutes.</p>
              <button disabled={busy} onClick={showCode} className={`${primary} mt-3`}>
                Show handover code
              </button>
            </>
          )}
        </div>
      )}

      {h.state === 'held' && role === 'buyer' && (
        <div className="surface rounded-2xl p-4 text-sm">
          <h3 className="font-semibold">At the handover</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Bring the phone you placed the hold with: only that phone can confirm the handover.</li>
            <li>Meet the seller and check the item.</li>
            <li>Scan the code on the seller&apos;s phone with your camera, and confirm. That&apos;s when PayPal takes the money.</li>
          </ol>
          <p className="mt-2 text-pp-muted">If the item isn&apos;t right, don&apos;t scan. Release the hold and you won&apos;t be charged.</p>
        </div>
      )}

      {h.canCancel && <div>{callOff}</div>}
    </section>
  );
}
