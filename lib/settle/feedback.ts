// "Was this right?" on a warning (the M2 COULD, built with scam memory in M6). The side that saw a
// warning says scam, not a scam, or unsure. Every answer is kept as a receipt (signal, answer,
// model probability, time; never chat text), so the warning check can be measured on real use.
// "Scam" also reports the other side to scam memory, only for a message the other side wrote.

import { DealError, actingRole, type Deps } from './deals';
import { reportOtherSide } from './memory';
import { shownTo } from './signals';

export const VERDICTS = ['scam', 'not_scam', 'unsure'] as const;
export type Verdict = (typeof VERDICTS)[number];

export async function answerWarning(dealId: string, key: string | null, signalId: string, verdict: string, deps: Deps) {
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new DealError('unknown answer');
  const stored = await deps.store.getDeal(dealId);
  if (!stored) throw new DealError('no such deal', 404);
  const deal = stored.value;
  const role = actingRole(deal, key);
  if (!role) throw new DealError('this link is not valid for the deal', 403);
  const warnings = deal.warnings.filter((w) => w.signalId === signalId && shownTo(w.audience, role));
  if (warnings.length === 0) throw new DealError('there is no such warning for you on this deal', 404);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const fromOther = warnings.some((w) => w.messageId && deal.messages.find((m) => m.id === w.messageId)?.role !== role);
  await deps.store.addReceipt({
    dealId,
    kind: 'warning.answered',
    at,
    data: { by: role, signal: signalId, verdict, probability: warnings.find((w) => w.probability !== undefined)?.probability ?? null },
  });
  // Only the other side's own message can be reported: you can't report yourself.
  const reported = verdict === 'scam' && fromOther ? await reportOtherSide(deal, role, 'marked_scam', { store: deps.store, now: deps.now }, [signalId]) : 0;
  return { verdict, reported: reported > 0 };
}
