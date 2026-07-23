import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { fetchH2HComparison } from '../src/server/services/h2h';
import { dataCache } from '../src/server/data-cache';

beforeEach(() => {
    dataCache.managerProfiles = {
        1: { entryId: 1, name: 'Barry', team: 'Team B', history: [{ gw: 1, rank: 2 }, { gw: 2, rank: 1 }] },
        2: { entryId: 2, name: 'Grant', team: 'Team G', history: [{ gw: 1, rank: 1 }, { gw: 2, rank: 2 }] },
    } as any;
    dataCache.weekHistoryCache = {
        1: { managers: [
            { entryId: 1, gwScore: 50, benchPoints: 3, captainName: 'Salah', captainPoints: 12, activeChip: null, transferCost: 0, transfers: 1, overallPoints: 50 },
            { entryId: 2, gwScore: 60, benchPoints: 5, captainName: 'Salah', captainPoints: 12, activeChip: 'wildcard', transferCost: 0, transfers: 0, overallPoints: 60 },
        ] },
        2: { managers: [
            { entryId: 1, gwScore: 70, benchPoints: 2, captainName: 'Haaland', captainPoints: 20, activeChip: '3xc', transferCost: 4, transfers: 2, overallPoints: 120 },
            { entryId: 2, gwScore: 40, benchPoints: 1, captainName: 'Palmer', captainPoints: 8, activeChip: null, transferCost: 0, transfers: 1, overallPoints: 100 },
        ] },
    } as any;
});

describe('fetchH2HComparison (static from caches)', () => {
    it('returns an error when a profile is missing', async () => {
        const res = await fetchH2HComparison(1, 999);
        expect(res.error).toBeTruthy();
    });

    it('computes the head-to-head record from stored per-GW scores', async () => {
        const res = await fetchH2HComparison(1, 2);
        // GW1: 50 vs 60 → Grant; GW2: 70 vs 40 → Barry ⇒ 1-1
        expect(res.headToHead).toEqual({ m1Wins: 1, m2Wins: 1, draws: 0 });
        expect(res.gwComparison).toHaveLength(2);
        expect(res.gwComparison[1]).toMatchObject({ gw: 2, m1Cumulative: 120, m2Cumulative: 100 });
    });

    it('totals captain points and same-captain count from stored captains', async () => {
        const res = await fetchH2HComparison(1, 2);
        expect(res.captains.m1Total).toBe(32); // 12 + 20
        expect(res.captains.m2Total).toBe(20); // 12 + 8
        expect(res.captains.sameCaptainCount).toBe(1); // GW1 both Salah
    });

    it('reconstructs chip usage from each GW activeChip (GW1-19 = first half)', async () => {
        const res = await fetchH2HComparison(1, 2);
        expect(res.chips.m1.firstHalf['3xc']).toMatchObject({ status: 'used', gw: 2 });
        expect(res.chips.m2.firstHalf.wildcard).toMatchObject({ status: 'used', gw: 1 });
    });

    it('sums transfers and totals, and derives best/worst from stored scores', async () => {
        const res = await fetchH2HComparison(1, 2);
        expect(res.transfers.m1).toEqual({ total: 3, cost: 4 });
        expect(res.totals).toEqual({ m1: 120, m2: 100 });
        expect(res.bestGW.m1).toEqual({ points: 70, gw: 2 });
        expect(res.worstGW.m1).toEqual({ points: 50, gw: 1 });
        expect(res.rankHistory.m1).toHaveLength(2);
    });
});
