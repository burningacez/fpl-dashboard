import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ leagueThrows: false }));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async () => null),
    redisSet: vi.fn(async () => true),
    redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => '2025-26',
    getActiveSeasonConfig: () => ({ leagueId: 619028 }),
    getLeagueId: () => 619028,
}));
vi.mock('../src/server/fpl/client', () => ({
    // Any call here means we hit the API for a completed week — which we must not.
    fetchLeagueData: vi.fn(async () => {
        if (mocks.leagueThrows) throw new Error('should not fetch for a materialised GW');
        return { league: { name: 'Si and chums' }, standings: { results: [] } };
    }),
    fetchManagerHistory: vi.fn(async () => ({ current: [] })),
}));

import { fetchStandingsAsOfGW } from '../src/server/services/standings-history';
import { dataCache } from '../src/server/data-cache';
import { bakeOverallTotals } from '../src/lib/overall-totals';

beforeEach(() => {
    mocks.leagueThrows = false;
    dataCache.league = { league: { name: 'Si and chums' } };
    // Two completed GWs, materialised with static totals.
    dataCache.weekHistoryCache = {
        1: { managers: [
            { entryId: 1, name: 'Barry', team: 'Team B', gwScore: 50, transferCost: 0, transfers: 0, teamValue: '100.0' },
            { entryId: 2, name: 'Grant', team: 'Team G', gwScore: 60, transferCost: 0, transfers: 0, teamValue: '100.0' },
        ] },
        2: { managers: [
            { entryId: 1, name: 'Barry', team: 'Team B', gwScore: 70, transferCost: 4, transfers: 2, teamValue: '101.2' },
            { entryId: 2, name: 'Grant', team: 'Team G', gwScore: 40, transferCost: 0, transfers: 0, teamValue: '100.5' },
        ] },
    };
    bakeOverallTotals(dataCache.weekHistoryCache);
    // Clear the 60s memo between tests.
    delete (dataCache as any).standingsHistory_1;
    delete (dataCache as any).standingsHistory_2;
});

describe('fetchStandingsAsOfGW (static from cache)', () => {
    it('builds standings from the materialised cache without any FPL fetch', async () => {
        mocks.leagueThrows = true; // fail loudly if the live path runs
        const res = await fetchStandingsAsOfGW(2);
        const byId = new Map(res.standings.map((s) => [s.entryId, s]));
        // Barry: net 120, cost 4 → gross 124, transfers 2, value 101.2, rank 1
        expect(byId.get(1)).toMatchObject({ netScore: 120, grossScore: 124, totalTransfers: 2, teamValue: '101.2', rank: 1 });
        // Grant: net 100, cost 0 → gross 100, rank 2
        expect(byId.get(2)).toMatchObject({ netScore: 100, grossScore: 100, rank: 2 });
    });

    it('sets rank movement from the prior GW baked ranks', async () => {
        const res = await fetchStandingsAsOfGW(2);
        const byId = new Map(res.standings.map((s) => [s.entryId, s]));
        // Grant led GW1 (rank 1) then dropped to rank 2 → movement -1;
        // Barry rose from 2 to 1 → movement +1.
        expect(byId.get(1)!.movement).toBe(1);
        expect(byId.get(2)!.movement).toBe(-1);
    });

    it('falls back to the live computation for a GW not in the cache', async () => {
        const client: any = await import('../src/server/fpl/client');
        const res = await fetchStandingsAsOfGW(5); // not materialised
        expect(res.asOfGW).toBe(5);
        expect(client.fetchLeagueData).toHaveBeenCalled();
    });
});
