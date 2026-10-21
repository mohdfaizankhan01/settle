import { NextResponse } from 'next/server';
import { devPagesEnabled } from '@/lib/settle/dev-pages';

// Answers 404 for the local-only data pages and AI proxy before anything renders, so production
// gets a real 404 status (the pages stream behind loading.tsx and can't change status later). The
// pages and route also check devPagesEnabled() themselves; this is the first layer, not the only one.
export function proxy() {
  if (devPagesEnabled()) return NextResponse.next();
  return new NextResponse('Not found', { status: 404 });
}

export const config = {
  matcher: ['/dashboard/:path*', '/products', '/plans', '/invoices', '/transactions', '/balances', '/api/ai/:path*'],
};
