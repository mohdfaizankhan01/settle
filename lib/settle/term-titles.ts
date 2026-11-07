// Plain titles for the PayPal clause IDs every check cites, so the UI never shows a bare ID.
// Safe for the browser. tests/terms.test.ts keeps it in step with docs/protection-terms.md, and
// /terms shows each row in full with PayPal's own wording.

export const TERM_TITLES: Record<string, string> = {
  'SP-ADDR': 'Ship to the address on the transaction',
  'SP-BUYER-SHIP': "Don't use buyer-arranged shipping",
  'SP-PROOF-SHIP': 'Proof of shipment',
  'SP-PROOF-DELIV': 'Proof of delivery (required for Item Not Received)',
  'SP-CARRIER': 'Carrier must show "delivered"',
  'SP-RESPOND': 'Respond to PayPal on time',
  'SP-SHIP-TIME': 'Ship promptly',
  'SP-PHYSICAL': 'Physical, shippable goods',
  'SP-INPERSON': 'In-person handover excluded',
  'SP-SNAD': 'Not-as-described claims are excluded',
  'SP-FF': 'Friends and Family payments excluded',
  'SP-SINGLE': 'One payment, one account',
  'SP-NOT-PP': "Payments outside the buyer's PayPal account",
  'SP-RELEASE': "Don't ship after PayPal says not to",
  'SP-COUNTRY': "Seller's account country",
  'PP-FF': "Friends and Family isn't covered",
  'PP-SELLER-FF': 'Sellers must not ask for F&F',
  'PP-OFF-PAYPAL': "Must pay from the buyer's PayPal account",
  'PP-COVERS': "What's covered",
  'PP-COLLECT': "Collection in person isn't covered for Item Not Received",
  'PP-CONTACT': 'Contact the seller first',
  'PP-TIMEFRAME': 'When disputes can be opened',
  'PP-SNAD-DEF': 'What counts as Significantly Not as Described',
  'PP-EXCLUDED': 'Excluded purchases',
};

export const termTitle = (id: string) => TERM_TITLES[id] ?? id;

/** Where a clause is explained in full. */
export const termHref = (id: string) => `/terms#${id}`;
