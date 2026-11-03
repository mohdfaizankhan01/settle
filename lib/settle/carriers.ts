// Carriers the tracking form offers; each ID is a member of the SDK's ShipmentCarrier enum.

import type { ShipmentCarrier } from 'paypal';
import type { Deal } from './types';

/** The carriers Settle offers per country (members of the SDK's ShipmentCarrier enum). */
export const CARRIERS: Record<Deal['country'], { id: ShipmentCarrier; label: string }[]> = {
  UK: [
    { id: 'ROYAL_MAIL', label: 'Royal Mail' },
    { id: 'PARCELFORCE', label: 'Parcelforce' },
    { id: 'DPD_UK', label: 'DPD' },
    { id: 'HERMESWORLD_UK', label: 'Evri' },
    { id: 'YODEL', label: 'Yodel' },
    { id: 'DHL_UK', label: 'DHL' },
    { id: 'OTHER', label: 'Other' },
  ],
  US: [
    { id: 'USPS', label: 'USPS' },
    { id: 'UPS', label: 'UPS' },
    { id: 'FEDEX', label: 'FedEx' },
    { id: 'DHL', label: 'DHL' },
    { id: 'OTHER', label: 'Other' },
  ],
};

/** The carrier's display name, or its ID if Settle doesn't list it. */
export const carrierLabel = (deal: Deal, id: string) => CARRIERS[deal.country].find((c) => c.id === id)?.label ?? id;
