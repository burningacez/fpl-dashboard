/**
 * Pure fixture-difficulty (FDR) helpers for the planner's fixture matrix.
 *
 * NO 'server-only', NO DOM, NO IO — imported by the client-side planner UI and
 * the vitest suite. A gameweek is not always one-game-per-team: cup runs and
 * rescheduling produce double gameweeks (a team plays twice) and blank
 * gameweeks (a team doesn't play while others do). These helpers turn a team's
 * per-gameweek fixtures into a ranking that accounts for both.
 */

/** A single fixture as the matrix needs it. `home` drives the H/A casing. */
export interface FdrFixture {
  short: string;
  home: boolean;
  fdr: number; // FPL difficulty 1 (easiest) .. 5 (hardest)
}

// Attractiveness is expressed on the FDR scale (lower = better) so it stays
// readable next to the pills. Average difficulty is the base; a double
// gameweek improves the score (a second fixture is a big plus) and a blank
// worsens it (a hole you must cover). One double ≈ 0.3 of a difficulty grade —
// enough to lift a doubler over a similar single-game run without swamping the
// difficulty signal itself.
export const DGW_BONUS = 0.3;
export const BGW_PENALTY = 0.3;

export interface TeamFdrStats {
  /** Mean difficulty across every fixture in range, or null if none played. */
  avg: number | null;
  /** Total fixtures played across the range (a double counts as two). */
  games: number;
  /** Gameweeks in range where the team plays twice. */
  dgwCount: number;
  /** Gameweeks in range where the team blanks while others play. */
  bgwCount: number;
  /** Attractiveness on the FDR scale (lower = better); null if no games. */
  score: number | null;
}

/**
 * Reduce a team's per-gameweek fixtures to sortable stats.
 *
 * @param cells    One entry per gameweek in range; each is that team's
 *                 fixtures that week (length 0 = blank, 2+ = double).
 * @param gwActive Parallel flags marking gameweeks that are actually played by
 *                 someone — so an empty cell only counts as a blank when the
 *                 gameweek is live, not when the whole round is unscheduled.
 */
export function teamFdrStats(cells: FdrFixture[][], gwActive: boolean[]): TeamFdrStats {
  const played = cells.flat();
  const games = played.length;
  const avg = games ? played.reduce((sum, f) => sum + f.fdr, 0) / games : null;
  const dgwCount = cells.filter((c) => c.length >= 2).length;
  const bgwCount = cells.filter((c, i) => c.length === 0 && gwActive[i]).length;
  const score = avg == null ? null : avg - DGW_BONUS * dgwCount + BGW_PENALTY * bgwCount;
  return { avg, games, dgwCount, bgwCount, score };
}

/** Sort comparator for attractiveness — lower score first; no-game teams last. */
export function compareByAttractiveness(a: { score: number | null }, b: { score: number | null }): number {
  return (a.score ?? Infinity) - (b.score ?? Infinity);
}

export interface GameweekKind {
  /** Some team plays twice this gameweek. */
  dgw: boolean;
  /** Some teams play and others blank — a real blank gameweek. */
  bgw: boolean;
  /** At least one team plays (the gameweek is live, not just unscheduled). */
  active: boolean;
}

/**
 * Classify a gameweek column from every team's fixture count that week.
 * A blank only counts when the round is live (some team plays); a whole empty
 * round is "unscheduled", not a blank.
 */
export function classifyGameweek(fixtureCounts: number[]): GameweekKind {
  let active = false;
  let dgw = false;
  let anyBlank = false;
  for (const n of fixtureCounts) {
    if (n >= 1) active = true;
    if (n >= 2) dgw = true;
    if (n === 0) anyBlank = true;
  }
  return { dgw, bgw: active && anyBlank, active };
}
