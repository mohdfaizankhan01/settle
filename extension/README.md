# Settle Link for Chrome

Make a Settle Link deal straight from the chat, instead of copying and pasting it into the website.

1. Open the chat in WhatsApp Web, Messenger, Facebook Marketplace or Instagram (or select the messages on any site).
2. Click **Settle Link** in the toolbar. It reads only that chat, only now, and shows you what it read: your messages as **You**, the buyer's as **Buyer** (swap them if they're the wrong way round).
3. **Make the deal link.** The chat goes to the Settle Link server, the same as pasting it on the website: redaction, the scam warning check and receipts all run there.
4. **Put the buyer's link in the reply box**, then press Send yourself. Settle Link never sends messages.
5. **Open my seller link** to confirm the deal card. Your deals stay listed in the popup on this browser.

Payments run in PayPal's sandbox: deals are real Settle Link deals, but no real money moves.

## Run it from this folder

`chrome://extensions` → turn on Developer mode → **Load unpacked** → choose this `extension/` folder. No build step and no npm packages: Chrome loads these files as they are.

For a local server, open the popup's Settings and tick "Use a local server" (it uses `http://localhost:3000`; Chrome asks first).

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Manifest V3. Permissions: `activeTab`, `scripting`, `storage`, and the Settle Link server. No content scripts. |
| `popup.html`, `popup.js`, `popup.css` | The toolbar popup. |
| `lib/readers.js` | Runs in the chat tab after the click: reads the chat, and puts the reply in the reply box. |
| `lib/transcript.js` | Turns what was read into the "Name: text" chat the server takes. |
| `STORE.md` | Chrome Web Store listing text and permission reasons. |

## Tests

- `npm test` (from the repo root) includes `tests/extension.test.ts`: the chat the server reads back, limits, names, the reply line, the manifest.
- `npx playwright test e2e/extension-readers.spec.ts` runs the readers in Chromium against sample pages in `e2e/fixtures/`. These are modelled on each site's markup, not saved real pages, so also try it by hand on the real sites before each release.

## Publish

`npm run ext:pack` → `dist/settle-link-chrome-<version>.zip`, then upload it in the Chrome Web Store developer dashboard with the text in `STORE.md`. The privacy policy is at https://settle-ulya.onrender.com/privacy.
