import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    store: new Map<string, unknown>(),
    setCalls: [] as string[],
    currentSeason: { value: '2025-26' },
}));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
    redisSet: vi.fn(async (key: string, value: unknown) => {
        mocks.setCalls.push(key);
        mocks.store.set(key, JSON.parse(JSON.stringify(value)));
        return true;
    }),
    redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => mocks.currentSeason.value,
    getActiveSeasonConfig: () => ({ leagueId: 619028 }),
    getLeagueId: () => 619028,
}));

import {
    dataCache,
    archivedSeasons,
    archiveCurrentSeason,
    loadArchivedSeasons,
    loadDataCache,
    saveDataCache,
    resetDataCacheForNewSeason,
} from '../src/server/data-cache';

beforeEach(() => {
    mocks.store.clear();
    mocks.setCalls.length = 0;
    mocks.currentSeason.value = '2025-26';
    for (const k of Object.keys(archivedSeasons)) delete archivedSeasons[k];
    resetDataCacheForNewSeason();
});

function seedSeason() {
    dataCache.standings = { standings: [{ entryId: 1, name: 'Barry Evans', team: 'Team B', rank: 1, netScore: 2000 }] };
    dataCache.league = { league: { name: 'Si and chums' } };
    dataCache.losers = { losers: [] };
    dataCache.motm = { periods: {} };
    dataCache.cup = { cupStarted: true, rounds: [] };
    dataCache.analytics = { managers: [] };
    dataCache.weekHistoryCache = {
        1: { viewingGW: 1, managers: [] },
        38: { viewingGW: 38, managers: [] },
    };
}

describe('archiveCurrentSeason (widened snapshot)', () => {
    it('writes the weeks sidecar before the main blob and registers the season', async () => {
        seedSeason();
        const result = await archiveCurrentSeason();
        expect(result).toMatchObject({ success: true, season: '2025-26' });

        expect(mocks.setCalls.indexOf('season-2025-26:weeks')).toBeLessThan(
            mocks.setCalls.indexOf('season-2025-26'),
        );
        expect(mocks.store.get('archived-seasons-list')).toEqual(['2025-26']);

        const blob = mocks.store.get('season-2025-26') as Record<string, unknown>;
        expect(blob.season).toBe('2025-26');
        expect(blob.finalGW).toBe(38);
        expect(blob.cup).toEqual({ cupStarted: true, rounds: [] });
        expect(blob.analytics).toEqual({ managers: [] });
        expect((blob.seasonConfig as { id: string }).id).toBe('2025-26');
        expect((blob.members as unknown[]).length).toBe(1);
        // week history stays out of the main blob
        expect(blob.weekHistory).toBeUndefined();
        expect(blob.weekHistoryCache).toBeUndefined();

        // and the in-memory archive is immediately servable, weeks included
        expect(archivedSeasons['2025-26'].weekHistory[38]).toBeTruthy();
    });

    it('skips the weeks key when there is no week history', async () => {
        seedSeason();
        dataCache.weekHistoryCache = {};
        const result = await archiveCurrentSeason();
        expect(result.success).toBe(true);
        expect(mocks.store.has('season-2025-26:weeks')).toBe(false);
        expect((mocks.store.get('season-2025-26') as Record<string, unknown>).finalGW).toBeNull();
    });
});

describe('loadArchivedSeasons', () => {
    it('attaches the weeks sidecar when present and degrades when absent', async () => {
        mocks.store.set('archived-seasons-list', ['2025-26', '2024-25']);
        mocks.store.set('season-2025-26', { season: '2025-26', standings: {} });
        mocks.store.set('season-2025-26:weeks', { 7: { viewingGW: 7 } });
        mocks.store.set('season-2024-25', { season: '2024-25', standings: {} }); // legacy blob, no weeks

        await loadArchivedSeasons();
        expect(archivedSeasons['2025-26'].weekHistory[7].viewingGW).toBe(7);
        expect(archivedSeasons['2024-25'].weekHistory).toBeUndefined();
    });
});

describe('loadDataCache season stamp', () => {
    it('persists the active season and reloads its own blob', async () => {
        seedSeason();
        await saveDataCache();
        resetDataCacheForNewSeason();
        expect(await loadDataCache()).toBe(true);
        expect(dataCache.standings).toBeTruthy();
    });

    it('discards a blob stamped with a different season', async () => {
        seedSeason();
        await saveDataCache(); // stamped 2025-26
        mocks.currentSeason.value = '2026-27';
        resetDataCacheForNewSeason();
        expect(await loadDataCache()).toBe(false);
        expect(dataCache.standings).toBeNull();
    });

    it('treats an unstamped legacy blob as current', async () => {
        mocks.store.set('data-cache', { standings: { standings: [] }, lastRefresh: 'x' });
        expect(await loadDataCache()).toBe(true);
        expect(dataCache.standings).toBeTruthy();
    });
});
