import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Chat apps fetch link-preview images from this public address (SETTLE_PUBLIC_HOST on Render), never
// a guessed host. Unset in local development, where Next.js uses the local server.
const publicHost = process.env.SETTLE_PUBLIC_HOST?.replace(/\/$/, '');

export const metadata: Metadata = {
  ...(publicHost ? { metadataBase: new URL(publicHost) } : {}),
  title: {
    template: "%s · Settle Link",
    default: "Settle Link",
  },
  description: "One deal link both sides confirm, paid through PayPal checkout",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
