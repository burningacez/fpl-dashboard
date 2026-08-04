/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Who is bottom of an in-progress gameweek, and the order the live table shows.
 *
 * Lifted out of the page (legacy render() liveLoserInfo) so the name on the live
 * tile and the top of the live standings table come from one comparator. They
 * used to be worked out separately — the tile split a tie on transfers alone
 * while the table split it on goals and assists first — so a week where two
 * managers were level on score could name one manager on the tile and put a
 * different one at the top of the table it opened.
 *
 * Reads managers as `any`, like the rest of the page: this is /api/week's shape
 * and nothing type-checks it. __tests__/live-loser.test.ts covers the rules.
 */

export interface LiveLoserInfo {
  name: string;
  entryId: number | undefined;
  score: number;
  margin: number;
  /** Managers level on score with the loser, the loser included. */
  tiedCount: number;
  runners: string[];
}

/**
 * Worst first: fewest points, then the tiebreakers in the order the league
 * settles them — fewest goals, fewest assists (both 2026-27 onwards, hence the
 * flag), then most transfers. Matches the completed-week sort in page.tsx and
 * the one /api/losers uses (src/server/services/losers.ts), minus the coin
 * flip, which only a finished week persists.
 */
export function liveWorstFirst(showAttacking: boolean) {
  return (a: any, b: any): number => {
    if (a.gwScore !== b.gwScore) return a.gwScore - b.gwScore;
    if (showAttacking) {
      if ((a.gwGoals || 0) !== (b.gwGoals || 0)) return (a.gwGoals || 0) - (b.gwGoals || 0);
      if ((a.gwAssists || 0) !== (b.gwAssists || 0)) return (a.gwAssists || 0) - (b.gwAssists || 0);
    }
    return (b.transfersMade || 0) - (a.transfersMade || 0);
  };
}

/** Order the live standings table, worst first. */
export function sortLive(managers: any[] | undefined, showAttacking: boolean): any[] {
  if (!managers?.length) return [];
  return [...managers].sort(liveWorstFirst(showAttacking));
}

export function liveLoser(managers: any[] | undefined, showAttacking: boolean): LiveLoserInfo | null {
  const sorted = sortLive(managers, showAttacking);
  const loser = sorted[0];
  if (!loser) return null;

  const lowestScore = loser.gwScore;
  // Everyone level on score is in the tiebreak, whether or not a tiebreaker went
  // on to separate them, and the tile reads "Tiebreaker" for all of them. A
  // margin is only honest when the loser is alone at the bottom — measuring it
  // against the next *different* score would step straight over whoever is level
  // and claim a gap that is not there. A finished week reads the same way:
  // /api/losers only sends a "Lost by N" context when nobody else is level.
  const tied = sorted.filter((m: any) => m.gwScore === lowestScore);
  const secondLowest = sorted.find((m: any) => m.gwScore > lowestScore)?.gwScore ?? lowestScore;

  return {
    name: loser.name || 'Unknown',
    entryId: loser.entryId,
    score: lowestScore,
    margin: secondLowest - lowestScore,
    tiedCount: tied.length,
    runners: tied.map((m: any) => m.name),
  };
}
