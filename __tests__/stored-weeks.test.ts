/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The stored week rows are the one record of a completed gameweek's scores.
 * ensureStoredWeeks writes them; standings (and every other season-long view)
 * read them instead of FPL's own history totals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/server/redis', () => ({
  redisGet: vi.fn(async () => null),
  redisSet: vi.fn(async () => true),
  redisConfigured: () => false,
}));

vi.mock('../src/server/season-state', () => ({
  getCurrentSeason: () => '2026-27',
  getActiveSeasonConfig: () => ({ id: '2026-27', leagueId: 1, attackingTiebreakers: false }),
  getLeagueId: () => 1,
}));

const fpl = vi.hoisted(() => ({
  completedGWs: [] as number[],
  currentGW: 1,
  live: false,
  picksCalls: [] as string[],
  // `${entry}-${gw}` → points, or an error status to throw
  picks: {} as Record<string, number | { status: number }>,
  livePoints: {} as Record<number, { points: number; hit: number; value: number }>,
}));

const managers = [
  { entry: 1, player_name: 'Cam', entry_name: 'Cam FC', rank: 1, total: 0 },
  { entry: 2, player_name: 'Dee', entry_name: 'Dee FC', rank: 2, total: 0 },
];

vi.mock('../src/server/fpl/client', () => ({
  fetchLeagueData: async () => ({ league: { name: 'Test League' }, standings: { results: managers } }),
  fetchBootstrap: async () => ({
    events: [{ id: fpl.currentGW, is_current: true, finished: !fpl.live, deadline_time: '2026-08-15T17:30:00Z' }],
    elements: [],
    teams: [],
  }),
  fetchFixtures: async () => [],
  fetchLiveGWData: async () => ({ elements: [] }),
  fetchManagerPicks: async (entry: number) => ({
    picks: [],
    entry_history: {
      event_transfers_cost: fpl.livePoints[entry]?.hit ?? 0,
      event_transfers: 0,
      value: fpl.livePoints[entry]?.value ?? 1000,
    },
  }),
  getCompletedGameweeks: () => fpl.completedGWs,
}));

vi.mock('../src/server/services/picks', () => ({
  fetchManagerPicksDetailed: async (entry: number, gw: number) => {
    fpl.picksCalls.push(`${entry}-${gw}`);
    const p = fpl.picks[`${entry}-${gw}`];
    if (typeof p === 'object') throw Object.assign(new Error(`HTTP ${p.status}`), { status: p.status });
    return { calculatedPoints: p ?? 0, totalProvisionalBonus: 0, transfersCost: 0, transfers: 0, teamValue: '100.0', players: [] };
  },
}));

vi.mock('../src/server/services/scoring', () => ({
  calculatePointsWithAutoSubs: (picks: any) => ({
    totalPoints: fpl.livePoints[managers.find((m) => picks.entry_history.value === (fpl.livePoints[m.entry]?.value ?? 1000))!.entry]?.points ?? 0,
  }),
}));

import { ensureStoredWeeks } from '../src/server/services/stored-weeks';
import { fetchStandingsWithTransfers } from '../src/server/services/standings';
import { dataCache } from '../src/server/data-cache';

const rowFor = (gw: number, entry: number) =>
  dataCache.weekHistoryCache[gw]?.managers.find((m: any) => m.entryId === entry);

beforeEach(() => {
  dataCache.processedPicksCache = {};
  dataCache.weekHistoryCache = {};
  dataCache.coinFlips = { motm: {}, losers: {}, standings: {} } as any;
  dataCache.losers = null;
  dataCache.motm = null;
  fpl.completedGWs = [];
  fpl.currentGW = 1;
  fpl.live = false;
  fpl.picksCalls = [];
  fpl.picks = {};
  fpl.livePoints = {};
});

describe('ensureStoredWeeks', () => {
  it('stores every completed gameweek and fetches nothing once stored', async () => {
    fpl.completedGWs = [1, 2];
    fpl.picks = { '1-1': 60, '2-1': 50, '1-2': 70, '2-2': 40 };

    await ensureStoredWeeks();
    expect(rowFor(1, 1).gwScore).toBe(60);
    expect(rowFor(2, 2).gwScore).toBe(40);
    expect(rowFor(2, 1).overallPoints).toBe(130);

    fpl.picksCalls = [];
    await ensureStoredWeeks();
    expect(fpl.picksCalls).toEqual([]);
  });

  it('records a manager with no team that week and does not refetch them', async () => {
    fpl.completedGWs = [1];
    fpl.picks = { '1-1': 60, '2-1': { status: 404 } };

    await ensureStoredWeeks();
    expect(dataCache.weekHistoryCache[1].noEntry).toEqual([2]);
    expect(dataCache.weekHistoryCache[1].managers).toHaveLength(1);

    fpl.picksCalls = [];
    await ensureStoredWeeks();
    expect(fpl.picksCalls).toEqual([]);
  });

  it('rebuilds a gameweek whose picks were invalidated', async () => {
    fpl.completedGWs = [1];
    fpl.picks = { '1-1': 60, '2-1': 50 };
    await ensureStoredWeeks();

    // FPL's late bonus lands; the refresh drops the GW's picks.
    fpl.picks['1-1'] = 63;
    delete dataCache.processedPicksCache['1-1'];
    await ensureStoredWeeks();
    expect(rowFor(1, 1).gwScore).toBe(63);
  });

  it('fails, keeping the last stored rows, when picks cannot be fetched', async () => {
    fpl.completedGWs = [1];
    fpl.picks = { '1-1': 60, '2-1': 50 };
    await ensureStoredWeeks();

    delete dataCache.processedPicksCache['2-1'];
    fpl.picks['2-1'] = { status: 503 };
    await expect(ensureStoredWeeks()).rejects.toThrow(/incomplete/);
    expect(rowFor(1, 2).gwScore).toBe(50);
  });
});

describe('fetchStandingsWithTransfers', () => {
  it('totals completed gameweeks from the stored rows, net of hits', async () => {
    fpl.completedGWs = [1, 2];
    fpl.currentGW = 2;
    fpl.picks = { '1-1': 60, '2-1': 50, '1-2': 70, '2-2': 40 };
    await ensureStoredWeeks();
    // A -4 in GW2 for Cam, as the stored row records it (keys are entry-GW).
    dataCache.processedPicksCache['1-2'] = { ...dataCache.processedPicksCache['1-2'], transfersCost: 4, transfers: 2 };

    const { standings } = await fetchStandingsWithTransfers();
    const cam = standings.find((s: any) => s.entryId === 1);
    const dee = standings.find((s: any) => s.entryId === 2);
    expect(cam).toMatchObject({ netScore: 126, transferCost: 4, grossScore: 130, totalTransfers: 2, prevNetScore: 60, highestGW: 66, lowestGW: 60 });
    expect(dee).toMatchObject({ netScore: 90, prevNetScore: 50 });
    expect(standings.map((s: any) => s.name)).toEqual(['Cam', 'Dee']);
  });

  it('adds the in-progress gameweek live, net of its hit', async () => {
    fpl.completedGWs = [1];
    fpl.currentGW = 2;
    fpl.live = true;
    fpl.picks = { '1-1': 60, '2-1': 70 };
    fpl.livePoints = { 1: { points: 30, hit: 4, value: 1001 }, 2: { points: 10, hit: 0, value: 1002 } };

    const { standings } = await fetchStandingsWithTransfers();
    const cam = standings.find((s: any) => s.entryId === 1);
    expect(cam).toMatchObject({ netScore: 86, prevNetScore: 60, teamValue: '100.1', lowestGW: 60 });
  });
});
