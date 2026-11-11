'use client';

import { useState } from 'react';
import { checkPdfWith, parseKeys, verifyRecordWith, type Check, type PublicKeyInfo, type RecordCheck, type SignedRecord } from '@/lib/settle/verify-core';
import { webCrypto } from '@/lib/settle/web-crypto';

const MARK = { pass: '✓', fail: '✕', info: 'ℹ' } as const;
const TONE = { pass: 'text-pp-success', fail: 'text-pp-danger', info: 'text-pp-muted' } as const;
/** Largest file the page reads, so a huge drop can't freeze the tab. */
const MAX_BYTES = 8 * 1024 * 1024;

type Result = { record: SignedRecord | null; check: RecordCheck; pdf: Check | null; keysFrom: string };

export function Verifier() {
  const [recordFile, setRecordFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [ownKeys, setOwnKeys] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!recordFile) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (recordFile.size > MAX_BYTES || (pdfFile && pdfFile.size > MAX_BYTES)) throw new Error('That file is too large for this page (8 MB at most).');
      let keys: PublicKeyInfo[] | undefined;
      let keysFrom = "this server's /.well-known/settle-link-key.json";
      if (ownKeys.trim()) {
        keys = parseKeys(ownKeys);
        if (!keys) throw new Error('The key list you pasted is not valid. Paste the JSON from /.well-known/settle-link-key.json, or one key object.');
        keysFrom = 'the key list you pasted';
      } else {
        const res = await fetch('/.well-known/settle-link-key.json', { cache: 'no-store' });
        keys = res.ok ? parseKeys(JSON.stringify(await res.json())) : undefined;
        if (!keys) throw new Error("The public key list could not be loaded from this server. Paste a key list below, or check the file offline with 'npm run verify:record'.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await recordFile.text());
      } catch {
        parsed = undefined;
      }
      const check = await verifyRecordWith(parsed, keys, webCrypto);
      const record = check.checks.find((c) => c.id === 'format')?.status === 'pass' ? (parsed as SignedRecord) : null;
      const pdf = record && pdfFile ? await checkPdfWith(record, new Uint8Array(await pdfFile.arrayBuffer()), webCrypto) : null;
      setResult({ record, check, pdf, keysFrom });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The check could not run.');
    } finally {
      setBusy(false);
    }
  };

  const verdict = result ? (result.check.ok && result.pdf?.status === 'fail' ? 'failed' : result.check.verdict) : null;
  const rows = result ? [...result.check.checks.filter((c) => c.id !== 'pdf' || !result.pdf), ...(result.pdf ? [result.pdf] : [])] : [];
  const HEADLINE = {
    verified: { text: 'This record checks out: unchanged since it was signed', tone: 'text-pp-success' },
    demo: { text: 'Demo record: its format and chain check out, but this shows nothing about a real deal', tone: 'text-pp-warning' },
    failed: { text: 'This record does not check out', tone: 'text-pp-danger' },
  } as const;

  return (
    <section className="mt-8 surface rounded-2xl p-5" aria-label="Check a record">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-semibold">Signed record (.json)</span>
          <input type="file" accept="application/json,.json" onChange={(e) => { setRecordFile(e.target.files?.[0] ?? null); setResult(null); }} className="mt-1 block w-full text-sm" />
        </label>
        <label className="block text-sm">
          <span className="font-semibold">Evidence PDF <span className="font-normal text-pp-muted">(optional)</span></span>
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => { setPdfFile(e.target.files?.[0] ?? null); setResult(null); }} className="mt-1 block w-full text-sm" />
        </label>
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-pp-muted">Use my own key list instead of this server&apos;s (optional)</summary>
        <textarea value={ownKeys} onChange={(e) => setOwnKeys(e.target.value)} rows={5} spellCheck={false} placeholder='{"keys":[{"alg":"Ed25519","keyId":"…","publicKey":"…","kind":"live"}]}' className="mt-2 w-full rounded-lg border border-pp-border bg-pp-surface p-2 font-mono text-xs" />
      </details>
      <button type="button" onClick={run} disabled={!recordFile || busy} aria-busy={busy} className="btn-primary mt-4 rounded-full px-5 py-2 font-semibold disabled:opacity-40">
        {busy ? 'Checking…' : 'Check the record'}
      </button>
      {error && <p role="alert" className="mt-3 text-sm text-pp-danger">{error}</p>}

      {result && (
        <div className="mt-6" role="status" aria-live="polite">
          <h2 className={`text-xl font-semibold ${HEADLINE[verdict!].tone}`}>{HEADLINE[verdict!].text}</h2>
          <p className="mt-1 text-sm text-pp-muted">
            Checked against {result.keysFrom}. {verdict === 'demo' ? 'It is signed with the public demo key, which anyone can use. ' : ''}This doesn&apos;t show the events happened; PayPal decides that.
          </p>
          <ul className="mt-3 divide-y divide-pp-gridline rounded-xl border border-pp-border text-sm">
            {rows.map((c) => (
              <li key={c.id} className="flex gap-3 px-4 py-2">
                <span className={`w-4 shrink-0 font-semibold ${TONE[c.status]}`} aria-label={c.status}>{MARK[c.status]}</span>
                <span>{c.detail}</span>
              </li>
            ))}
          </ul>
          {result.record && (
            <p className="mt-4 text-xs font-semibold text-pp-muted">{verdict === 'failed' ? 'What the file says (not to be trusted: the check failed)' : 'What the file says'}</p>
          )}
          {result.record && (
            <dl className="mt-1 grid gap-x-4 gap-y-1 text-xs text-pp-muted sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt>Deal</dt><dd className="font-mono">{result.record.body.dealId}</dd>
              <dt>Signed at</dt><dd>{result.record.body.signedAt}</dd>
              <dt>Key ID</dt><dd className="font-mono">{result.record.signature.keyId}{result.check.kind ? ` (${result.check.kind})` : ''}</dd>
              <dt>Receipts</dt><dd>{result.record.body.receiptCount}</dd>
              <dt>Chain head</dt><dd className="break-all font-mono">{result.record.body.chainHead}</dd>
              <dt>Card hash</dt><dd className="break-all font-mono">{result.record.body.cardHash}</dd>
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
