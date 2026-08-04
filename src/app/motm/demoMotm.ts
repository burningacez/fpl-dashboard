/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Manager of the Month walkthrough.
 *
 * Same reasoning as src/app/losers/demoLosers.ts: before GW1 every period tile
 * says "Not started" and none of them open, so the tour narrates a frozen
 * example season instead. The example season has finished every gameweek up to
 * DEMO_GW and is playing DEMO_GW itself, which gives the grid finished periods,
 * one live period and a run of periods still to come.
 *
 * Nothing on this page fetches on open, so demo mode is a pure render-time
 * override of the /api/motm payload.
 *
 * Dynamically imported, so it stays out of the /motm bundle for page loads that
 * don't run a tour.
 *
 * Mirrors the shape of /api/motm and nothing type-checks that (the page reads it
 * as `any`). `npm run test:tour:motm` walks every step against this data and is
 * what catches it going stale.
 */
import { DEMO_GW, DEMO_ROSTER, seatUser, type DemoIdentity } from '@/lib/demo-league';

export interface DemoMotmData {
  motm: any;
  /** A finished period, the one the walkthrough opens. */
  focusPeriod: number;
  /** The period containing the live gameweek. */
  livePeriod: number;
}

/**
 * One manager's gameweek in the example season.
 *
 * Deterministic, so the season is identical on every run, and the wobble rotates
 * who has the good weeks: a flat base per manager would hand every period to the
 * same person and the grid would look rigged.
 */
function gameweek(slot: number, gw: number) {
  // Each manager gets a hot run of four gameweeks in turn, which is what makes
  // the finished periods have four different winners rather than one.
  const hot = (slot + Math.floor((gw - 1) / 4)) % 6 === 0 ? 6 : 0;
  const gross = 52 + hot + ((gw * 7 + slot * 11) % 19) - 8;
  const transfers = (gw + slot * 2) % 3;
  // A hit only once they go past the free transfer, which is what the Trf column
  // shows in red.
  const transferCost = transfers > 1 ? 4 : 0;
  return { gross, transfers, transferCost, goals: (gw + slot) % 4, assists: (gw * 2 + slot) % 3 };
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/**
 * A period's rankings, aggregated out of gameweek() the same way
 * calculateMotmRankings does it (src/server/services/motm.ts): net score is
 * gross minus transfer hits, Best and Low come off the per-gameweek net scores.
 * Derived rather than hand-written, so no column can contradict another.
 */
function rankings(roster: typeof DEMO_ROSTER, gws: number[]): any[] {
  const rows = roster.map((m, slot) => {
    const weeks = gws.map((gw) => gameweek(slot, gw));
    const grossScore = sum(weeks.map((w) => w.gross));
    const transferCost = sum(weeks.map((w) => w.transferCost));
    const netScores = weeks.map((w) => w.gross - w.transferCost).sort((a, b) => b - a);
    return {
      name: m.name,
      team: m.team,
      entryId: m.entryId,
      netScore: grossScore - transferCost,
      grossScore,
      transferCost,
      transfers: sum(weeks.map((w) => w.transfers)),
      highestGW: netScores[0],
      lowestTwo: [...netScores].reverse().slice(0, 2),
      goals: sum(weeks.map((w) => w.goals)),
      assists: sum(weeks.map((w) => w.assists)),
    };
  });
  // Net score, then the first two tiebreakers the service applies. The example
  // season never ties on net, so nothing below that is exercised.
  rows.sort((a, b) => b.netScore - a.netScore || a.transfers - b.transfers || b.highestGW - a.highestGW);
  rows.forEach((r: any, i) => (r.rank = i + 1));
  return rows;
}

/**
 * `periodRanges` is the selected season's own period map, so the grid always has
 * the number of periods the page header claims.
 */
export function buildDemoMotm(
  me: DemoIdentity | null,
  leagueName: string,
  periodRanges: Record<number, [number, number]>,
): DemoMotmData {
  const roster = seatUser(DEMO_ROSTER, me);
  const periods: Record<number, any> = {};
  const winners: any[] = [];
  let focusPeriod = 0;
  let livePeriod = 0;

  for (const [key, [startGW, endGW]] of Object.entries(periodRanges)) {
    const p = Number(key);
    const played: number[] = [];
    for (let gw = startGW; gw <= Math.min(endGW, DEMO_GW); gw++) played.push(gw);
    const isLive = startGW <= DEMO_GW && DEMO_GW <= endGW;
    const periodComplete = !isLive && played.length === endGW - startGW + 1;
    const rows = played.length ? rankings(roster, played) : [];

    periods[p] = { rankings: rows, startGW, endGW, periodComplete, periodGWs: played, isLive };
    if (periodComplete) focusPeriod = p;
    if (isLive) livePeriod = p;
    if (rows.length) {
      winners.push({
        period: p,
        gwRange: `GW ${startGW}-${endGW}`,
        winner: periodComplete ? rows[0] : null,
        ...(periodComplete
          ? {}
          : { inProgress: true, isLive, completedGWs: played.length, totalGWs: endGW - startGW + 1 }),
      });
    }
  }

  return {
    motm: { leagueName, periods, winners, currentGW: DEMO_GW, isLive: true },
    focusPeriod,
    livePeriod,
  };
}
