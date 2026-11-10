// The toolbar popup: read the open chat (only now, because the seller clicked), show what was read,
// make the deal on the Settle Link server, and put the buyer's link in the reply box. The seller
// presses Send in the chat app: this never sends messages. Deals made here are listed on this
// device only (chrome.storage.local).

import { LIVE_SERVER, LOCAL_SERVER } from './lib/config.js';
import { insertReply, readChat } from './lib/readers.js';
import { dealLinks, parseSelection, replyText, sidesFromNames, swapSides, toChat, TranscriptError, whatsAppSender } from './lib/transcript.js';

const $ = (id) => document.getElementById(id);
const MAX_DEALS = 100;

let settings = { sellerName: '', country: 'UK', useLocal: false };
let tab = null;
let found = null; // { reader, title, messages: [{ side?, name?, text }], speakers? }
let made = null; // the deal just made

const server = () => (settings.useLocal ? LOCAL_SERVER : LIVE_SERVER);

async function load() {
  const stored = await chrome.storage.local.get(['settings', 'deals']);
  settings = { ...settings, ...(stored.settings ?? {}) };
  $('seller-name').value = settings.sellerName;
  $('country').value = settings.country;
  $('use-local').checked = settings.useLocal;
  $('privacy').href = `${server()}/privacy`;
  renderDeals(stored.deals ?? []);
  if (!settings.sellerName) openSettings(true);
  await read();
}

const saveSettings = () => chrome.storage.local.set({ settings });

function openSettings(open) {
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
}

// ---- Reading the chat ----

async function read() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readChat });
  } catch {
    return status("Settle Link can't read this page. Open the chat in WhatsApp Web, Messenger or Instagram, or select the messages, then click Settle Link again.");
  }
  if (!result || result.reader === 'none') return status(result?.why ?? 'No chat found on this page.');

  if (result.reader === 'selection') {
    const { speakers, messages } = parseSelection(result.text);
    if (speakers.length < 2) return status('The selected text needs two people, each line starting with their name ("Alex: hello"). WhatsApp Web copies messages that way.');
    found = { reader: 'selection', title: result.title, speakers, messages };
  } else {
    const messages = result.messages.map((m) => ({ side: m.side, name: m.pre ? whatsAppSender(m.pre) : '', text: m.text }));
    found = { reader: result.reader, title: result.title, messages, selected: result.selected };
    if (result.reader === 'whatsapp') {
      // Names come from WhatsApp itself: the buyer's from their messages, yours if not set yet.
      $('buyer-name').value = mostCommon(messages.filter((m) => m.side === 'them').map((m) => m.name));
      if (!settings.sellerName) $('seller-name').value = mostCommon(messages.filter((m) => m.side === 'me').map((m) => m.name));
    }
  }
  if (found.messages.length === 0) return status('No messages found. Scroll the chat so the deal messages are on screen, or select them.');
  showFound();
}

function mostCommon(names) {
  const counts = new Map();
  for (const n of names) if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function status(text) {
  $('status').textContent = text;
  $('status').hidden = false;
  $('found').hidden = true;
}

const READER_NAMES = { whatsapp: 'WhatsApp Web', layout: 'this chat', selection: 'your selection' };

function showFound() {
  $('status').hidden = true;
  $('found').hidden = false;
  const where = found.title ? ` (${found.title})` : '';
  const which = found.selected ? 'selected ' : '';
  $('summary').textContent = `Read ${found.messages.length} ${which}message${found.messages.length === 1 ? '' : 's'} from ${READER_NAMES[found.reader]}${where}.`;
  $('text-hint').hidden = found.reader !== 'selection';
  $('layout-hint').hidden = found.reader !== 'layout';
  const picking = found.reader === 'selection';
  $('pick-seller').hidden = !picking;
  $('buyer-row').hidden = picking;
  if (picking) renderSpeakers();
  renderPreview();
}

function renderSpeakers() {
  const box = $('speakers');
  box.replaceChildren();
  for (const name of found.speakers) {
    const label = document.createElement('label');
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'seller', value: name, checked: name === found.seller });
    input.addEventListener('change', () => {
      found.seller = name;
      renderPreview();
    });
    label.append(input, name);
    box.append(label);
  }
  if (!found.seller && found.speakers.includes(settings.sellerName)) {
    found.seller = settings.sellerName;
    renderSpeakers();
  }
}

/** Messages with sides, ready for toChat. Selected text gets its sides from the chosen seller. */
function sided() {
  if (found.reader !== 'selection') return found.messages;
  return found.seller ? sidesFromNames(found.messages, found.seller) : [];
}

function renderPreview() {
  const list = $('preview');
  list.replaceChildren();
  const messages = found.reader === 'selection' && !found.seller ? found.messages : sided();
  for (const m of messages.slice(-8)) {
    const li = document.createElement('li');
    li.className = m.side ?? '';
    const who = document.createElement('b');
    who.textContent = m.side === 'me' ? 'You' : m.side === 'them' ? 'Buyer' : m.name;
    li.append(who, m.text.length > 280 ? `${m.text.slice(0, 280)}…` : m.text);
    list.append(li);
  }
  list.scrollTop = list.scrollHeight;
  $('make').disabled = found.reader === 'selection' && !found.seller;
}

// ---- Making the deal ----

async function make() {
  const error = $('error');
  error.hidden = true;
  $('make').disabled = true;
  $('make').textContent = 'Reading the chat…';
  try {
    const names =
      found.reader === 'selection'
        ? { sellerName: found.seller, buyerName: found.speakers.find((s) => s !== found.seller) }
        : { sellerName: $('seller-name').value || settings.sellerName, buyerName: $('buyer-name').value };
    const { chat, sellerName } = toChat(sided(), names);
    if (found.reader !== 'selection' && !settings.sellerName) {
      settings.sellerName = sellerName;
      await saveSettings();
    }
    const res = await fetch(`${server()}/api/deals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat, sellerName, country: settings.country }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}. Try again in a minute.`);
    const links = dealLinks(server(), body);
    made = { id: body.dealId, title: found.title || hostOf(tab?.url), site: hostOf(tab?.url), at: new Date().toISOString(), ...links };
    const { deals = [] } = await chrome.storage.local.get('deals');
    const next = [made, ...deals].slice(0, MAX_DEALS);
    await chrome.storage.local.set({ deals: next });
    renderDeals(next);
    $('read').hidden = true;
    $('made').hidden = false;
  } catch (err) {
    error.textContent = err instanceof TranscriptError || err instanceof Error ? err.message : 'The deal could not be made.';
    if (err instanceof TypeError) error.textContent = "Couldn't reach Settle Link. Check your connection and try again; the server may take a minute to wake up.";
    error.hidden = false;
    $('make').disabled = false;
  } finally {
    $('make').textContent = 'Make the deal link';
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Into the open chat's reply box; copied if there's no reply box. The seller presses Send. */
async function putBuyerLink(deal, out) {
  const text = replyText(deal.buyer);
  let ok = false;
  // The buyer's link goes only into the chat site the deal was made on, never whatever tab is open.
  const sameSite = !!deal.site && hostOf(tab?.url) === deal.site;
  if (sameSite) {
    try {
      [{ result: { ok } }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: insertReply, args: [text] });
    } catch {
      ok = false;
    }
  }
  if (ok) {
    out.textContent = 'Added to the reply box. Check it, then press Send in the chat.';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    out.textContent = sameSite
      ? "Couldn't find the reply box, so it's copied. Paste it in the chat and press Send."
      : `This tab isn't ${deal.site || 'the chat this deal came from'}, so it's copied instead. Paste it in that chat and press Send.`;
  } catch {
    out.textContent = "Couldn't find the reply box or copy the link. Open your seller link to copy the buyer's link from there.";
  }
}

const openSeller = (deal) => chrome.tabs.create({ url: deal.seller });

// ---- Deal list ----

function renderDeals(deals) {
  const list = $('deals');
  list.replaceChildren();
  $('no-deals').hidden = deals.length > 0;
  for (const deal of deals) {
    const li = document.createElement('li');
    const who = Object.assign(document.createElement('span'), { className: 'who', textContent: deal.title || 'Deal' });
    const when = Object.assign(document.createElement('span'), {
      className: 'when',
      textContent: `${new Date(deal.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${deal.site ? ` · ${deal.site}` : ''}`,
    });
    const actions = Object.assign(document.createElement('span'), { className: 'actions' });
    const open = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Open my link' });
    open.addEventListener('click', () => openSeller(deal));
    const put = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Send buyer link again' });
    const out = Object.assign(document.createElement('span'), { className: 'hint' });
    put.addEventListener('click', () => putBuyerLink(deal, out));
    actions.append(open, put);
    li.append(who, actions, when, out);
    list.append(li);
  }
}

// ---- Wiring ----

$('settings-toggle').addEventListener('click', () => openSettings($('settings').hidden));
$('seller-name').addEventListener('change', (e) => {
  settings.sellerName = e.target.value.trim();
  void saveSettings();
});
$('country').addEventListener('change', (e) => {
  settings.country = e.target.value;
  void saveSettings();
});
$('use-local').addEventListener('change', async (e) => {
  // Chrome asks the seller before the extension may talk to localhost.
  const want = e.target.checked;
  const granted = want ? await chrome.permissions.request({ origins: ['http://localhost/*'] }) : true;
  settings.useLocal = want && granted;
  e.target.checked = settings.useLocal;
  $('privacy').href = `${server()}/privacy`;
  await saveSettings();
});
$('swap').addEventListener('click', () => {
  found.messages = swapSides(found.messages);
  renderPreview();
});
$('make').addEventListener('click', make);
$('put-buyer').addEventListener('click', () => putBuyerLink(made, $('put-result')));
$('open-seller').addEventListener('click', () => openSeller(made));

void load();
