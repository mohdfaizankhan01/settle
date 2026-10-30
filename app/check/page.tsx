'use client';

import { useMemo, useState } from 'react';
import { Shell } from '@/app/components/shell';
import { findSpeakers } from '@/lib/settle/chat';

type Created = { dealId: string; keys: { seller: string; buyer: string } };

export default function CheckPage() {
  const [chat, setChat] = useState('');
  const [seller, setSeller] = useState('');
  const [country, setCountry] = useState<'US' | 'UK'>('UK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

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
        <h1 className="text-[28px] font-semibold text-pp-navy">Your deal card is ready</h1>
        <p className="mt-2 max-w-prose text-pp-muted">
          Each person opens their own link. Keep your link private: it lets whoever has it confirm the card for you.
        </p>
        <div className="mt-8 space-y-4">
          <LinkRow who="Seller" url={`${base}#k=${created.keys.seller}`} />
          <LinkRow who="Buyer" url={`${base}#k=${created.keys.buyer}`} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-[28px] font-semibold text-pp-navy">Nobody has to go first</h1>
      <p className="mt-2 max-w-prose text-pp-muted">
        Paste the chat where you agreed the deal, as the buyer or the seller. Settle turns it into one link you both confirm. The buyer
        pays through PayPal checkout, the seller ships once PayPal confirms the payment, and PayPal&apos;s protections stay in place
        for both of you.
      </p>
      <form onSubmit={submit} className="mt-8 space-y-6">
        <label className="block">
          <span className="font-semibold">The chat</span>
          <span className="mt-1 block text-sm text-pp-muted">One message per line, as “Name: message”. WhatsApp exports work as they are.</span>
          <textarea
            value={chat}
            onChange={(e) => setChat(e.target.value)}
            rows={12}
            required
            className="mt-2 w-full rounded-md border border-pp-border bg-pp-surface p-3 text-[15px] leading-relaxed focus:outline-2 focus:outline-pp-blue"
            placeholder={'Sam: is the bike still for sale?\nAlex: yes, £120 and I can post it tracked\nSam: deal'}
          />
        </label>

        {speakers.length === 2 && (
          <fieldset>
            <legend className="font-semibold">Who is selling?</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {speakers.map((name) => (
                <label key={name} className="flex cursor-pointer items-center gap-2 rounded-md border border-pp-border bg-pp-surface px-4 py-2 has-[:checked]:border-pp-blue has-[:checked]:bg-pp-highlight">
                  <input type="radio" name="seller" value={name} checked={sellerName === name} onChange={() => setSeller(name)} />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {chat.trim() && speakers.length < 2 && <p className="text-sm text-pp-warning">Settle needs two people in the chat, each line starting with their name.</p>}

        <label className="block">
          <span className="font-semibold">Seller&apos;s PayPal country</span>
          <select value={country} onChange={(e) => setCountry(e.target.value as 'US' | 'UK')} className="mt-2 block rounded-md border border-pp-border bg-pp-surface px-3 py-2">
            <option value="UK">United Kingdom (GBP)</option>
            <option value="US">United States (USD)</option>
          </select>
        </label>

        {error && <p role="alert" className="text-pp-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || !sellerName}
          className="rounded-full bg-pp-blue px-6 py-3 font-semibold text-white hover:bg-pp-blue-dark disabled:opacity-40"
        >
          {busy ? 'Reading the chat…' : 'Make the deal link'}
        </button>
      </form>
    </Shell>
  );
}

function LinkRow({ who, url }: { who: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-pp-border bg-pp-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="font-semibold">{who}&apos;s link</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}
            className="rounded-full border border-pp-border px-4 py-1.5 text-sm font-semibold hover:border-pp-blue"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={url} target="_blank" rel="noreferrer" className="rounded-full bg-pp-navy px-4 py-1.5 text-sm font-semibold text-white">
            Open as {who.toLowerCase()}
          </a>
        </div>
      </div>
      <p className="mt-2 truncate font-mono text-xs text-pp-muted">{url.replace(/#k=.*/, '#k=…')}</p>
    </div>
  );
}
