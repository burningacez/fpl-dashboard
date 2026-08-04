/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Hall of Fame walkthrough.
 *
 * This page needs it more than most: /api/hall-of-fame answers
 * `{ available: false }` until gameweeks have been played, so for the whole of
 * pre-season the page is one line of text with nothing on it to explain.
 *
 * Records are keyed by manager NAME here, exactly as the real payload is (it has
 * to work for archived seasons that predate entry ids), so seating the user is a
 * matter of putting their name in one record: The Machine, which is why the
 * walkthrough's "records you hold" step can point at a teal card.
 *
 * Nothing on this page fetches on open, so demo mode is a pure render-time
 * override of both payloads the page reads: /api/hall-of-fame and the
 * /api/set-and-forget one behind The Alchemist.
 *
 * Dynamically imported, so it stays out of the /hall-of-fame bundle for page
 * loads that don't run a tour.
 *
 * Mirrors shapes nothing type-checks (the page reads both as `any`).
 * `npm run test:tour:hof` walks every step against this data and is what catches
 * it going stale.
 */
import { DEMO_GW, DEMO_ROSTER, seatUser, type DemoIdentity } from '@/lib/demo-league';

export interface DemoHofData {
  hof: any;
  saf: any;
}

/** Completed gameweeks in the example season. */
const COMPLETED = DEMO_GW - 1;

/**
 * A record as the service publishes it: the tied-name list plus the formatted
 * string beside it. The page reads `names` and falls back to `name`, so both are
 * here rather than the page's preference being baked in.
 */
function record(names: string[], rest: Record<string, unknown>): any {
  const name =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} & ${names[1]}`
        : `${names[0]} +${names.length - 1} others`;
  return { name, names, ...rest };
}

export function buildDemoHof(me: DemoIdentity | null): DemoHofData {
  const r = seatUser(DEMO_ROSTER, me).map((m) => m.name);
  // r[1] is the user's slot. They hold The Machine and nothing in the lowlights:
  // the walkthrough points at a record of theirs, and being handed the season's
  // worst week on a first visit is not the introduction anyone wants.
  return {
    hof: {
      highlights: {
        highestGW: record([r[0]], { score: 97, gw: 12 }),
        biggestClimb: record([r[4]], { ranksGained: 4, gw: 9 }),
        // A three-way tie, so the walkthrough has a shared record to explain.
        mostMotM: record([r[0], r[2], r[3]], { count: 1 }),
        mostWeeklyWins: record([r[3]], { count: 5 }),
        longestFormStreak: record([r[0]], { count: 6 }),
        mostConsistent: record([r[1]], { stdDev: 8.4 }),
        highestTeamValue: record([r[4]], { value: '103.6', gw: 20 }),
        bestTinkering: record([r[2]], { impact: 31, gw: 15 }),
      },
      lowlights: {
        lowestGW: record([r[5]], { score: 19, gw: 7 }),
        mostLosses: record([r[5]], { count: 5 }),
        biggestHit: record([r[4]], { cost: 12, gw: 14 }),
        biggestDrop: record([r[2]], { ranksLost: 4, gw: 6 }),
        mostTransfers: record([r[4]], { count: 41 }),
        lowestTeamValue: record([r[0]], { value: '99.4', gw: 3 }),
        biggestBenchHaul: record([r[3]], { points: 26, gw: 10 }),
        worstTinkering: record([r[0]], { impact: -18, gw: 17 }),
      },
      chipAwards: {
        perfectBB: [{ name: r[5], gw: 18, benchPoints: 24 }],
        perfectTC: [{ name: r[3], player: 'Erling Haaland', captainPoints: 39, gw: 11 }],
        worstBB: record([r[2]], { benchPoints: 5, gw: 19 }),
        worstTC: record([r[4]], { player: 'Ollie Watkins', captainPoints: 4, gw: 16 }),
      },
    },
    // The Alchemist is merged in from /api/set-and-forget, so the demo has to
    // supply that payload too or the card is missing.
    saf: {
      completedGWs: COMPLETED,
      bestTinkerer: { name: r[2], difference: 48 },
    },
  };
}
