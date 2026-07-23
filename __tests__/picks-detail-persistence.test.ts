import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async (k: string) => mocks.store.get(k) ?? null),
    redisSet: vi.fn(async (k: string, v: unknown) => {
        mocks.store.set(k, JSON.parse(JSON.stringify(v)));
        return true;
    }),
    redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => '2025-26',
    getActiveSeasonConfig: () => ({ leagueId: 619028 }),
    getLeagueId: () => 619028,
}));

import { dataCache, savePicksDetail, loadPicksDetail } from '../src/server/data-cache';

beforeEach(() => {
    mocks.store.clear();
    dataCache.processedPicksCache = {};
    dataCache.tinkeringCache = {};
    dataCache.fixtureStatsCache = {};
});

describe('savePicksDetail / loadPicksDetail', () => {
    it('round-trips processed picks (chunked per GW), tinkering and fixture stats', async () => {
        dataCache.processedPicksCache = {
            '1-5': { entryId: 1, gameweek: 5, players: [{ id: 10, name: 'Salah' }] },
            '2-5': { entryId: 2, gameweek: 5, players: [] },
            '1-6': { entryId: 1, gameweek: 6, players: [] },
        };
        dataCache.tinkeringCache = { '1-5': { available: true, netImpact: 3 } };
        dataCache.fixtureStatsCache = { 100: { finished: true, players: [] } };

        await savePicksDetail();

        // Picks are chunked per GW with an index; keys are season-scoped.
        expect(mocks.store.has('season-2025-26:picks:gw5')).toBe(true);
        expect(mocks.store.has('season-2025-26:picks:gw6')).toBe(true);
        expect(mocks.store.get('season-2025-26:picks-index')).toEqual([5, 6]);

        // Wipe memory (simulating a restart) and reload from Redis.
        dataCache.processedPicksCache = {};
        dataCache.tinkeringCache = {};
        dataCache.fixtureStatsCache = {};
        await loadPicksDetail();

        expect(dataCache.processedPicksCache['1-5'].players[0].name).toBe('Salah');
        expect(dataCache.processedPicksCache['2-5']).toBeTruthy();
        expect(dataCache.processedPicksCache['1-6']).toBeTruthy();
        expect(dataCache.tinkeringCache['1-5'].netImpact).toBe(3);
        expect(dataCache.fixtureStatsCache[100].finished).toBe(true);
    });

    it('loads nothing when the season has no persisted detail', async () => {
        await loadPicksDetail();
        expect(Object.keys(dataCache.processedPicksCache)).toHaveLength(0);
    });
});
