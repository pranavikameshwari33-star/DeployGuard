/**
 * Stage 2: retry delay for a failed job attempt. Pure, so it is unit-tested.
 *
 * Exponential (base 15 s, doubling per attempt) capped at 1 hour, with "full
 * jitter" between 50% and 100% of that, so many jobs failing together (e.g.
 * during a Hindsight outage) do not all retry at the same moment.
 */
export const BACKOFF = { baseSeconds: 15, maxSeconds: 3600 };

export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.maxSeconds, BACKOFF.baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(exp * (0.5 + 0.5 * random())));
}
