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

/**
 * Decide whether a new deployment may rebuild the stored season's derived data.
 *
 * A deploy can change how scores are calculated, and the freeze rule above
 * means a concluded gameweek is never recomputed on its own — so without this
 * a scoring fix stays invisible until the next gameweek goes live, or until
 * someone remembers to press the admin rebuild button. Rebuilding on deploy
 * closes that gap, but only where recomputing is safe:
 *
 *   - A season that has played all its gameweeks is FINISHED. Its numbers
 *     settled real money and must never move again.
 *   - The FPL API reports FEWER completed gameweeks than we have stored, which
 *     means it has rolled over to a season after ours (it resets every July).
 *     Recomputing then would overwrite our season with a different one's data —
 *     the exact accident the freeze rule exists to prevent.
 *
 * Pure function (no FPL client / cache imports) so it's unit-testable.
 */
export function canRebuildOnDeploy(opts: {
  /** Completed gameweeks we already hold for the active season. */
  storedGameweeks: number;
  /** Completed gameweeks the FPL API reports right now. */
  liveCompletedGameweeks: number;
  /** Gameweeks in a full season, from the active season's config. */
  totalWeeks: number;
}): boolean {
  const { storedGameweeks, liveCompletedGameweeks, totalWeeks } = opts;
  if (storedGameweeks >= totalWeeks) return false;
  if (liveCompletedGameweeks < storedGameweeks) return false;
  return true;
}
