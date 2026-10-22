// Page frame for the deal pages. The banner says what is real and what is simulated (CLAUDE.md).

export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full">
      <div className="bg-pp-navy px-4 py-2 text-center text-sm text-white">Sandbox demo: no real money moves. PayPal is the sandbox; the warning check is Jev reading a redacted copy of the chat.</div>
      <main className={`mx-auto w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} px-4 py-10 font-paypal text-pp-ink sm:py-12`}>{children}</main>
    </div>
  );
}
