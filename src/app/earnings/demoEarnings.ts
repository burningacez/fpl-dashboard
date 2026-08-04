/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Earnings walkthrough.
 *
 * Two reasons this page needs a demo rather than narrating the real one. Before
 * GW1 there are no fines and no prizes, so every figure is zero. And the current
 * season's pot is not declared until every entry is in (`cashConfirmed`), so
 * until then the real page shows a dash in place of every £ value, which is
 * nothing to explain Net with.
 *
 * So the demo overrides the season config as well as the payload: an example
 * league of six that has finished its season, with the pot confirmed. Every
 * figure reconciles, because they are all derived here rather than typed in:
 *
 *   pot        6 entries x £30, plus one £5 fine for each of 38 gameweeks = £370
 *   paid in    the entry fee plus £5 a fine, per manager
 *   earned     league prizes (£110 / £70 / £40), the cup (£60), MotM (£10 each)
 *   net        earned minus paid in, which sums to zero across the league
 *
 * Nothing on this page fetches on open, so demo mode is otherwise a pure
 * render-time override.
 *
 * Dynamically imported, so it stays out of the /earnings bundle for page loads
 * that don't run a tour.
 *
 * Mirrors the shape of /api/earnings and nothing type-checks that (the page reads
 * it as `any`). `npm run test:tour:earnings` walks every step against this data
 * and is what catches it going stale.
 */
import { DEMO_ROSTER, seatUser, type DemoIdentity } from '@/lib/demo-league';
import { type SeasonConfig } from '@/lib/season-config';

export interface DemoEarningsData {
  earnings: any;
  /** Money rules for the example league, standing in for the season config. */
  config: SeasonConfig;
}

/**
 * Each manager's season, one per roster slot: weekly losses, MotM periods won,
 * where they finished, and whether they took the cup.
 *
 * The shares are shaped rather than random: one manager well up on the season,
 * one just ahead, and the rest down, so the Net column has a range to show. The
 * user's slot is second, ahead but not by much.
 */
const SEASONS: { losses: number; motmWins: number; finish: number; cup: boolean }[] = [
  { losses: 4, motmWins: 2, finish: 1, cup: true },
  { losses: 5, motmWins: 2, finish: 2, cup: false },
  { losses: 6, motmWins: 1, finish: 3, cup: false },
  { losses: 6, motmWins: 2, finish: 0, cup: false },
  { losses: 8, motmWins: 1, finish: 0, cup: false },
  { losses: 9, motmWins: 1, finish: 0, cup: false },
];

/**
 * Fines, one per gameweek of the example season, so the pot line adds up. The
 * MotM wins sum to nine for the same reason, which is how many periods both
 * current seasons have.
 */
const TOTAL_WEEKS = SEASONS.reduce((sum, s) => sum + s.losses, 0);

/**
 * The example league's money rules. Built off the selected season so anything
 * the page reads but the walkthrough doesn't talk about (period boundaries, the
 * links) stays as it is.
 */
function demoConfig(cfg: SeasonConfig): SeasonConfig {
  return {
    ...cfg,
    entrants: DEMO_ROSTER.length,
    entryFee: 30,
    weeklyLoserFine: 5,
    totalWeeks: TOTAL_WEEKS,
    feesConfirmed: true,
    cashConfirmed: true,
    prizes: { league: [110, 70, 40], cup: 60, motmPerPeriod: 10 },
  };
}

export function buildDemoEarnings(
  me: DemoIdentity | null,
  leagueName: string,
  cfg: SeasonConfig,
): DemoEarningsData {
  const config = demoConfig(cfg);
  const roster = seatUser(DEMO_ROSTER, me);

  const managers = roster.map((m, i) => {
    const { losses, motmWins, finish, cup } = SEASONS[i];
    const weeklyLossesCost = losses * config.weeklyLoserFine;
    const totalPaid = config.entryFee + weeklyLossesCost;
    const motmEarnings = motmWins * config.prizes.motmPerPeriod;
    const leagueFinish = finish > 0 ? (config.prizes.league[finish - 1] ?? 0) : 0;
    const cupWin = cup ? config.prizes.cup : 0;
    const totalEarnings = leagueFinish + cupWin + motmEarnings;
    return {
      entryId: m.entryId,
      name: m.name,
      team: m.team,
      weeklyLosses: losses,
      weeklyLossesCost,
      motmWins,
      motmEarnings,
      leagueFinish,
      cupWin,
      totalPaid,
      totalEarnings,
      netEarnings: totalEarnings - totalPaid,
    };
  });

  // The service hands the page its rows already sorted by net, best first.
  managers.sort((a, b) => b.netEarnings - a.netEarnings);

  return {
    earnings: {
      leagueName,
      managers,
      // A finished season, so the league prizes have been awarded and there is
      // something in the League column to point at.
      seasonComplete: true,
      completedGWs: TOTAL_WEEKS,
    },
    config,
  };
}
