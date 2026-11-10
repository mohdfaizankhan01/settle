# Settle Link for Chrome: store listing

Text and answers for the Chrome Web Store developer dashboard. `npm run ext:pack` makes the zip to upload (`dist/settle-link-chrome-<version>.zip`).

## Listing

**Name:** Settle Link

**Summary (132 characters max):**
Turn a chat deal with a stranger into one link: the buyer pays through PayPal checkout, never Friends and Family.

**Category:** Shopping (or Productivity)

**Description:**

Selling to strangers on WhatsApp, Messenger or Instagram? Settle Link turns the chat where you agreed the deal into one deal link.

1. Open the chat in your browser and click Settle Link.
2. Check the messages it read, then make the deal link. Settle Link reads the item, price and delivery from the chat and warns about common scams, like being asked to pay by Friends and Family or to ship to a different address.
3. Settle Link puts the buyer's link in the reply box. You press Send.

The buyer confirms the same deal card and pays through PayPal checkout, straight to your own PayPal account. Settle Link never holds money, and it never sends messages for you.

- Reads a chat only when you click the button, and only the chat that's open.
- Works with WhatsApp Web, Messenger, Facebook Marketplace and Instagram in the browser. On any other site, select the messages and click.
- Lists the deals you made in this browser, so you can reopen your link or send the buyer's link again.

Settle Link is a hackathon project. Payments run in PayPal's sandbox, so no real money moves yet.

**Screenshots (1280×800):** the popup over a WhatsApp Web chat; the deal card on the seller page; the buyer link in the reply box.

## Privacy practices tab

**Single purpose:** Make a Settle Link deal link from the chat open in the current tab, and help the seller send it to the buyer.

**Permission justifications:**

- `activeTab`: when the seller clicks the toolbar button, read the chat open in that one tab and put the buyer's link in its reply box. Nothing is read without the click, and no other tab is touched.
- `scripting`: runs the chat reader and the reply-box helper in that tab, only after the click (activeTab). The extension has no content scripts that run on their own.
- `storage`: keeps the seller's name, PayPal country and the list of deals made in this browser, on this device only.
- host permission `https://settle-ulya.onrender.com/*`: sends the chat to the Settle Link server to make the deal (the same request the website's "make a deal link" form makes).
- Optional host permission `http://localhost/*`: only if a developer turns on "Use a local server" in settings; Chrome asks first.

**Remote code:** No. All code is in the package.

**Data usage (what's collected):** Personal communications (the chat messages the seller chooses to make a deal from), sent to the Settle Link server to make the deal. The server sends a redacted copy (names, contact details and addresses removed; prices, dates and links as placeholders) to Groq's API to read the deal card. Not sold, not used for advertising or credit, not shared except with PayPal for the payment itself. Privacy policy: https://settle-ulya.onrender.com/privacy

## Before each upload

- `npm test` passes, and `npx playwright test e2e/extension-readers.spec.ts` passes.
- Bump `version` in `manifest.json`.
- Try it by hand on WhatsApp Web and Messenger: a deal, the buyer link in the reply box, the deal list.
