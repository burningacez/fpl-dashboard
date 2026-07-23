/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Decide whether a season still has "unfrozen" work worth recomputing.
 *
 * Scores are computed live only up to the point a gameweek is officially
 * concluded; after that they're static and never recomputed (except an admin
 * rebuild). So the periodic boot/daily refreshes should only run when there is:
 *   - a gameweek live right now (deadline passed, not yet finished), or
 *   - a completed gameweek still settling its bonus (not officially finished), or
 *   - a completed gameweek we haven't captured yet (not in processedGWs).
 *
 * When none of those hold the caller keeps the stored static data untouched.
 * Pure function (no FPL client / cache imports) so it's unit-testable.
 */
export function hasUnfrozenWork(opts: {
  events: any[];
  completedGWs: number[];
  processedGWs: Iterable<number>;
  now: Date;
}): boolean {
  const { events, completedGWs, processedGWs, now } = opts;

  const currentEvent = events.find((e: any) => e.is_current);
  const liveGW = !!currentEvent && !currentEvent.finished && new Date(currentEvent.deadline_time) <= now;

  const bonusPending = completedGWs.some((gw) => !events.find((e: any) => e.id === gw)?.finished);

  const processed = new Set<number>(processedGWs);
  const newlyCompleted = completedGWs.some((gw) => !processed.has(gw));

  return liveGW || bonusPending || newlyCompleted;
}
