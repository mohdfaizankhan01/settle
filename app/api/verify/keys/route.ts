import { publishedKeys } from '@/lib/settle/signing';

// The public keys a signed record can verify against (also at /.well-known/settle-link-key.json).
// Public keys only: nothing here can sign.
export function GET() {
  return Response.json(
    {
      note: 'Settle Link signs deal records with Ed25519. "live" is the key for real sandbox deals; "demo" is the public judge-mode key, which anyone can sign with.',
      keys: publishedKeys(),
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
