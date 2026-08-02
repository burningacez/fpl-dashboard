/**
 * Season phase, decided from the FPL calendar.
 *
 * Never infer the phase from a failed fetch — a transient FPL outage in
 * November must not look like pre-season (see README, "Pre-season is decided
 * from the calendar"). Pure function so it's unit-testable and safe to import
 * from both client and server code.
 */

export interface SeasonPhaseEvent {
  finished?: boolean;
  is_current?: boolean;
}

/**
 * Pre-season: no gameweek has finished and none is current, i.e. the GW1
 * deadline has not passed. That is exactly the window in which entrants can
 * still join the mini-league — once it closes the roster is fixed for the
 * season.
 *
 * An empty/absent event list means we don't know (a failed or half-built
 * bootstrap), which is deliberately NOT pre-season: callers fall back to their
 * in-season behaviour rather than acting on a guess.
 */
export function isPreSeason(events: SeasonPhaseEvent[] | null | undefined): boolean {
  if (!events || events.length === 0) return false;
  return !events.some((e) => e.finished || e.is_current);
}
