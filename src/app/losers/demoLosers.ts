/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Weekly Losers walkthrough.
 *
 * Same reasoning as src/app/week/demoWeek.ts: onboarding happens pre-season, and
 * before GW1 this page is a grid of empty tiles with nothing to click, so the
 * tour narrates a frozen example season instead.
 *
 * Simpler than the Scores demo in one respect: nothing on this page fetches on
 * open. Both modals render from the payloads below, so demo mode is a pure
 * render-time override and no fetch interception is needed.
 *
 * Dynamically imported, so it stays out of the /losers bundle for page loads
 * that don't run a tour.
 *
 * Mirrors the shape of /api/losers and /api/week and nothing type-checks that
 * (the page reads both as `any`). `npm run test:tour:losers` walks every step
 * against this data and is what catches it going stale.
 */
import { DEMO_GW, DEMO_ROSTER, seatUser, type DemoIdentity } from '@/lib/demo-league';

/** Completed gameweeks in the example season, the last one still in play. */
const COMPLETED = DEMO_GW - 1;

export interface DemoLosersData {
  losers: any;
  week: any;
  /** Gameweek the walkthrough opens the per-GW modal on. */
  focusGw: number;
  /** The live gameweek, so the tour can point at the in-progress tile. */
  liveGw: number;
}

/**
 * A gameweek's full table. Scores descend from a plausible top so the loser is
 * clearly last, and GW14 is built as a tie on points so the tiebreaker rules
 * have something to actually resolve.
 */
function gameweek(gw: number, roster: typeof DEMO_ROSTER): any {
  const tie = gw === 14;
  const managers = roster.map((m, i) => {
    // Rotate who has the bad week, so the season does not look rigged.
    const slot = (i + gw) % roster.length;
    const points = tie && slot >= roster.length - 2 ? 31 : 72 - slot * 8;
    return {
      name: m.name,
      team: m.team,
      entry: m.entryId,
      points,
      goals: Math.max(0, 4 - slot),
      assists: Math.max(0, 3 - slot),
      transfers: slot === roster.length - 1 ? 3 : slot % 3,
    };
  });
  return { managers };
}

function losersPayload(leagueName: string, roster: typeof DEMO_ROSTER): any {
  const allGameweeks: Record<number, any> = {};
  const losers: any[] = [];

  for (let gw = 1; gw <= COMPLETED; gw++) {
    const week = gameweek(gw, roster);
    allGameweeks[gw] = week;
    const sorted = [...week.managers].sort((a, b) => a.points - b.points);
    const lowest = sorted[0];
    const next = sorted.find((m) => m.points > lowest.points) ?? lowest;
    const margin = next.points - lowest.points;
    losers.push({
      gameweek: gw,
      name: lowest.name,
      entry: lowest.entry,
      // The page reads this string: anything not starting "Lost by" is treated
      // as settled on a tiebreak, and the tile says Tiebreaker instead.
      context: margin > 0 ? `Lost by ${margin} pts` : 'Tied on points, most transfers',
    });
  }

  return { leagueName, losers, allGameweeks };
}

/** The live gameweek, shaped as /api/week gives it to this page. */
function weekPayload(leagueName: string, roster: typeof DEMO_ROSTER): any {
  const managers = roster.map((m, i) => ({
    entryId: m.entryId,
    name: m.name,
    team: m.team,
    // Bottom of the pile is last in the roster, and only just: a 3-point margin
    // is the interesting case, not a rout.
    gwScore: 64 - i * 7,
    gwGoals: Math.max(0, 3 - i),
    gwAssists: Math.max(0, 2 - i),
    transfersMade: i === roster.length - 1 ? 3 : i % 2,
    playersLeft: (i + 1) % 4,
    activePlayers: i % 2,
    activeChip: i === 0 ? '3xc' : i === 2 ? 'bboost' : null,
  }));
  return { leagueName, currentGW: DEMO_GW, isLive: true, managers };
}

export function buildDemoLosers(me: DemoIdentity | null, leagueName: string): DemoLosersData {
  const roster = seatUser(DEMO_ROSTER, me);
  return {
    losers: losersPayload(leagueName, roster),
    week: weekPayload(leagueName, roster),
    // A completed gameweek that was settled on a tiebreak, so the modal has the
    // most to explain.
    focusGw: 14,
    liveGw: DEMO_GW,
  };
}
