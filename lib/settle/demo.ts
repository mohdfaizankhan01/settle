// Judge mode (PLAN M5 MUST). "Start judge mode" makes a private session with six demo deals, one
// per state, seeded through Settle's real code: the warning check runs on each chat, both sides
// confirm, payment is confirmed by the real webhook-plus-fresh-GET path, the ship gate, tracking
// and the dispute case file all run as they do live. Only PayPal is replaced, by a replay of the
// recorded sandbox run (demo-paypal.ts). Sessions only see their own deals; demo deals never
// reach PayPal and real deals are never touched.

import { randomBytes } from 'node:crypto';
import { cardHash } from './card';
import { answerQuestion, confirmCard, createDeal, addMessages, setPayee, type Deps } from './deals';
import { replayedEvent, replayPayPal, replaySdk, RECORDED } from './demo-paypal';
import { applyVerifiedEvent } from './payment';
import { addTracking, markDelivered, setLabelPostcode } from './shipping';
import { updateWithRetry, type DealStore, type DemoSession } from './store';

/** Judge sessions (and their demo deals) are deleted after this long. */
export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;
export const DEMO_SELLER = 'RRBVDNUTQMAXN';

export type Scenario = { id: string; title: string; side: 'buyer' | 'seller'; shows: string; chat: string; seller: string };

const BIKE = (extra = '') =>
  `Sam: hi, is the road bike still available?\nAlex: yes, Trek Domane AL 2, 54cm, barely used\nSam: would you do $320?\nAlex: ok $320, I can post it tracked with USPS\nSam: deal, I'll pay through your Settle link${extra}`;

export const SCENARIOS: Scenario[] = [
  {
    id: 'ff',
    title: 'Buyer warned about Friends and Family',
    side: 'buyer',
    shows: 'The seller asks to be paid as Friends and Family. The buyer is warned, with the PayPal terms it breaks, before paying.',
    seller: 'Casey',
    chat: "Jordan: hi, is the Nintendo Switch OLED still for sale?\nCasey: yes, $260 and I post it tracked\nJordan: great, I'll take it\nCasey: please send it as friends and family so there are no fees",
  },
  {
    id: 'fake-email',
    title: 'Seller warned about a fake payment email',
    side: 'seller',
    shows: "The buyer claims PayPal is holding the money until the seller ships. Paste the 'email' into 'Got a payment received message?' to see Settle answer from PayPal.",
    seller: 'Alex',
    chat: "Sam: is the Sony A7 III camera still available?\nAlex: yes, $450, posted tracked\nSam: deal\nSam: I've paid already, PayPal emailed you. The money is on hold until you send me the tracking number, so ship it first",
  },
  { id: 'awaiting', title: 'Confirmed, waiting for payment', side: 'buyer', shows: 'Both sides confirmed the same card; the buyer pays through PayPal checkout (judge mode never takes a payment).', seller: 'Alex', chat: BIKE() },
  { id: 'ready', title: 'Paid and ready to ship', side: 'seller', shows: 'Payment confirmed by a verified PayPal webhook plus a fresh read of the order; the label postcode matches; the ship check says ready.', seller: 'Alex', chat: BIKE() },
  { id: 'hold', title: 'Paid, then HOLD after an address change', side: 'seller', shows: "After payment the buyer asks to ship to a cousin. Settle's model flags it and the ship check turns to HOLD, naming the rule.", seller: 'Alex', chat: BIKE() },
  { id: 'dispute', title: 'A dispute with its evidence pack', side: 'seller', shows: 'The buyer opened an item-not-received dispute. The case file, the advice and the evidence pack come from the record; you approve the exact request.', seller: 'Alex', chat: BIKE() },
];

const sessionId = () => randomBytes(24).toString('base64url');

/**
 * When each step of a scenario happened, in hours before the session started. Demo dates are
 * back-dated so the seller timeline tells the story; every one is labelled as a demo date.
 */
const STEPS: Record<string, Partial<Record<'chat' | 'confirm' | 'paid' | 'label' | 'message' | 'tracking' | 'delivered' | 'dispute', number>>> = {
  ff: { chat: 2 },
  'fake-email': { chat: 3 },
  awaiting: { chat: 30, confirm: 26 },
  ready: { chat: 50, confirm: 48, paid: 47, label: 2 },
  hold: { chat: 74, confirm: 72, paid: 70, label: 20, message: 3 },
  dispute: { chat: 240, confirm: 238, paid: 236, label: 220, tracking: 216, delivered: 120, dispute: 24 },
};

async function seedOne(store: DealStore, session: string, s: Scenario, start: Date) {
  const steps = STEPS[s.id];
  let at = start;
  const step = (name: keyof (typeof STEPS)[string]) => void (at = new Date(start.getTime() - (steps[name] ?? 0) * 3600_000));
  const now = () => at;
  const deps: Deps = { store, now };
  step('chat');
  const { deal, keys } = await createDeal({ chat: s.chat, sellerName: s.seller, country: 'US' }, deps);
  await updateWithRetry(store, deal.id, (d) => ({ ...d, demo: { session, scenario: s.id, seededAt: start.toISOString() } }));
  if (s.id === 'ff' || s.id === 'fake-email') return { dealId: deal.id, keys };

  // Both answer the fee question, the seller is connected, both confirm the same card.
  step('confirm');
  await answerQuestion(deal.id, keys.seller, 'q_fee', 'seller', deps);
  await answerQuestion(deal.id, keys.buyer, 'q_fee', 'seller', deps);
  const connected = await setPayee(deal.id, DEMO_SELLER, deps);
  await confirmCard(deal.id, keys.seller, cardHash(connected.value), deps);
  await confirmCard(deal.id, keys.buyer, cardHash(connected.value), deps);
  if (s.id === 'awaiting') return { dealId: deal.id, keys };

  // Paid: the order as the recorded run created it, then the real confirmation path.
  step('paid');
  const pp = replayPayPal(store, deal.id);
  const { after } = await updateWithRetry(store, deal.id, (d) => ({ ...d, order: { id: RECORDED.order.id, cardHash: cardHash(d), createdAt: at.toISOString(), status: 'CAPTURE_REQUESTED', debugId: `rec-${RECORDED.order.debugId}` } }));
  await store.addReceipt({ dealId: deal.id, kind: 'order.created', at: at.toISOString(), data: { orderId: RECORDED.order.id, cardHash: cardHash(after), replayed: true, debugId: `rec-${RECORDED.order.debugId}` } });
  const pdeps = { store, paypal: pp, disputes: pp, now };
  await applyVerifiedEvent(replayedEvent(after, 'capture'), pdeps);
  step('label');
  await setLabelPostcode(deal.id, keys.seller, RECORDED.shipping.address.postal_code, pdeps);
  if (s.id === 'ready') return { dealId: deal.id, keys };
  if (s.id === 'hold') {
    step('message');
    await addMessages(deal.id, keys.seller, 'Sam: hey, change of plan, can you send it to my cousin in Miami instead? I will give you the address', deps);
    return { dealId: deal.id, keys };
  }

  // Dispute: shipped with tracking, delivered, then the buyer opened the recorded case.
  step('tracking');
  await addTracking(deal.id, keys.seller, { carrier: RECORDED.tracking.carrier, number: RECORDED.tracking.number }, { ...pdeps, sdk: replaySdk(store, deal.id) });
  step('delivered');
  await markDelivered(deal.id, keys.seller, at.toISOString().slice(0, 10), pdeps);
  step('dispute');
  const { after: paid } = await updateWithRetry(store, deal.id, (d) => ({ ...d, demo: { ...d.demo!, disputeOpenedAt: at.toISOString() } }));
  await applyVerifiedEvent(replayedEvent(paid, 'dispute'), pdeps);
  return { dealId: deal.id, keys };
}

/** Starts a fresh judge session: purges expired ones, then seeds one deal per scenario. */
export async function startDemo(store: DealStore, now: () => Date = () => new Date()): Promise<DemoSession> {
  await store.purgeDemo(new Date(now().getTime() - DEMO_TTL_MS).toISOString());
  const id = sessionId();
  const deals: DemoSession['deals'] = [];
  const start = now();
  for (const s of SCENARIOS) deals.push({ scenario: s.id, ...(await seedOne(store, id, s, start)) });
  const session = { id, createdAt: now().toISOString(), deals };
  await store.saveDemoSession(session);
  return session;
}

/** The session's deals with their links. Only the cookie's own session is ever read. */
export async function demoView(store: DealStore, id: string | undefined) {
  if (!id || !/^[A-Za-z0-9_-]{32}$/.test(id)) return undefined;
  const session = await store.getDemoSession(id);
  if (!session) return undefined;
  return {
    createdAt: session.createdAt,
    expiresAt: new Date(Date.parse(session.createdAt) + DEMO_TTL_MS).toISOString(),
    // Titles and descriptions only: the seeded chats stay on the server.
    deals: session.deals.map((d) => {
      const s = SCENARIOS.find((x) => x.id === d.scenario)!;
      return { ...d, title: s.title, side: s.side, shows: s.shows };
    }),
  };
}
