'use client';

import { useEffect, useRef, useState } from 'react';
import { payerOnThisPhone, rememberPayer } from './handover-panel';
import { keyHeaders } from './link-auth';

// PayPal JS SDK v6 (sandbox). The browser only asks our server to create the order from the
// locked card and, after approval, to capture it; it never sends an amount or payee.
// Reference: the paypal plugin's js-sdk-v6.md (createInstance, one-time payment session).

const SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';

type Checkout = { clientId: string; merchantId: string; amount: string; currency: string; hold?: boolean };

type PayPalSession = { start: (opts: { presentationMode: string }, order: Promise<{ orderId: string }>) => Promise<void> };
type PayPalSdk = {
  createInstance: (opts: Record<string, unknown>) => Promise<{
    findEligibleMethods: (opts: { currencyCode: string; amount: string }) => Promise<{ isEligible: (m: string) => boolean }>;
    createPayPalOneTimePaymentSession: (callbacks: {
      onApprove: (data: { orderId: string }) => Promise<void>;
      onCancel: () => void;
      onError: (error: { message?: string }) => void;
    }) => PayPalSession;
  }>;
};

let sdkPromise: Promise<PayPalSdk> | undefined;
function loadSdk(): Promise<PayPalSdk> {
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve((window as unknown as { paypal: PayPalSdk }).paypal);
    script.onerror = () => {
      sdkPromise = undefined;
      reject(new Error('PayPal checkout could not load. Check your connection and reload.'));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string };
    }
  }
}

export function PayButton(props: { dealId: string; getKey: () => string; checkout: Checkout; onDone: () => void; onError: (m: string) => void }) {
  const { dealId, checkout } = props;
  const { clientId, merchantId, amount, currency } = checkout;
  // Callbacks change on every parent render; keep the latest without re-creating the PayPal session.
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });
  const onError = (m: string) => callbacks.current.onError(m);
  const session = useRef<PayPalSession | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'ineligible' | 'paying'>('loading');

  useEffect(() => {
    let cancelled = false;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`/api/deals/${dealId}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...keyHeaders(callbacks.current.getKey()), 'x-settle-payer': payerOnThisPhone(dealId) ?? '' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.debugId ? `${out.error} (PayPal debug ID ${out.debugId})` : out.error);
      return out;
    };
    (async () => {
      const paypal = await loadSdk();
      const sdk = await paypal.createInstance({ clientId, merchantId, components: ['paypal-payments'], pageType: 'checkout' });
      const methods = await sdk.findEligibleMethods({ currencyCode: currency, amount });
      if (cancelled) return;
      if (!methods.isEligible('paypal')) return setState('ineligible');
      session.current = sdk.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => {
          try {
            await post('/capture', { orderId });
          } catch (e) {
            callbacks.current.onError(e instanceof Error ? e.message : 'The payment was not captured.');
          }
          setState('ready');
          callbacks.current.onDone();
        },
        onCancel: () => setState('ready'),
        onError: (e) => {
          setState('ready');
          callbacks.current.onError(e.message ?? 'PayPal reported an error.');
        },
      });
      setState('ready');
    })().catch((e: Error) => {
      if (!cancelled) callbacks.current.onError(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [dealId, clientId, merchantId, amount, currency]);

  async function pay() {
    if (!session.current) return;
    setState('paying');
    const order = fetch(`/api/deals/${dealId}/order`, { method: 'POST', headers: { ...keyHeaders(callbacks.current.getKey()), 'x-settle-payer': payerOnThisPhone(dealId) ?? '' } }).then(async (res) => {
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'The order could not be created.');
      // Meet-up deals: this phone is now the payer's; only it can confirm the handover later.
      if (typeof out.payerSecret === 'string') rememberPayer(dealId, out.payerSecret);
      return { orderId: out.orderId as string };
    });
    try {
      // v6 needs the promise itself, not a function (plugin note on a known SDK bug).
      await session.current.start({ presentationMode: 'auto' }, order);
    } catch (e) {
      setState('ready');
      onError(e instanceof Error ? e.message : 'Checkout did not start.');
    }
  }

  return (
    <section className="rounded-md border border-pp-border bg-pp-surface p-4">
      <h2 className="font-semibold">{checkout.hold ? 'Hold the payment with PayPal' : 'Pay with PayPal'}</h2>
      <p className="mt-1 text-sm text-pp-muted">
        {checkout.hold
          ? "PayPal holds exactly the total on the confirmed card on your account. Nothing goes to the seller until you've checked the item and scanned their code at the meet-up. Do this on the phone you'll bring, in its main browser (if this opened inside Instagram, Messenger or Facebook, choose \"Open in browser\" first): only that browser can confirm the handover. Sandbox only: use a sandbox buyer login."
          : 'PayPal charges exactly the total on the confirmed card (“Buyer pays” above), paid to the seller\'s own PayPal account. Sandbox only: use a sandbox buyer login.'}
      </p>
      {state === 'ineligible' ? (
        <p className="mt-3 text-sm text-pp-warning">PayPal checkout isn&apos;t available for this amount or currency.</p>
      ) : (
        <div className="mt-3 max-w-sm">
          {state === 'ready' ? (
            // PayPal's own v6 button component, so the button looks the way PayPal requires.
            <paypal-button type="pay" onClick={pay}></paypal-button>
          ) : (
            <p className="text-sm text-pp-muted">{state === 'loading' ? 'Loading PayPal…' : 'Waiting for PayPal…'}</p>
          )}
        </div>
      )}
    </section>
  );
}
