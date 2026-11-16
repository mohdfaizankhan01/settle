'use client';

import { useEffect, useRef, useState } from 'react';
import { keyHeaders } from './link-auth';

// Live updates for the deal page (Part B). Opens the "this deal changed" stream and calls
// `onChange` for each signal; the page then reads the deal again through the normal route, so the
// stream never carries deal data. fetch, not EventSource: the stream needs the link headers.
// Returns whether the stream is open right now. Reconnects with backoff, pauses while the tab is
// hidden, and gives up only when the link is not valid for this deal (403, 404).

const MAX_DELAY_MS = 30_000;

export function useLiveUpdates(dealId: string, getKey: () => string | null, onChange: () => void): boolean {
  const [live, setLive] = useState(false);
  const change = useRef(onChange);
  const key = useRef(getKey);
  useEffect(() => {
    change.current = onChange;
    key.current = getKey;
  });

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(connect, Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt++) + Math.random() * 500);
    };

    async function connect() {
      timer = undefined;
      const k = key.current();
      if (stopped || !k) return schedule();
      if (document.visibilityState !== 'visible') return; // reconnects when the tab is shown again
      ctl = new AbortController();
      try {
        const res = await fetch(`/api/deals/${dealId}/watch`, { headers: keyHeaders(k), cache: 'no-store', signal: ctl.signal });
        if (res.status === 403 || res.status === 404) return; // not this link's deal: nothing to retry
        if (!res.ok || !res.body) throw new Error('no stream');
        attempt = 0;
        setLive(true);
        const reader = res.body.getReader();
        const text = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += text.decode(value, { stream: true });
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.includes('"changed":true')) change.current();
          }
        }
      } catch {
        // Aborted, offline or refused: the page keeps polling, and this tries again below.
      }
      setLive(false);
      if (!stopped && document.visibilityState === 'visible') schedule();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer) clearTimeout(timer);
        timer = undefined;
        ctl?.abort();
      } else if (!timer) {
        attempt = 0;
        change.current(); // a signal may have been missed while hidden
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearTimeout(timer);
      ctl?.abort();
    };
  }, [dealId]);

  return live;
}
