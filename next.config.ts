import type { NextConfig } from "next";

// Security headers on every page (security audit hardening): no page may be framed, so the confirm,
// approve and release buttons can't be clickjacked; no MIME sniffing. Link keys live in URL
// fragments, which browsers never send, so the default referrer policy is kept.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  // The public signing keys, at the conventional well-known path (/verify checks records against them).
  async rewrites() {
    return [{ source: '/.well-known/settle-link-key.json', destination: '/api/verify/keys' }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
