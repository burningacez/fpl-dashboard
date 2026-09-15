import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetchBootstrap: vi.fn(async () => { throw new Error('must not fetch the live API for a concluded past GW'); }),
}));

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
    sanitizeCachedNames: (x: any) => x,
    fetchBootstrap: mocks.fetchBootstrap,
    fetchFixtures: vi.fn(async () => []),
    getCompletedGameweeks: vi.fn(() => []),
    fetchLiveGWData: vi.fn(async () => ({ elements: [] })),
    fetchManagerPicks: vi.fn(async () => ({ picks: [] })),
}));

import { calculateTinkeringImpact } from '../src/server/services/tinkering';
import { dataCache } from '../src/server/data-cache';

beforeEach(() => {
    mocks.fetchBootstrap.mockClear();
    dataCache.tinkeringCache = {};
    dataCache.weekHistoryCache = {};
    dataCache.week = { currentGW: 38 };
});

describe('calculateTinkeringImpact — concluded past GW with no stored ledger', () => {
    it('degrades gracefully when the live API can no longer serve that week', async () => {
        // The bootstrap mock throws, standing in for the API having reset to a
        // new season: a settled week degrades rather than erroring.
        const res = await calculateTinkeringImpact(101, 10); // past GW, not cached
        expect(res.available).toBe(false);
        expect(res.reason).toBe('unavailable');
        expect(res.navigation).toMatchObject({ currentGW: 10, maxGW: 38, hasNext: true });
    });

    it('degrades when the live API has moved on to a season that never played that GW', async () => {
        mocks.fetchBootstrap.mockImplementationOnce(async () => ({
            // Reset API: GW10 exists but is unplayed, and the season is on GW2.
            events: [{ id: 2, is_current: true }, { id: 10, finished: false }],
            elements: [],
            teams: [],
        }));
        const res = await calculateTinkeringImpact(101, 10);
        expect(res.available).toBe(false);
        expect(res.reason).toBe('unavailable');
    });

    it('rebuilds a past GW of the season that is still live', async () => {
        mocks.fetchBootstrap.mockImplementationOnce(async () => ({
            events: [{ id: 10, finished: true }, { id: 20, is_current: true }],
            elements: [],
            teams: [],
        }));
        const res = await calculateTinkeringImpact(101, 10);
        // Empty squads, but the point is that it computed rather than degrading.
        expect(res.available).toBe(true);
        expect(mocks.fetchBootstrap).toHaveBeenCalled();
    });

    it('serves a cached ledger statically (no live fetch) with fresh navigation', async () => {
        dataCache.tinkeringCache = { '101-10': { available: true, payloadVersion: 2, netImpact: 5 } };
        const res = await calculateTinkeringImpact(101, 10);
        expect(res.available).toBe(true);
        expect(res.netImpact).toBe(5);
        expect(res.navigation.maxGW).toBe(38);
        expect(mocks.fetchBootstrap).not.toHaveBeenCalled();
    });
});
