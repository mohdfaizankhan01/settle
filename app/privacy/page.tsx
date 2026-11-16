import Link from 'next/link';
import { TopBar } from '@/app/components/brand';

// /privacy: what Settle Link and its Chrome extension read, send and keep. Linked from the
// extension popup and the Chrome Web Store listing (extension/STORE.md). Keep it in step with the
// code: lib/settle/deals.ts (what a deal stores), lib/settle/redact.ts, extension/lib/readers.js.

export const metadata = { title: 'Privacy: Settle Link' };

export default function Page() {
  return (
    <div className="min-h-full">
      <TopBar note={"Settle Link is a hackathon project. Payments run in PayPal's sandbox, so no real money moves."} />
      <main className="mx-auto w-full max-w-3xl px-4 py-10 font-paypal text-pp-ink sm:py-12">
        <p className="text-sm">
          <Link href="/" className="text-pp-blue underline underline-offset-2">
            Settle Link home
          </Link>
        </p>
        <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Privacy</h1>
        <p className="mt-2 text-pp-muted">Updated 10 November 2026. This covers the Settle Link website and the Settle Link extension for Chrome.</p>

        <Section title="What the Chrome extension reads">
          <p>
            Nothing, until you click the Settle Link button. Then it reads the chat open in that one tab: the messages already loaded on the page, who sent each one, and the chat&apos;s name. If you selected text first, it reads only your selection. It doesn&apos;t scroll, open other chats, read other tabs or run in the background.
          </p>
          <p>
            You see what it read before anything is sent. When you choose &ldquo;Put the buyer&apos;s link in the reply box&rdquo;, it types that one line into the chat&apos;s reply box. It never presses Send and never sends messages for you.
          </p>
        </Section>

        <Section title="What is sent to Settle Link">
          <p>
            When you make a deal link (on the website or from the extension), the chat messages, the seller&apos;s name and the seller&apos;s PayPal country are sent to the Settle Link server. The server keeps them as the deal record, so the buyer and seller see the same deal card with the messages it came from. Each step of the deal (confirmations, payment checks, shipping checks, disputes) adds a receipt to that record.
          </p>
          <p>
            Before any AI sees the chat, names, emails, phone numbers, street addresses, and card and bank numbers are removed, and prices, dates, links and postcodes become placeholders. The scam warning check runs on Settle Link&apos;s own server.
          </p>
          <p>
            To read the deal card, a redacted copy of the chat (the text after those removals, with the placeholders) is sent to Groq&apos;s API, where an AI model points at which placeholder is the price, which message names the item and what the seller said about it. It never sees the real prices, dates, links, names or contact details. Groq&apos;s own page says it doesn&apos;t keep inference data by default, but may keep logs for up to 30 days for reliability and abuse monitoring:{' '}
            <a className="text-pp-blue underline underline-offset-2" href="https://console.groq.com/docs/your-data" rel="noreferrer" target="_blank">
              Groq: your data
            </a>
            . A server running Settle Link can turn this off with SETTLE_READER=off; the card is then read by Settle Link&apos;s own code only.
          </p>
          <p>
            If the seller chooses to read the label postcode from a photo, the photo is <strong>not</strong> redacted: it shows the recipient&apos;s name and address. The seller&apos;s browser shrinks it first, which also drops the location and camera details the file carried, and then sends it once to Groq&apos;s API, where a vision model reads the recipient&apos;s postcode. Settle Link does not store the photo; the deal record keeps only whether a postcode was read, never the photo, the postcode or the address. The seller can crop the photo to the postcode before choosing it, or type the postcode instead. Judge mode never sends a photo anywhere. A server running Settle Link can turn photo reading off with SETTLE_LABEL_PHOTO=off.
          </p>
          <p>
            When the buyer pays, PayPal receives the order: the item, the price and the seller&apos;s PayPal account. Payment, buyer details and disputes are handled by PayPal under PayPal&apos;s own privacy statement.
          </p>
        </Section>

        <Section title="What stays on your device">
          <p>
            The extension keeps your name, your PayPal country and the deals you made in this browser (the chat&apos;s name, the date and the two deal links) in Chrome&apos;s storage on this device. It&apos;s never synced or sent anywhere else. Removing the extension deletes it.
          </p>
          <p>Each deal link remembers the first device that opened it, so the link only works there.</p>
        </Section>

        <Section title="What we don't do">
          <ul className="list-disc space-y-1 pl-5">
            <li>No selling or renting of data, no advertising, no tracking or analytics.</li>
            <li>No use of chat data to decide credit or lending.</li>
            <li>No access to chats you didn&apos;t click on.</li>
          </ul>
        </Section>

        <Section title="Contact and deletion">
          <p>
            To ask for a deal record to be deleted, open an issue at{' '}
            <a className="text-pp-blue underline underline-offset-2" href="https://github.com/mohdfaizankhan01/settle/issues" rel="noreferrer" target="_blank">
              github.com/mohdfaizankhan01/settle
            </a>{' '}
            with the deal&apos;s ID (the part of the link after /d/, never the part after #).
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 space-y-3 leading-relaxed">
      <h2 className="text-lg font-semibold text-pp-navy">{title}</h2>
      {children}
    </section>
  );
}
