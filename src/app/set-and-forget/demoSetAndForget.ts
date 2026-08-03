/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Set & Forget walkthrough.
 *
 * Same reasoning as the other demos (see src/app/week/demoWeek.ts): this page
 * says "No data available yet. Check back after GW1 is complete" for the whole
 * of pre-season, which is exactly when someone new is trying to work out what it
 * even means. The tour narrates a finished example season instead.
 *
 * Nothing here fetches on open, so demo mode is a pure render-time override.
 *
 * Dynamically imported, so it stays out of the /set-and-forget bundle for page
 * loads that don't run a tour.
 *
 * Mirrors /api/set-and-forget and nothing type-checks that (the page reads it as
 * `any`). `npm run test:tour:saf` walks the steps against this and is what
 * catches it going stale.
 */
import { DEMO_GW, DEMO_ROSTER, seatUser, type DemoIdentity } from '@/lib/demo-league';

/**
 * Each manager's season, one per roster slot.
 *
 * `saf` is what they would have scored keeping their GW1 team untouched;
 * `difference` is actual minus that, so a positive number means the tinkering
 * paid. Deliberately spread across the whole range: two managers clearly better
 * off for meddling, one who broke even, and three who would have done better
 * leaving it alone. Without a spread the Diff column has nothing to say.
 */
const SEASONS: { saf: number; difference: number }[] = [
  { saf: 764, difference: 48 },  // tinkering paid, and paid big
  { saf: 794, difference: 12 },  // the user's slot: modestly ahead
  { saf: 788, difference: 2 },   // may as well not have bothered
  { saf: 790, difference: -19 },
  { saf: 791, difference: -37 },
  { saf: 792, difference: -64 }, // the worst tinkerer
];

export interface DemoSafData {
  saf: any;
  /** Column the walkthrough sorts by, to show what the ordering reveals. */
  focusSort: 'difference';
}

export function buildDemoSaf(me: DemoIdentity | null, leagueName: string): DemoSafData {
  const roster = seatUser(DEMO_ROSTER, me);

  const rows = roster.map((m, i) => {
    const { saf, difference } = SEASONS[i];
    return {
      entryId: m.entryId,
      name: m.name,
      team: m.team,
      safTotal: saf,
      actualTotal: saf + difference,
      difference,
    };
  });

  // Ranks are derived rather than hand-written, so the two rank columns and the
  // badge between them can never disagree with the totals beside them.
  const rank = (key: 'safTotal' | 'actualTotal') => {
    const order = [...rows].sort((a, b) => b[key] - a[key]);
    return new Map(order.map((r, i) => [r.entryId, i + 1]));
  };
  const safRanks = rank('safTotal');
  const actualRanks = rank('actualTotal');

  const managers = rows.map((r) => ({
    ...r,
    safRank: safRanks.get(r.entryId)!,
    actualRank: actualRanks.get(r.entryId)!,
  }));

  // The page only shows the "should have set and forgot" card when someone
  // actually lost points, so the worst difference has to be negative.
  const worst = [...managers].sort((a, b) => a.difference - b.difference)[0];

  return {
    saf: {
      leagueName,
      completedGWs: DEMO_GW - 1,
      managers,
      worstTinkerer: { entryId: worst.entryId, name: worst.name, difference: worst.difference },
    },
    focusSort: 'difference',
  };
}
