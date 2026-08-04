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
 * (the page reads both as `any`). Two things catch it going stale:
 * `npm run test:tour:losers` walks every step against this data, and
 * __tests__/demo-losers.test.ts checks the verdict on a tile agrees with the
 * table behind it.
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

/**
 * Worst first, the same order the per-GW modal puts the table in (see the
 * managers.sort in src/app/losers/page.tsx): fewest points, then fewest goals,
 * fewest assists, most transfers. The loser has to be read off this order and
 * not off points alone, or the tile names one manager while the table badges
 * whoever the tiebreakers actually sink.
 *
 * Goals and assists only count from 2026-27 and this demo never lets them
 * decide — the managers tied in gameweek() are level on both — so this single
 * comparator matches the modal under either season's rules.
 */
function worstFirst(a: any, b: any): number {
  if (a.points !== b.points) return a.points - b.points;
  if (a.goals !== b.goals) return a.goals - b.goals;
  if (a.assists !== b.assists) return a.assists - b.assists;
  return b.transfers - a.transfers;
}

function losersPayload(leagueName: string, roster: typeof DEMO_ROSTER): any {
  const allGameweeks: Record<number, any> = {};
  const losers: any[] = [];

  for (let gw = 1; gw <= COMPLETED; gw++) {
    const week = gameweek(gw, roster);
    allGameweeks[gw] = week;
    const [loser, runnerUp] = [...week.managers].sort(worstFirst);

    // The context strings /api/losers produces (src/server/services/losers.ts):
    // a margin when one manager is alone at the bottom, otherwise the rule that
    // settled it. The page reads the string — anything not starting "Lost by"
    // is treated as a tiebreak and the tile says Tiebreaker instead of a margin.
    let context: string;
    if (!runnerUp || runnerUp.points !== loser.points) {
      const margin = runnerUp ? runnerUp.points - loser.points : 0;
      context = `Lost by ${margin} pt${margin !== 1 ? 's' : ''}`;
    } else if (loser.goals < runnerUp.goals) {
      context = 'Fewest goals';
    } else if (loser.assists < runnerUp.assists) {
      context = 'Fewest assists';
    } else if (loser.transfers > runnerUp.transfers) {
      context = 'More transfers';
    } else {
      context = 'Tiebreaker';
    }

    losers.push({
      gameweek: gw,
      name: loser.name,
      team: loser.team,
      entry: loser.entry,
      points: loser.points,
      context,
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
    // Bottom of the pile is last in the roster, and by a single gap rather than
    // a rout: the live tile is meant to look like it could still swing.
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
