'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell } from '@/app/components/shell';
import { findSpeakers } from '@/lib/settle/chat';
import { SHARED_CHAT_SLOT } from '@/lib/settle/share';

type Created = { dealId: string; keys: { seller: string; buyer: string } };

export default function CheckPage() {
  const [chat, setChat] = useState('');
  const [seller, setSeller] = useState('');
  const [country, setCountry] = useState<'US' | 'UK'>('UK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const [shared, setShared] = useState(false);

  // Shared from the phone's share sheet (app/share): the chat waits in this tab, read once.
  useEffect(() => {
    let text: string | null = null;
    try {
      text = sessionStorage.getItem(SHARED_CHAT_SLOT);
      sessionStorage.removeItem(SHARED_CHAT_SLOT);
    } catch {
      return;
    }
    if (!text) return;
    void Promise.resolve().then(() => {
      setChat(text);
      setShared(true);
    });
  }, []);

  const speakers = useMemo(() => findSpeakers(chat), [chat]);
  const sellerName = speakers.includes(seller) ? seller : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat, sellerName, country }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'The deal could not be created.');
      setCreated(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The deal could not be created.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const base = `${window.location.origin}/d/${created.dealId}`;
    return (
      <Shell>
        <h1 className="text-[34px] font-semibold tracking-[-0.03em] text-pp-navy">
          Your deal card is <span className="font-serif font-normal italic text-pp-blue">ready</span>
        </h1>
        <p className="mt-2 max-w-prose text-pp-muted">
          Each person opens their own link. Keep your link private: it lets whoever has it confirm the card for you.
        </p>
        <p className="mt-4 max-w-prose rounded-xl border border-pp-warning/30 bg-[#fffaf0] px-4 py-3 text-sm leading-relaxed">
          Each link locks to the first device that opens it. Open only your own, and send the other one without opening it: if you open it, it won&apos;t work for them. For a meet-up, the buyer should open theirs on the phone they&apos;ll bring.
        </p>
        <div className="stagger mt-8 space-y-4">
          <LinkRow who="Seller" url={`${base}#k=${created.keys.seller}`} />
          <LinkRow who="Buyer" url={`${base}#k=${created.keys.buyer}`} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-pp-navy">
        Nobody has to <span className="font-serif font-normal italic text-pp-blue">go first</span>
      </h1>
      <p className="mt-4 max-w-prose text-lg leading-relaxed text-pp-muted">
        Paste the chat where you agreed the deal, as the buyer or the seller. Settle Link turns it into one link you both confirm. The buyer
        pays through PayPal checkout, the seller ships once PayPal confirms the payment, and PayPal&apos;s protections stay in place
        for both of you.
      </p>
      <form onSubmit={submit} className="surface-raised mt-10 space-y-7 rounded-2xl p-6 sm:p-8">
        <label className="block">
          <span className="font-semibold text-pp-navy">The chat</span>
          <span className="mt-1 block text-sm text-pp-muted">
            {shared
              ? 'Shared from your phone. Check it holds the messages where you agreed the deal; nothing is saved until you make the link.'
              : 'One message per line, as “Name: message”. WhatsApp exports work as they are. On Android, install Settle Link from the browser menu and share messages straight to it.'}
          </span>
          <textarea
            value={chat}
            onChange={(e) => setChat(e.target.value)}
            rows={12}
            required
            className="mt-2 w-full rounded-xl border border-pp-border bg-pp-surface p-4 text-[15px] shadow-[var(--pp-shadow-sm)] transition-[border-color,box-shadow] duration-200 focus:border-pp-blue focus:shadow-[0_0_0_4px_rgba(0,112,224,0.12)] leading-relaxed outline-none"
            placeholder={'Sam: is the bike still for sale?\nAlex: yes, £120 and I can post it tracked\nSam: deal'}
          />
          <span className="mt-2 block text-xs text-pp-muted">
            Names, contact details and addresses are removed first, and prices, dates and links become placeholders. That redacted copy is sent to Groq&apos;s API so an AI can point at the terms; the scam check runs on our own server.{' '}
            <a href="/privacy" className="underline underline-offset-2">
              Privacy
            </a>
          </span>
        </label>

        {speakers.length === 2 && (
          <fieldset>
            <legend className="font-semibold text-pp-navy">Who is selling?</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {speakers.map((name) => (
                <label key={name} className="pressable flex cursor-pointer items-center gap-2 rounded-full border border-pp-border bg-pp-surface px-4 py-2.5 has-[:checked]:border-pp-blue has-[:checked]:bg-pp-highlight has-[:checked]:font-semibold has-[:checked]:text-pp-navy has-[:checked]:shadow-[0_0_0_3px_rgba(0,112,224,0.12)]">
                  <input type="radio" name="seller" value={name} checked={sellerName === name} onChange={() => setSeller(name)} />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {chat.trim() && speakers.length < 2 && <p className="text-sm text-pp-warning">Settle Link needs two people in the chat, each line starting with their name.</p>}

        <label className="block">
          <span className="font-semibold text-pp-navy">Seller&apos;s PayPal country</span>
          <select value={country} onChange={(e) => setCountry(e.target.value as 'US' | 'UK')} className="mt-2 block rounded-xl border border-pp-border bg-pp-surface px-4 py-2.5 shadow-[var(--pp-shadow-sm)] transition-[border-color,box-shadow] duration-200 focus:border-pp-blue focus:shadow-[0_0_0_4px_rgba(0,112,224,0.12)] focus:outline-none">
            <option value="UK">United Kingdom (GBP)</option>
            <option value="US">United States (USD)</option>
          </select>
        </label>

        {error && <p role="alert" className="text-pp-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || !sellerName}
          aria-busy={busy}
          className="btn-primary inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 font-semibold disabled:opacity-40"
        >
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
          {busy ? 'Reading the chat…' : 'Make the deal link'}
        </button>
      </form>
    </Shell>
  );
}

function LinkRow({ who, url }: { who: string; url: string }) {
  const [copied, setCopied] = useState(false);
  // Straight back into the chat with the phone's own share sheet; the chat shows the deal's card.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const send = () =>
    navigator
      .share({ title: 'Settle Link deal', text: `Here's the ${who.toLowerCase()}'s link for our deal. Pay only through PayPal on it, never Friends and Family.`, url })
      .catch(() => undefined);
  return (
    <div className="surface rounded-2xl p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="font-semibold text-pp-navy">{who}&apos;s link</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${copied ? 'border-pp-success/50 bg-[#ecfdf5] text-pp-success' : 'border-pp-border hover:border-pp-blue'}`}
          >
            <span key={copied ? 'c' : 'n'} className="appear inline-block">{copied ? '✓ Copied' : 'Copy link'}</span>
          </button>
          {canShare && (
            <button type="button" onClick={send} className="rounded-full border border-pp-border px-4 py-1.5 text-sm font-semibold hover:border-pp-blue">
              Send
            </button>
          )}
          <a href={url} target="_blank" rel="noreferrer" className="btn-navy rounded-full px-4 py-1.5 text-sm font-semibold" title="Locks this link to this device">
            Open on this device
          </a>
        </div>
      </div>
      <p className="mt-2 truncate font-mono text-xs text-pp-muted">{url.replace(/#k=.*/, '#k=…')}</p>
    </div>
  );
}
