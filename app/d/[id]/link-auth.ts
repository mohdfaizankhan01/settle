'use client';

// Claim on open (DECISIONS #22): the first device to open a deal link gets a secret, and the link
// only works there from then on. This keeps the secret in the browser and adds it to every request
// next to the link key. Stored per link (by a short prefix of the key, which never leaves the browser).

const slot = (key: string) => `settle-device:${key.slice(0, 16)}`;

export function deviceFor(key: string): string | null {
  try {
    return key ? localStorage.getItem(slot(key)) : null;
  } catch {
    return null;
  }
}

export function rememberDevice(key: string, secret: string) {
  try {
    localStorage.setItem(slot(key), secret);
  } catch {
    // Without storage this browser can't prove it opened the link; the next request says so.
  }
}

/** Headers for a request made with a deal link. */
export function keyHeaders(key: string): Record<string, string> {
  const device = deviceFor(key);
  return { 'x-settle-key': key, ...(device ? { 'x-settle-device': device } : {}) };
}
