import Link from 'next/link';

/** Settle Link's mark: two halves of a deal meeting in one locked card. Decorative; the name is text. */
export function BrandMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="settle-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1a7df0" />
          <stop offset="1" stopColor="#001c64" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#settle-mark)" />
      <path d="M10 12.5a4.5 4.5 0 0 1 4.5-4.5H18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M22 19.5a4.5 4.5 0 0 1-4.5 4.5H14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity=".72" />
      <circle cx="16" cy="16" r="2.2" fill="#fff" />
    </svg>
  );
}

/** The top bar on every page: the name, and what is real (CLAUDE.md: every screen says it). */
export function TopBar({ note, width = 'max-w-6xl' }: { note: string; width?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-pp-border/70 bg-pp-canvas/80 backdrop-blur-md supports-[backdrop-filter]:bg-pp-canvas/65">
      <div className={`mx-auto flex w-full ${width} items-center gap-4 px-4 py-2.5`}>
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg font-semibold tracking-tight text-pp-navy">
          <BrandMark />
          <span className="text-[15px]">Settle Link</span>
        </Link>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-pp-warning/30 bg-[#fff8eb] px-2.5 py-0.5 text-xs font-semibold text-pp-warning">
          <span className="h-1.5 w-1.5 rounded-full bg-pp-warning" aria-hidden="true" />
          PayPal sandbox
        </span>
      </div>
      <p className="border-t border-pp-border/50 px-4 py-1.5 text-center text-xs leading-relaxed text-pp-muted">{note}</p>
    </header>
  );
}
