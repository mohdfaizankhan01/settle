// Page frame for the deal pages. The top bar says what is real and what is simulated (CLAUDE.md).

import { TopBar } from './brand';

export const SANDBOX_NOTE = "No real money moves: payments use PayPal's sandbox, and the card is read from a redacted copy of the chat.";

export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full">
      <TopBar note={SANDBOX_NOTE} />
      <main className={`rise mx-auto w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} px-4 py-10 font-paypal text-pp-ink sm:py-12`}>{children}</main>
    </div>
  );
}
