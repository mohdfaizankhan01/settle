// Picks the warning-check engine. Settle's own model is the default (DECISIONS #15: no TypeSafe
// credits). JEV_PROVIDER=typesafe switches to Jev when a key is available. Tests inject a mocked
// Jev through `ask`.

import { dealCheck, defaultAskJev, type AskJev, type DealCheckResult } from '../jev/deal-check';
import type { Redacted } from '../settle/redact';
import { localCheck } from './local-check';

export type CheckEngine = (redacted: Redacted, now?: () => Date) => Promise<DealCheckResult>;

export function engineFor(deps: { ask?: AskJev; engine?: CheckEngine }): CheckEngine {
  if (deps.engine) return deps.engine;
  if (deps.ask) return (r, now) => dealCheck(r, deps.ask, now);
  if (process.env.JEV_PROVIDER === 'typesafe') return (r, now) => dealCheck(r, defaultAskJev(), now);
  return localCheck;
}
