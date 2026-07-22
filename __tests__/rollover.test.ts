import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
    const calls: string[] = [];
    return {
        calls,
        redisConfigured: vi.fn(() => true),
        getCurrentSeason: vi.fn(() => '2025-26'),
        setCurrentSeason: vi.fn(async (s: string) => {
            calls.push(`flip:${s}`);
            return true;
        }),
        archiveCurrentSeason: vi.fn(async () => {
            calls.push('archive');
            return { success: true, season: '2025-26' };
        }),
        resetDataCacheForNewSeason: vi.fn(() => calls.push('reset')),
        saveDataCache: vi.fn(async () => {
            calls.push('saveDataCache');
        }),
        saveCoinFlips: vi.fn(async () => {
            calls.push('saveCoinFlips');
        }),
        invalidateAllRawCaches: vi.fn(() => calls.push('invalidateRaw')),
        trafficInit: vi.fn(async () => {
            calls.push('traffic');
        }),
        refreshAllData: vi.fn(async () => {
            calls.push('refresh');
            return { success: true };
        }),
        rebuildStatus: { inProgress: false },
        archivedSeasons: {} as Record<string, unknown>,
    };
});

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    redisConfigured: mocks.redisConfigured,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: mocks.getCurrentSeason,
    setCurrentSeason: mocks.setCurrentSeason,
}));
vi.mock('../src/server/data-cache', () => ({
    archivedSeasons: mocks.archivedSeasons,
    archiveCurrentSeason: mocks.archiveCurrentSeason,
    rebuildStatus: mocks.rebuildStatus,
    resetDataCacheForNewSeason: mocks.resetDataCacheForNewSeason,
    saveDataCache: mocks.saveDataCache,
    saveCoinFlips: mocks.saveCoinFlips,
}));
vi.mock('../src/server/fpl/client', () => ({
    invalidateAllRawCaches: mocks.invalidateAllRawCaches,
}));
vi.mock('../src/server/traffic', () => ({
    init: mocks.trafficInit,
}));
vi.mock('../src/server/services/refresh', () => ({
    refreshAllData: mocks.refreshAllData,
}));

import { rolloverSeason } from '../src/server/services/rollover';

beforeEach(() => {
    mocks.calls.length = 0;
    mocks.rebuildStatus.inProgress = false;
    for (const k of Object.keys(mocks.archivedSeasons)) delete mocks.archivedSeasons[k];
    delete (globalThis as Record<string, unknown>).__fplRolloverInFlight;
    mocks.redisConfigured.mockReturnValue(true);
    mocks.getCurrentSeason.mockReturnValue('2025-26');
    mocks.setCurrentSeason.mockClear().mockImplementation(async (s: string) => {
        mocks.calls.push(`flip:${s}`);
        return true;
    });
    mocks.archiveCurrentSeason.mockClear().mockImplementation(async () => {
        mocks.calls.push('archive');
        return { success: true, season: '2025-26' };
    });
    mocks.resetDataCacheForNewSeason.mockClear();
    mocks.refreshAllData.mockClear();
});

// '2099-00' has a valid format but no entry in SEASONS; '2025-26' always has one.
// Rollover targets need an entry, so tests flip 2026-27... which doesn't exist
// either — we validate against the real season-config, so tests that need a
// *valid* target flip TO '2025-26' from a pretend current season.
describe('rolloverSeason guards', () => {
    it('rejects a malformed season id', async () => {
        const r = await rolloverSeason('26-27');
        expect(r.success).toBe(false);
        expect(r.error).toContain('YYYY-YY');
    });

    it('is a safe no-op when already on the target season', async () => {
        const r = await rolloverSeason('2025-26');
        expect(r).toMatchObject({ success: true, noop: true });
        expect(mocks.calls).toEqual([]);
    });

    it('refuses a season with no config entry', async () => {
        const r = await rolloverSeason('2099-00');
        expect(r.success).toBe(false);
        expect(r.error).toContain('season-config');
        expect(mocks.calls).toEqual([]);
    });

    it('refuses without Redis', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        mocks.redisConfigured.mockReturnValue(false);
        const r = await rolloverSeason('2025-26');
        expect(r.success).toBe(false);
        expect(r.error).toContain('Redis');
    });

    it('refuses while a rebuild is running', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        mocks.rebuildStatus.inProgress = true;
        const r = await rolloverSeason('2025-26');
        expect(r.success).toBe(false);
        expect(r.error).toContain('rebuild');
    });
});

describe('rolloverSeason sequence', () => {
    it('archives, flips, resets, persists — in that order', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        const r = await rolloverSeason('2025-26');
        expect(r).toMatchObject({ success: true, archived: '2024-25', newSeason: '2025-26' });
        const order = mocks.calls;
        expect(order.indexOf('archive')).toBeLessThan(order.indexOf('flip:2025-26'));
        expect(order.indexOf('flip:2025-26')).toBeLessThan(order.indexOf('reset'));
        expect(order.indexOf('reset')).toBeLessThan(order.indexOf('saveDataCache'));
        expect(order).toContain('invalidateRaw');
        expect(order).toContain('traffic');
    });

    it('aborts before the flip when the snapshot fails', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        mocks.archiveCurrentSeason.mockResolvedValue({ success: false, error: 'redis down' });
        const r = await rolloverSeason('2025-26');
        expect(r.success).toBe(false);
        expect(r.error).toContain('redis down');
        expect(mocks.setCurrentSeason).not.toHaveBeenCalled();
        expect(mocks.resetDataCacheForNewSeason).not.toHaveBeenCalled();
    });

    it('aborts without touching caches when the pointer write fails', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        mocks.setCurrentSeason.mockResolvedValue(false);
        const r = await rolloverSeason('2025-26');
        expect(r.success).toBe(false);
        expect(mocks.resetDataCacheForNewSeason).not.toHaveBeenCalled();
    });

    it('skipSnapshot requires an existing archive', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        const refused = await rolloverSeason('2025-26', { skipSnapshot: true });
        expect(refused.success).toBe(false);
        expect(refused.error).toContain('existing');

        mocks.archivedSeasons['2024-25'] = { season: '2024-25' };
        const r = await rolloverSeason('2025-26', { skipSnapshot: true });
        expect(r.success).toBe(true);
        expect(mocks.archiveCurrentSeason).not.toHaveBeenCalled();
    });

    it('kicks off a background refresh on success', async () => {
        mocks.getCurrentSeason.mockReturnValue('2024-25');
        await rolloverSeason('2025-26');
        expect(mocks.refreshAllData).toHaveBeenCalledWith('season-rollover');
    });
});
