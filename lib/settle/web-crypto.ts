// The browser side of the shared check (verify-core.ts): WebCrypto for SHA-256 and Ed25519.
// Also runs in Node (globalThis.crypto), which is how the tests compare it with the Node side.

import { base64urlToBytes, type VerifyCrypto } from './verify-core';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const webCrypto: VerifyCrypto = {
  sha256Hex: async (bytes) => hex(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)),
  async ed25519Verify(publicKey, message, signature) {
    const key = await globalThis.crypto.subtle.importKey('raw', base64urlToBytes(publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, message as BufferSource);
  },
};
