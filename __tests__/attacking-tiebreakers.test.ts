/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The 2026-27 attacking tiebreakers: goals then assists, on all three money
 * paths. Mirrors money-paths.test.ts (which pins the 2025-26 chains) with the
 * season config flipped on, so the pair together prove the rule change lands
 * on the new season only.
 *
 *  - Weekly loser: the WORST attacking week loses (fewest goals, then fewest
 *    assists) before the most-transfers rule gets a say.
 *  - MotM: the BEST attacking period wins, ahead of fewest transfers.
 *  - Final standings: MotM wins → goals → assists → weekly losses → transfers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/server/redis', () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => true),
  redisConfigured: () => false,
}));

const seasonConfig = {
  id: '2026-27',
  leagueId: 1,
  entrants: 3,
  entryFee: 30,
  weeklyLoserFine: 5,
  totalWeeks: 38,
  feesConfirmed: true,
  cashConfirmed: false,
  prizes: { league: [320, 200, 120], cup: 150, motmPerPeriod: 30 },
  motmPeriods: { 1: [1, 5] } as Record<number, [number, number]>,
  attackingTiebreakers: true,
  chipSecondHalfStartGw: 20,
};

vi.mock('../src/server/season-state', () => ({
  getCurrentSeason: () => '2026-27',
  getActiveSeasonConfig: () => seasonConfig,
  getLeagueId: () => 1,
}));

vi.mock('../src/server/loser-overrides', () => ({
  getLoserOverrides: () => ({}),
}));

const managers = [
  { entry: 1, player_name: 'Alice', entry_name: 'Team A', rank: 1 },
  { entry: 2, player_name: 'Bob', entry_name: 'Team B', rank: 2 },
  { entry: 3, player_name: 'Cara', entry_name: 'Team C', rank: 3 },
];
let histories: Record<number, any>;
let completedGWs: number[];

vi.mock('../src/server/fpl/client', () => ({
  fetchLeagueData: async () => ({
    league: { name: 'Test League', cup_league: null },
    standings: { results: managers },
  }),
  fetchBootstrap: async () => ({ events: [], elements: [], teams: [] }),
  fetchFixtures: async () => [],
  fetchManagerHistory: async (entryId: number) => histories[entryId],
  fetchCupMatches: async () => [],
  getCompletedGameweeks: () => completedGWs,
}));

import { fetchWeeklyLosers } from '../src/server/services/losers';
import { fetchProfitLossData } from '../src/server/services/earnings';
import { calculateMotmRankings } from '../src/server/services/motm';
import { dataCache } from '../src/server/data-cache';
import { attackingFromDetailedPicks, attackingFromLive } from '../src/lib/attacking-stats';
import { rankFinalStandings } from '../src/lib/final-standings';

function gwRow(event: number, points: number, transfers = 0, cost = 0) {
  return { event, points, event_transfers: transfers, event_transfers_cost: cost, total_points: points };
}

/** A processed-picks payload with one counting player holding the given returns. */
function picksWith(points: number, goals: number, assists: number) {
  return {
    calculatedPoints: points,
    totalProvisionalBonus: 0,
    transfersCost: 0,
    activeChip: null,
    players: [
      {
        id: 1,
        isBench: false,
        pointsBreakdown: [
          { identifier: 'goals_scored', value: goals, points: goals * 5 },
          { identifier: 'assists', value: assists, points: assists * 3 },
        ],
      },
    ],
  } as any;
}

function seed(gw: number, byEntry: Record<number, [number, number, number]>) {
  for (const [entry, [pts, goals, assists]] of Object.entries(byEntry)) {
    dataCache.processedPicksCache[`${entry}-${gw}`] = picksWith(pts, goals, assists);
  }
}

beforeEach(() => {
  dataCache.processedPicksCache = {};
  dataCache.coinFlips = { motm: {}, losers: {}, standings: {} } as any;
  completedGWs = [1];
  histories = {
    1: { current: [gwRow(1, 50)], chips: [] },
    2: { current: [gwRow(1, 60)], chips: [] },
    3: { current: [gwRow(1, 70)], chips: [] },
  };
});

describe('attackingFromDetailedPicks', () => {
  it('counts only players whose returns count, and sums a double gameweek', () => {
    const detailed = {
      activeChip: null,
      players: [
        // Starter with two fixtures — one breakdown entry per fixture.
        {
          id: 1,
          isBench: false,
          pointsBreakdown: [
            { identifier: 'goals_scored', value: 1, points: 5 },
            { identifier: 'goals_scored', value: 2, points: 10 },
            { identifier: 'assists', value: 1, points: 3 },
          ],
        },
        // Starter subbed out — did not play, cannot have returns that count.
        { id: 2, isBench: false, subOut: true, pointsBreakdown: [{ identifier: 'goals_scored', value: 9, points: 45 }] },
        // Bench player who came on.
        { id: 3, isBench: true, subIn: true, pointsBreakdown: [{ identifier: 'assists', value: 2, points: 6 }] },
        // Bench player who stayed on the bench.
        { id: 4, isBench: true, pointsBreakdown: [{ identifier: 'goals_scored', value: 4, points: 20 }] },
      ],
    };
    expect(attackingFromDetailedPicks(detailed)).toEqual({ goals: 3, assists: 3 });
  });

  it('counts the whole bench under Bench Boost', () => {
    const detailed = {
      activeChip: 'bboost',
      players: [
        { id: 1, isBench: false, pointsBreakdown: [{ identifier: 'goals_scored', value: 1, points: 5 }] },
        { id: 2, isBench: true, pointsBreakdown: [{ identifier: 'goals_scored', value: 2, points: 10 }] },
      ],
    };
    expect(attackingFromDetailedPicks(detailed)).toEqual({ goals: 3, assists: 0 });
  });

  it('counts a captain goal once, not doubled', () => {
    const detailed = {
      activeChip: null,
      players: [
        { id: 1, isBench: false, isCaptain: true, multiplier: 2, pointsBreakdown: [{ identifier: 'goals_scored', value: 1, points: 5 }] },
      ],
    };
    expect(attackingFromDetailedPicks(detailed).goals).toBe(1);
  });

  it('reads live element stats for an in-progress gameweek', () => {
    const scored = [
      { id: 1, counts: true },
      { id: 2, counts: false },
    ];
    const liveData = {
      elements: [
        { id: 1, stats: { goals_scored: 2, assists: 1 } },
        { id: 2, stats: { goals_scored: 5, assists: 5 } },
      ],
    };
    expect(attackingFromLive(scored, liveData)).toEqual({ goals: 2, assists: 1 });
  });
});

describe('fetchWeeklyLosers with attacking tiebreakers', () => {
  it('breaks a points tie by FEWEST goals (the blank attack pays)', async () => {
    histories[1].current = [gwRow(1, 42, 1)];
    histories[2].current = [gwRow(1, 42, 5)]; // more transfers, but he scored
    seed(1, { 1: [42, 0, 2], 2: [42, 1, 0], 3: [70, 3, 3] });
    const { losers } = await fetchWeeklyLosers();
    expect(losers[0]).toMatchObject({ name: 'Alice', entry: 1, context: 'Fewest goals' });
  });

  it('falls to FEWEST assists when goals are level', async () => {
    seed(1, { 1: [42, 1, 3], 2: [42, 1, 1], 3: [70, 0, 0] });
    const { losers } = await fetchWeeklyLosers();
    expect(losers[0]).toMatchObject({ name: 'Bob', entry: 2, context: 'Fewest assists' });
  });

  it('still falls through to most transfers when attacking returns are level', async () => {
    histories[1].current = [gwRow(1, 42, 3)];
    histories[2].current = [gwRow(1, 42, 1)];
    seed(1, { 1: [42, 1, 1], 2: [42, 1, 1], 3: [70, 0, 0] });
    const { losers } = await fetchWeeklyLosers();
    expect(losers[0]).toMatchObject({ name: 'Alice', context: 'More transfers' });
  });

  it('publishes each manager’s goals and assists for the gameweek modal', async () => {
    seed(1, { 1: [42, 0, 1], 2: [60, 2, 0], 3: [70, 1, 4] });
    const { allGameweeks } = await fetchWeeklyLosers();
    const bob = allGameweeks[1].managers.find((m: any) => m.entry === 2);
    expect(bob).toMatchObject({ goals: 2, assists: 0 });
  });
});

describe('calculateMotmRankings with attacking tiebreakers', () => {
  const entrant = (name: string, gameweeks: any[]) => ({ name, team: name, entryId: name.length, gameweeks });

  it('breaks a net tie by MOST goals, ahead of the transfer count', () => {
    const res = calculateMotmRankings(
      [
        { ...entrant('Alice', [{ ...gwRow(1, 50, 1), goals: 3, assists: 0 }]) },
        { ...entrant('Bob', [{ ...gwRow(1, 50, 0), goals: 2, assists: 0 }]) },
      ],
      1,
      [1],
    );
    // Bob made fewer transfers, but Alice's squad scored more.
    expect(res.rankings[0].name).toBe('Alice');
    expect(res.rankings[0].goals).toBe(3);
  });

  it('then by MOST assists', () => {
    const res = calculateMotmRankings(
      [
        { ...entrant('Alice', [{ ...gwRow(1, 50, 1), goals: 2, assists: 1 }]) },
        { ...entrant('Bob', [{ ...gwRow(1, 50, 1), goals: 2, assists: 4 }]) },
      ],
      1,
      [1],
    );
    expect(res.rankings[0].name).toBe('Bob');
  });

  it('sums goals across the gameweeks in the period', () => {
    const res = calculateMotmRankings(
      [{ ...entrant('Alice', [{ ...gwRow(1, 50), goals: 2, assists: 1 }, { ...gwRow(2, 40), goals: 3, assists: 2 }]) }],
      1,
      [1, 2],
    );
    expect(res.rankings[0]).toMatchObject({ goals: 5, assists: 3 });
  });
});

describe('fetchProfitLossData league prizes', () => {
  it('pays out on the tiebroken final standings, not FPL’s raw rank', async () => {
    // The whole season in one gameweek: everyone finishes level on 50.
    seasonConfig.totalWeeks = 1;
    seasonConfig.motmPeriods = { 1: [1, 1] };
    try {
      completedGWs = [1];
      histories = {
        1: { current: [gwRow(1, 50)], chips: [] }, // FPL rank 1
        2: { current: [gwRow(1, 50)], chips: [] },
        3: { current: [gwRow(1, 50)], chips: [] },
      };
      // Cara's squad scored the most; Alice is top of FPL's list but scored least.
      seed(1, { 1: [50, 0, 0], 2: [50, 1, 0], 3: [50, 4, 0] });

      const data = await fetchProfitLossData();
      const byName = Object.fromEntries(data.managers.map((m: any) => [m.name, m]));
      expect(data.seasonComplete).toBe(true);
      // £320 for 1st: Cara on goals, not Alice on league position.
      expect(byName.Cara.leagueFinish).toBe(320);
      expect(byName.Bob.leagueFinish).toBe(200);
      expect(byName.Alice.leagueFinish).toBe(120);
    } finally {
      seasonConfig.totalWeeks = 38;
      seasonConfig.motmPeriods = { 1: [1, 5] };
    }
  });
});

describe('rankFinalStandings', () => {
  const row = (entryId: number, name: string, netScore: number, extra: any = {}) => ({
    entryId,
    name,
    netScore,
    totalTransfers: 0,
    highestGW: 0,
    lowestGW: 0,
    ...extra,
  });

  const losers = {
    losers: [{ gameweek: 1, entry: 2 }, { gameweek: 2, entry: 2 }],
    allGameweeks: {
      1: {
        managers: [
          { entry: 1, goals: 2, assists: 1 },
          { entry: 2, goals: 5, assists: 0 },
          { entry: 3, goals: 2, assists: 4 },
        ],
      },
    },
  };
  const motm = {
    winners: [
      { period: 1, winner: { entryId: 3 } },
      { period: 2, winner: null }, // still in progress — not a win
    ],
  };

  const rank = (rows: any[], enabled: boolean) =>
    rankFinalStandings(rows, { score: (r) => r.netScore, enabled, losers, motm }).map((r) => r.name);

  it('orders equal totals by MotM wins, then goals, then assists', () => {
    const rows = [row(1, 'Alice', 1000), row(2, 'Bob', 1000), row(3, 'Cara', 1000)];
    // Cara has the MotM win; Bob outscores Alice on goals.
    expect(rank(rows, true)).toEqual(['Cara', 'Bob', 'Alice']);
  });

  it('uses weekly losses before transfers', () => {
    // Level on MotM wins, goals and assists; Bob carries two fines.
    const rows = [
      row(2, 'Bob', 900, { totalTransfers: 0 }),
      row(4, 'Dee', 900, { totalTransfers: 40 }),
    ];
    const ordered = rankFinalStandings(rows, {
      score: (r) => r.netScore,
      enabled: true,
      losers: { losers: losers.losers, allGameweeks: {} },
      motm: { winners: [] },
    });
    expect(ordered.map((r) => r.name)).toEqual(['Dee', 'Bob']);
  });

  it('leaves the order untouched for a season without the tiebreakers', () => {
    const rows = [row(1, 'Alice', 1000), row(2, 'Bob', 1000), row(3, 'Cara', 1000)];
    expect(rank(rows, false)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('still sorts on the net total first', () => {
    const rows = [row(1, 'Alice', 900), row(3, 'Cara', 1000)];
    expect(rank(rows, true)).toEqual(['Cara', 'Alice']);
  });
});
