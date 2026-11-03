// Parses a dispute response choice from a request body. The browser picks the advice; the server
// builds everything else from the record.

import { DealError } from './deals';
import type { Choice } from './dispute-submit';

const ADVICE = new Set(['fight', 'refund', 'offer', 'send_tracking']);

export function choiceFrom(body: Record<string, unknown>): { disputeId: string; choice: Choice } {
  if (typeof body.disputeId !== 'string' || !/^PP-[A-Z0-9-]{3,40}$/.test(body.disputeId)) throw new DealError('disputeId is required');
  if (typeof body.advice !== 'string' || !ADVICE.has(body.advice)) throw new DealError('pick a response');
  return {
    disputeId: body.disputeId,
    choice: {
      advice: body.advice as Choice['advice'],
      ...(typeof body.offerAmount === 'string' ? { offerAmount: body.offerAmount.trim() } : {}),
      ...(body.withFiles === false ? { withFiles: false } : {}),
    },
  };
}
