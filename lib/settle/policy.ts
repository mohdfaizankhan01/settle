// Every threshold and limit in one place, so eval runs can tune them without touching logic.
// Changing a Jev threshold means re-running `npm run jev:eval` (CLAUDE.md).

/** A pasted chat larger than this is refused rather than truncated (a cut chat could hide a warning). */
export const MAX_CHAT_CHARS = 20_000;
export const MAX_MESSAGES = 200;

/** A term the model picks with confidence below this becomes a blocking question (PLAN M2 SHOULD). */
export const TERM_MIN_CONFIDENCE = 0.6;

/** Default probability at which a warning signal is shown. Per-signal overrides live in SIGNAL_THRESHOLDS. */
export const DEFAULT_SIGNAL_THRESHOLD = 0.5;
export const SIGNAL_THRESHOLDS: Partial<Record<string, number>> = {};

export const signalThreshold = (signalId: string) => SIGNAL_THRESHOLDS[signalId] ?? DEFAULT_SIGNAL_THRESHOLD;
