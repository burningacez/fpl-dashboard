/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The money paths: who pays the £5 weekly fine and who wins MotM.
 * These decisions are worth real cash, so their tiebreak chains are pinned:
 *  - Weekly loser: lowest calculated net points → MOST transfers loses →
 *    persistent coin flip (higher value loses); manual overrides by entry id.
 *  - MotM: highest net → FEWEST transfers → highest single GW →
 *    best worst-two GWs → coin flip.
 *  - Earnings consumes the losers service output, so the two can't disagree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/server/redis', () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => true),
  redisConfigured: () => false,
}));

const seasonConfig = {
  id: '2025-26',
  leagueId: 1,
  entrants: 3,
  entryFee: 30,
  weeklyLoserFine: 5,
  totalWeeks: 38,
  cashConfirmed: true,
  prizes: { league: [320, 200, 120], cup: 150, motmPerPeriod: 30 },
  motmPeriods: { 1: [1, 5] } as Record<number, [number, number]>,
  chipSecondHalfStartGw: 20,
};

vi.mock('../src/server/season-state', () => ({
  getCurrentSeason: () => '2025-26',
  getActiveSeasonConfig: () => seasonConfig,
  getLeagueId: () => 1,
}));

// Mutable per-test override table (GW → entry id).
const overrides: Record<number, number> = {};
vi.mock('../src/server/loser-overrides', () => ({
  getLoserOverrides: () => overrides,
}));

// Three managers; histories and calculated points are set per test.
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
import { foldPlan, hitCost, freeTransfersAfter, type PlannerPlayer } from '../src/lib/squad-rules';

function gwRow(event: number, points: number, transfers = 0, cost = 0) {
  return { event, points, event_transfers: transfers, event_transfers_cost: cost, total_points: points };
}

/** Seed the processed-picks cache so getCalculatedPoints takes the cache path. */
function seedPoints(gw: number, byEntry: Record<number, number>) {
  for (const [entry, pts] of Object.entries(byEntry)) {
    dataCache.processedPicksCache[`${entry}-${gw}`] = {
      calculatedPoints: pts,
      totalProvisionalBonus: 0,
      transfersCost: 0,
    } as any;
  }
}

beforeEach(() => {
  dataCache.processedPicksCache = {};
  dataCache.coinFlips = { motm: {}, losers: {} } as any;
  for (const k of Object.keys(overrides)) delete overrides[Number(k)];
  completedGWs = [1];
  histories = {
    1: { current: [gwRow(1, 50)], chips: [] },
    2: { current: [gwRow(1, 60)], chips: [] },
    3: { current: [gwRow(1, 70)], chips: [] },
  };
});

describe('fetchWeeklyLosers', () => {
  it('names the lowest calculated scorer with the losing margin', async () => {
    seedPoints(1, { 1: 42, 2: 60, 3: 70 });
    const { losers } = await fetchWeeklyLosers();
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ gameweek: 1, name: 'Alice', entry: 1, context: 'Lost by 18 pts' });
  });

  it('breaks a points tie by MOST transfers (the tinkerer pays)', async () => {
    histories[1].current = [gwRow(1, 42, 3)];
    histories[2].current = [gwRow(1, 42, 1)];
    seedPoints(1, { 1: 42, 2: 42, 3: 70 });
    const { losers } = await fetchWeeklyLosers();
    expect(losers[0]).toMatchObject({ name: 'Alice', context: 'More transfers' });
  });

  it('falls back to the persistent coin flip when points and transfers tie', async () => {
    histories[1].current = [gwRow(1, 42, 2)];
    histories[2].current = [gwRow(1, 42, 2)];
    seedPoints(1, { 1: 42, 2: 42, 3: 70 });
    // Higher stored flip value loses.
    dataCache.coinFlips.losers['1'] = { Alice: 0.2, Bob: 0.9 } as any;
    const first = await fetchWeeklyLosers();
    expect(first.losers[0]).toMatchObject({ name: 'Bob', context: 'Tiebreaker' });
    // The flip is persistent: the same call never re-rolls a different loser.
    const second = await fetchWeeklyLosers();
    expect(second.losers[0].name).toBe('Bob');
  });

  it('applies a manual override by entry id and fudges the display', async () => {
    seedPoints(1, { 1: 42, 2: 60, 3: 70 });
    overrides[1] = 3; // Cara is the corrected loser despite the top score
    const { losers, allGameweeks } = await fetchWeeklyLosers();
    expect(losers[0]).toMatchObject({
      name: 'Cara',
      entry: 3,
      isOverride: true,
      context: 'Lost by 1 pt',
      points: 41, // lowest - 1, matching the fudged modal display
    });
    expect(allGameweeks[1].overrideName).toBe('Cara');
  });
});

describe('fetchProfitLossData', () => {
  it('counts fines from the losers service output (single source of truth)', async () => {
    completedGWs = [1, 2];
    histories = {
      1: { current: [gwRow(1, 42, 3), gwRow(2, 40, 3)], chips: [] },
      2: { current: [gwRow(1, 60), gwRow(2, 80)], chips: [] },
      3: { current: [gwRow(1, 70), gwRow(2, 90)], chips: [] },
    };
    seedPoints(1, { 1: 42, 2: 60, 3: 70 });
    seedPoints(2, { 1: 40, 2: 80, 3: 90 });
    const data = await fetchProfitLossData();
    const alice = data.managers.find((m: any) => m.entryId === 1);
    const bob = data.managers.find((m: any) => m.entryId === 2);
    expect(alice.weeklyLosses).toBe(2);
    expect(alice.weeklyLossesCost).toBe(10); // 2 × £5
    expect(alice.totalPaid).toBe(40); // £30 entry + £10 fines
    expect(bob.weeklyLosses).toBe(0);
    // No NaN anywhere — the old name-keyed override path could produce one.
    for (const m of data.managers) {
      expect(Number.isFinite(m.netEarnings)).toBe(true);
    }
  });

  it('only awards league prizes when the final gameweek is complete', async () => {
    seedPoints(1, { 1: 42, 2: 60, 3: 70 });
    const midSeason = await fetchProfitLossData();
    expect(midSeason.seasonComplete).toBe(false);
    expect(midSeason.managers.every((m: any) => m.leagueFinish === 0)).toBe(true);
  });
});

describe('calculateMotmRankings tiebreak chain', () => {
  const entrant = (name: string, gameweeks: any[]) => ({ name, team: name, entryId: name.length, gameweeks });

  it('ranks by net score first', () => {
    const res = calculateMotmRankings(
      [entrant('Alice', [gwRow(1, 50, 0, 0)]), entrant('Bob', [gwRow(1, 60, 2, 8)])],
      1,
      [1],
    );
    // Bob gross 60 - 8 hit = 52 net beats Alice 50
    expect(res.rankings[0].name).toBe('Bob');
  });

  it('breaks a net tie by FEWEST transfers (opposite of the loser rule)', () => {
    const res = calculateMotmRankings(
      [entrant('Alice', [gwRow(1, 50, 3)]), entrant('Bob', [gwRow(1, 50, 1)])],
      1,
      [1],
    );
    expect(res.rankings[0].name).toBe('Bob');
  });

  it('then by highest single gameweek', () => {
    const res = calculateMotmRankings(
      [
        entrant('Alice', [gwRow(1, 30, 1), gwRow(2, 30, 1)]),
        entrant('Bob', [gwRow(1, 45, 1), gwRow(2, 15, 1)]),
      ],
      1,
      [1, 2],
    );
    expect(res.rankings[0].name).toBe('Bob');
  });

  it('then by the coin flip, stable across calls', () => {
    dataCache.coinFlips.motm['1'] = { Alice: 0.9, Bob: 0.1 } as any;
    const managers = [entrant('Alice', [gwRow(1, 50, 1)]), entrant('Bob', [gwRow(1, 50, 1)])];
    // Higher flip value ranks first for MotM.
    expect(calculateMotmRankings(managers, 1, [1]).rankings[0].name).toBe('Alice');
    expect(calculateMotmRankings(managers, 1, [1]).rankings[0].name).toBe('Alice');
  });

  it('marks a period incomplete until every GW is in', () => {
    const res = calculateMotmRankings([entrant('Alice', [gwRow(1, 50)])], 1, [1]);
    expect(res.periodComplete).toBe(false); // period 1 covers GW1-5
  });
});

describe('foldPlan with chips', () => {
  const players = new Map<number, PlannerPlayer>();
  // 15-man squad ids 1..15 plus transfer targets 100..102, all distinct clubs
  const mk = (id: number, type: number, team: number, cost = 50): PlannerPlayer => ({
    id,
    web_name: `P${id}`,
    team,
    element_type: type,
    now_cost: cost,
  });
  [
    mk(1, 1, 1), mk(2, 1, 2),
    mk(3, 2, 3), mk(4, 2, 4), mk(5, 2, 5), mk(6, 2, 6), mk(7, 2, 7),
    mk(8, 3, 8), mk(9, 3, 9), mk(10, 3, 10), mk(11, 3, 11), mk(12, 3, 12),
    mk(13, 4, 13), mk(14, 4, 14), mk(15, 4, 15),
    mk(100, 4, 16), mk(101, 4, 17), mk(102, 3, 18),
  ].forEach((p) => players.set(p.id, p));

  const base = {
    squad: Array.from({ length: 15 }, (_, i) => ({ element: i + 1, purchasePrice: 50, sellingPrice: 50 })),
    bank: 10,
    freeTransfers: 1,
    baseGw: 10,
  };

  it('wildcard week: unlimited free transfers, no hit, FT bank still accrues', () => {
    const plan = {
      version: 1 as const,
      entryId: 1,
      season: '2025-26',
      baseGw: 10,
      baseSquadHash: 'x',
      updatedAt: 0,
      weeks: {
        '11': { transfers: [{ out: 13, in: 100 }, { out: 14, in: 101 }, { out: 12, in: 102 }], chip: 'wildcard' },
        '12': { transfers: [] },
      },
    };
    const [wcWeek, after] = foldPlan(base, plan, players, 12);
    expect(wcWeek.hits).toBe(0);
    expect(wcWeek.used).toBe(3);
    // Entering GW12: the wildcard didn't consume the banked FT → 1 + 1 = 2
    expect(after.freeTransfers).toBe(2);
  });

  it('bench boost / triple captain do NOT make transfers free', () => {
    expect(hitCost(1, 3, false)).toBe(8);
    // Chip-active flag only applies to wildcard/freehit at the call sites;
    // the raw helper treats chipActive=true as free — assert the planner's
    // wiring by folding a bboost week with 2 transfers and 1 FT.
    const plan = {
      version: 1 as const,
      entryId: 1,
      season: '2025-26',
      baseGw: 10,
      baseSquadHash: 'x',
      updatedAt: 0,
      weeks: { '11': { transfers: [{ out: 13, in: 100 }, { out: 14, in: 101 }], chip: 'bboost' } },
    };
    const [week] = foldPlan(base, plan, players, 11);
    expect(week.hits).toBe(4); // 2 used, 1 free → one -4 hit despite the chip
  });

  it('banks free transfers up to five', () => {
    expect(freeTransfersAfter(5, 0)).toBe(5);
    expect(freeTransfersAfter(4, 0)).toBe(5);
    expect(freeTransfersAfter(2, 1)).toBe(2);
  });

  it('flags a captain who is no longer in the squad after transfers', () => {
    const plan = {
      version: 1 as const,
      entryId: 1,
      season: '2025-26',
      baseGw: 10,
      baseSquadHash: 'x',
      updatedAt: 0,
      weeks: { '11': { transfers: [{ out: 13, in: 100 }], captain: 13 } },
    };
    const [week] = foldPlan(base, plan, players, 11);
    expect(week.errors.join(' ')).toContain('Captain is not in this week');
  });
});
