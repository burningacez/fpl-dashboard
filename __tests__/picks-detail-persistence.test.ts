import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ store: new Map<string, unknown>(), writes: [] as string[] }));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async (k: string) => mocks.store.get(k) ?? null),
    redisSet: vi.fn(async (k: string, v: unknown) => {
        mocks.store.set(k, JSON.parse(JSON.stringify(v)));
        mocks.writes.push(k);
        return true;
    }),
    // savePicksDetail serialises once so it can hash the payload and skip
    // unchanged chunks, so it writes through redisSetRaw rather than redisSet.
    redisSetRaw: vi.fn(async (k: string, json: string) => {
        mocks.store.set(k, JSON.parse(json));
        mocks.writes.push(k);
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
    mocks.writes.length = 0;
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

    // Every write leaves the box as an HTTP body Render bills as outbound
    // bandwidth, and a concluded gameweek's picks never change — so re-saving
    // must not re-send the gameweeks that already match what we wrote.
    it('re-writes only the gameweek chunks whose content changed', async () => {
        dataCache.processedPicksCache = {
            '1-11': { entryId: 1, gameweek: 11, players: [] },
            '1-12': { entryId: 1, gameweek: 12, players: [] },
        };

        await savePicksDetail();
        expect(mocks.writes).toContain('season-2025-26:picks:gw11');
        expect(mocks.writes).toContain('season-2025-26:picks:gw12');

        // Nothing changed: no chunk should go out a second time.
        mocks.writes.length = 0;
        await savePicksDetail();
        expect(mocks.writes).toHaveLength(0);

        // Touch GW12 only — GW11 must stay unsent, GW12 must be re-sent.
        mocks.writes.length = 0;
        dataCache.processedPicksCache['1-12'] = { entryId: 1, gameweek: 12, players: [{ id: 7 }] };
        await savePicksDetail();
        expect(mocks.writes).toContain('season-2025-26:picks:gw12');
        expect(mocks.writes).not.toContain('season-2025-26:picks:gw11');
        expect(mocks.store.get('season-2025-26:picks:gw12')).toEqual({
            '1-12': { entryId: 1, gameweek: 12, players: [{ id: 7 }] },
        });

        // A new gameweek is always a new chunk, and it shifts the index.
        mocks.writes.length = 0;
        dataCache.processedPicksCache['1-13'] = { entryId: 1, gameweek: 13, players: [] };
        await savePicksDetail();
        expect(mocks.writes).toContain('season-2025-26:picks:gw13');
        expect(mocks.writes).toContain('season-2025-26:picks-index');
        expect(mocks.writes).not.toContain('season-2025-26:picks:gw11');
        expect(mocks.store.get('season-2025-26:picks-index')).toEqual([11, 12, 13]);
    });
});
